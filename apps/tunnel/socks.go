package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"sync"
	"time"
)

// SOCKS5, which is the seam.
//
// The three database drivers all speak SOCKS5 — mongodb via proxyHost, pg via
// its stream factory, tedious via options.connector — and all three hand the
// proxy a HOSTNAME rather than an address they resolved (atyp=3 on every dial).
// So the proxy is where a name inside the customer's network gets resolved, and
// therefore where it must be judged.
//
// This process does not judge it. Every CONNECT asks the api for a verdict and
// waits: the api resolves through this tunnel's own resolver, applies the same
// FORBIDDEN tier and AllowedIPs containment the direct path applies, and answers
// with an address or a refusal. That costs two pipe round trips per CONNECTION —
// not per packet — and buys the thing that matters: one implementation of the
// rule, in the file an auditor already reads.

const (
	socksVersion = 0x05
	authVersion  = 0x01

	methodUserPass = 0x02
	methodNone     = 0xFF

	commandConnect = 0x01

	atypIPv4   = 0x01
	atypDomain = 0x03
	atypIPv6   = 0x04

	replySuccess             = 0x00
	replyGeneralFailure      = 0x01
	replyNotAllowed          = 0x02
	replyRefused             = 0x05
	replyCommandNotSupported = 0x07
	replyAddressNotSupported = 0x08
)

// A greeting that never arrives holds a goroutine and a socket. Generous enough
// for a driver that opens a connection before it needs it, short enough that a
// port scan does not accumulate.
const handshakeTimeout = 30 * time.Second

// How long a CONNECT waits for the api's verdict. The api has to resolve
// through the tunnel to answer, so this is a DNS timeout plus a pipe, not a
// pipe.
const verdictTimeout = 20 * time.Second

// The answer to one dialRequest.
type verdict struct {
	address netip.AddrPort
	// Empty when the dial is allowed; the guard's own sentence when it is not.
	refusal string
}

// Hands out ids and parks the goroutine that is waiting for each answer.
type verdicts struct {
	mu      sync.Mutex
	next    uint64
	waiting map[string]chan verdict
}

func newVerdicts() *verdicts {
	return &verdicts{waiting: make(map[string]chan verdict)}
}

func (v *verdicts) open() (string, chan verdict) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.next++
	id := strconv.FormatUint(v.next, 10)
	// Buffered, so an answer that arrives after the waiter has given up does not
	// block the command loop that delivered it.
	channel := make(chan verdict, 1)
	v.waiting[id] = channel
	return id, channel
}

func (v *verdicts) close(id string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.waiting, id)
}

// Reports whether anything was still waiting: an answer for an id nobody holds
// is worth an error event rather than silence, because it means the two sides
// disagree about what is in flight.
func (v *verdicts) deliver(id string, answer verdict) bool {
	v.mu.Lock()
	channel, found := v.waiting[id]
	if found {
		delete(v.waiting, id)
	}
	v.mu.Unlock()
	if !found {
		return false
	}
	channel <- answer
	return true
}

// One listener, in front of every peering this process holds.
//
// It was loopback with an ephemeral port when the process WAS one tunnel and the
// api was its parent. As a service it has to be reachable from the api's own
// container, and that changes what the credentials are for: they used to be what
// stopped another process on the same host using an open proxy, and they are now
// also what SELECTS the peering, so a caller reaches exactly the one device its
// credentials name.
//
// One port rather than one per peering, because an ephemeral port per customer
// cannot be published. A kubernetes Service routes the ports it declares, so a
// port nobody declared is a peering the api cannot reach — the shape that made
// per-peering listeners work is exactly the shape a service does not have.
type socksServer struct {
	listener *net.TCPListener
	peerings *registry
	// Problems that belong to no peering: a failed accept, a listener that died.
	// They go to stderr rather than into some customer's event stream, because
	// attributing them to whichever peering happened to be handy is a lie in a
	// log somebody will read during an incident.
	log func(string)
}

func startSocks(address string, peerings *registry, log func(string)) (*socksServer, error) {
	resolved, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("socks listen address %q is not usable: %w", address, err)
	}
	listener, err := net.ListenTCP("tcp", resolved)
	if err != nil {
		return nil, fmt.Errorf("could not listen on %s: %w", address, err)
	}
	return &socksServer{listener: listener, peerings: peerings, log: log}, nil
}

func (s *socksServer) port() (uint16, error) {
	address, ok := s.listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("listener address is %T, not a TCPAddr", s.listener.Addr())
	}
	if address.Port < 0 || address.Port > 65535 {
		return 0, fmt.Errorf("listener port %d is out of range", address.Port)
	}
	return uint16(address.Port), nil
}

func (s *socksServer) close() error {
	return s.listener.Close()
}

// Accepts until the listener is closed, which is how shutdown reaches it.
func (s *socksServer) serve(ctx context.Context) {
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			// A closed listener is the ordinary way this loop ends.
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			s.log("socks accept failed: " + err.Error())
			continue
		}
		go s.handle(ctx, connection)
	}
}

func (s *socksServer) handle(ctx context.Context, client net.Conn) {
	defer func() {
		// Best effort: the connection is finished with either way, and a failure
		// to close it is not something the api can act on.
		_ = client.Close()
	}()

	if err := client.SetDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		s.log("could not set a handshake deadline: " + err.Error())
		return
	}
	// Which peering this caller reached is decided HERE, by its credentials, and
	// nothing after this line consults anything else. A dial cannot cross from
	// one customer's device to another's without a credential that names it.
	entry, err := s.negotiate(client)
	if err != nil {
		// A refused greeting is a fact about the caller, not about the tunnel, and
		// a driver retrying with the wrong password would fill the trail with it.
		// It goes nowhere on purpose.
		return
	}

	host, port, err := readRequest(client)
	if err != nil {
		return
	}

	target, refusal, err := entry.verdictFor(ctx, host, port)
	if err != nil {
		_ = writeReply(client, replyGeneralFailure)
		_ = entry.emit(newError(err.Error()))
		return
	}
	if refusal != "" {
		// The guard's own sentence goes to the api, which is what logs it against
		// the tunnel; SOCKS has no field for a reason.
		_ = writeReply(client, replyNotAllowed)
		_ = entry.emit(newError(refusal))
		return
	}

	// Deadline lifted: what follows is a database connection that may be idle for
	// minutes between statements, and a deadline that outlived the handshake
	// would sever it.
	if err = client.SetDeadline(time.Time{}); err != nil {
		_ = writeReply(client, replyGeneralFailure)
		return
	}

	dialCtx, cancel := context.WithTimeout(ctx, verdictTimeout)
	defer cancel()
	upstream, err := entry.device.dial(dialCtx, target)
	if err != nil {
		_ = writeReply(client, replyRefused)
		return
	}
	defer func() {
		_ = upstream.Close()
	}()

	if err = writeReply(client, replySuccess); err != nil {
		return
	}
	splice(client, upstream)
}

// RFC 1928 greeting and RFC 1929 authentication, answering with the peering the
// caller authenticated as.
//
// Username/password is the only method offered, and it is no longer only about
// authentication: this listener is on a container network rather than loopback,
// so the credentials are simultaneously what proves the caller is the api and
// what names the device it may reach. There is deliberately no method by which a
// caller reaches "the tunnel" without naming one.
func (s *socksServer) negotiate(client net.Conn) (*peering, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(client, header); err != nil {
		return nil, err
	}
	if header[0] != socksVersion {
		return nil, fmt.Errorf("socks version %d is not supported", header[0])
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return nil, err
	}
	if !slices.Contains(methods, methodUserPass) {
		if _, err := client.Write([]byte{socksVersion, methodNone}); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("the caller offered no username/password method")
	}
	if _, err := client.Write([]byte{socksVersion, methodUserPass}); err != nil {
		return nil, err
	}

	version := make([]byte, 1)
	if _, err := io.ReadFull(client, version); err != nil {
		return nil, err
	}
	if version[0] != authVersion {
		return nil, fmt.Errorf("auth version %d is not supported", version[0])
	}
	username, err := readByteString(client)
	if err != nil {
		return nil, err
	}
	password, err := readByteString(client)
	if err != nil {
		return nil, err
	}

	// The password comparison is constant time; the username is a map key, which
	// it has to be for the lookup to happen at all, so a caller can learn that a
	// username exists by timing. That is the cost of routing by credential and it
	// is accepted: the username is 24 random bytes it has to guess first, and
	// knowing one exists does not get it past the password.
	entry := s.peerings.authenticate(string(username), string(password))
	if entry == nil {
		if _, err = client.Write([]byte{authVersion, 0x01}); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("the caller's credentials do not match a peering")
	}
	if _, err = client.Write([]byte{authVersion, 0x00}); err != nil {
		return nil, err
	}
	return entry, nil
}

func readByteString(client net.Conn) ([]byte, error) {
	length := make([]byte, 1)
	if _, err := io.ReadFull(client, length); err != nil {
		return nil, err
	}
	value := make([]byte, int(length[0]))
	if _, err := io.ReadFull(client, value); err != nil {
		return nil, err
	}
	return value, nil
}

// The CONNECT request. Returns the host as the caller wrote it — a name stays a
// name, because resolving it is the api's decision to make, not ours.
func readRequest(client net.Conn) (string, uint16, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(client, header); err != nil {
		return "", 0, err
	}
	if header[0] != socksVersion {
		return "", 0, fmt.Errorf("socks version %d is not supported", header[0])
	}
	if header[1] != commandConnect {
		if err := writeReply(client, replyCommandNotSupported); err != nil {
			return "", 0, err
		}
		// BIND and UDP ASSOCIATE are not refused for want of effort: a database
		// driver opens outbound connections, and a proxy that also listens on a
		// customer's behalf is a different thing with a different threat model.
		return "", 0, fmt.Errorf("socks command %d is not supported", header[1])
	}

	var host string
	switch header[3] {
	case atypIPv4:
		raw := make([]byte, 4)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", 0, err
		}
		host = netip.AddrFrom4([4]byte(raw)).String()
	case atypIPv6:
		raw := make([]byte, 16)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", 0, err
		}
		host = netip.AddrFrom16([16]byte(raw)).String()
	case atypDomain:
		raw, err := readByteString(client)
		if err != nil {
			return "", 0, err
		}
		host = string(raw)
	default:
		if err := writeReply(client, replyAddressNotSupported); err != nil {
			return "", 0, err
		}
		return "", 0, fmt.Errorf("socks address type %d is not supported", header[3])
	}

	rawPort := make([]byte, 2)
	if _, err := io.ReadFull(client, rawPort); err != nil {
		return "", 0, err
	}
	return host, binary.BigEndian.Uint16(rawPort), nil
}

// BND.ADDR/BND.PORT are reported as 0.0.0.0:0. The drivers do not read them,
// and the honest alternative — the address inside the tunnel we bound — would
// tell a caller about the customer's network for no purpose.
func writeReply(client net.Conn, code byte) error {
	_, err := client.Write([]byte{socksVersion, code, 0x00, atypIPv4, 0, 0, 0, 0, 0, 0})
	return err
}

// Asks the api whether this connection may be made, and to which address.
//
// A method on the peering rather than on the server, because the question and
// the answer both belong to one control connection: the request goes out on this
// peering's own stream and the api that answers is the one holding it. It lives
// in this file because the dial path is what it is for.
func (p *peering) verdictFor(ctx context.Context, host string, port uint16) (netip.AddrPort, string, error) {
	id, answers := p.verdicts.open()
	defer p.verdicts.close(id)

	if err := p.emit(newDialRequest(id, host, port)); err != nil {
		return netip.AddrPort{}, "", fmt.Errorf("could not ask about %s: %w", host, err)
	}

	timer := time.NewTimer(verdictTimeout)
	defer timer.Stop()
	select {
	case answer := <-answers:
		return answer.address, answer.refusal, nil
	case <-timer.C:
		// Silence is a refusal, never an allowance: an api that cannot answer has
		// not judged the address, and dialling it anyway is the one outcome the
		// guard exists to prevent.
		return netip.AddrPort{}, "", fmt.Errorf("no verdict for %s within %s", host, verdictTimeout)
	case <-ctx.Done():
		return netip.AddrPort{}, "", ctx.Err()
	}
}

// Both directions, and the pair dies together: a database connection whose
// halves outlive each other is a socket nobody will close.
func splice(client, upstream net.Conn) {
	var wait sync.WaitGroup
	wait.Add(2)
	copyOnce := func(to net.Conn, from net.Conn) {
		defer wait.Done()
		// The error is deliberately not reported: a connection ending is the
		// ordinary case, both sides see it, and a driver's own error message is
		// better than ours about a socket it owns.
		_, _ = io.Copy(to, from)
		if closer, ok := to.(interface{ CloseWrite() error }); ok {
			_ = closer.CloseWrite()
			return
		}
		_ = to.Close()
	}
	go copyOnce(upstream, client)
	go copyOnce(client, upstream)
	wait.Wait()
}
