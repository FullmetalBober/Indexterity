package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/device"
)

// The control plane: one connection per peering, carrying the exact protocol
// this process used to speak over stdin and stdout.
//
// That equivalence is deliberate and it is why this file is short. A control
// connection is a stream of line-delimited JSON in both directions, which is
// what a pipe was, so readCommands and the event writer are reused unchanged —
// the transport moved and the protocol did not. What the connection replaces is
// the CHILD PROCESS: it is the handle on one peering's lifetime, it carries that
// peering's events and nobody else's, and when it closes the peering goes with
// it, exactly as stdin closing used to end the process.
//
// The api is always the initiator. This service therefore needs no address for
// the api and no inbound callback — and, because the listener is loopback inside
// the api's own network namespace, no credential either. What authenticates a
// greeting is that it could only have come from inside the pod.

// How long a connection has to say who it is. A control port that lets an
// unauthenticated caller hold a socket open is a port a scan accumulates on.
const helloTimeout = 10 * time.Second

// TCP keepalive on an accepted control connection.
//
// This is load-bearing rather than hygiene. When the api was the parent process,
// its death closed stdin and the peering ended in the same instant. Over TCP, an
// api that is killed without a FIN — an OOM kill, a severed network, a node that
// went away — leaves this side holding an ESTABLISHED socket forever, and with it
// a live WireGuard session into a customer's network that nobody is watching.
// Keepalive is what puts a bound on that.
const (
	keepaliveIdle   = 30 * time.Second
	keepaliveEvery  = 10 * time.Second
	keepaliveProbes = 3
)

type controlServer struct {
	listener *net.TCPListener
	peerings *registry
	// Announced to every peering: the shared SOCKS5 port. The api pairs it with
	// the host it already dialled to reach this service.
	socksPort uint16
	logger    *device.Logger
	log       func(string)
}

func startControl(
	address string,
	peerings *registry,
	socksPort uint16,
	logger *device.Logger,
	log func(string),
) (*controlServer, error) {
	resolved, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("control listen address %q is not usable: %w", address, err)
	}
	listener, err := net.ListenTCP("tcp", resolved)
	if err != nil {
		return nil, fmt.Errorf("could not listen on %s: %w", address, err)
	}
	return &controlServer{
		listener:  listener,
		peerings:  peerings,
		socksPort: socksPort,
		logger:    logger,
		log:       log,
	}, nil
}

func (c *controlServer) close() error {
	return c.listener.Close()
}

func (c *controlServer) serve(ctx context.Context) {
	for {
		connection, err := c.listener.AcceptTCP()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			c.log("control accept failed: " + err.Error())
			continue
		}
		go c.session(ctx, connection)
	}
}

// One peering, for as long as its connection lives.
func (c *controlServer) session(ctx context.Context, connection *net.TCPConn) {
	defer func() {
		// Best effort: the peering is finished either way, and there is nobody
		// left to tell about a failed close.
		_ = connection.Close()
	}()

	if err := c.keepalive(connection); err != nil {
		c.log(err.Error())
		return
	}

	events := newEventWriter(connection)
	input := bufio.NewReader(connection)

	greeting, err := c.hello(connection, input)
	if err != nil {
		// Nothing is emitted and nothing is attributed: a connection that never
		// named a peering has none to log against.
		c.log("control connection refused: " + err.Error())
		return
	}

	// wireguard-go's NewLogger writes to STDOUT. Here that is no longer protocol
	// — the protocol is on the connection — but stdout is still the service's own
	// log, so the device log stays on stderr where the deployment already reads it
	// and cannot be confused for an event.
	wireguard, err := newTunnel(greeting.Config, c.logger)
	if err != nil {
		// The api gets the reason: a config it just sent that cannot come up is
		// exactly what its reachability test exists to report.
		_ = events.emit(newError(err.Error()))
		return
	}
	defer wireguard.close()

	pending := newVerdicts()
	entry, err := c.peerings.add(greeting.ID, wireguard, pending, events.emit)
	if err != nil {
		_ = events.emit(newError(err.Error()))
		return
	}
	// Deregistered before the device closes, so no SOCKS5 caller can authenticate
	// into a peering whose stack is being torn down.
	defer c.peerings.remove(entry)

	session, done := context.WithCancel(ctx)
	defer done()

	watching := make(chan error, 1)
	go func() { watching <- wireguard.watch(session, events.emit) }()

	if err = events.emit(newListening(c.socksPort, entry.username, entry.password)); err != nil {
		c.log("could not announce the listener: " + err.Error())
		return
	}

	commands := make(chan error, 1)
	go func() { commands <- readCommands(session, input, wireguard, pending, events.emit) }()

	// Whichever ends first ends this peering, and only this one: the connection
	// closing means the api is gone, a failed emit means the connection is broken,
	// and ctx being done means the whole service is going. Every other peering
	// this process holds is unaffected, which is the one thing a shared process
	// has to get right.
	select {
	case <-session.Done():
	case err = <-commands:
		if err != nil {
			c.log("peering " + entry.id + ": " + err.Error())
		}
	case err = <-watching:
		if err != nil {
			c.log("peering " + entry.id + ": " + err.Error())
		}
	}
}

func (c *controlServer) keepalive(connection *net.TCPConn) error {
	if err := connection.SetKeepAliveConfig(net.KeepAliveConfig{
		Enable:   true,
		Idle:     keepaliveIdle,
		Interval: keepaliveEvery,
		Count:    keepaliveProbes,
	}); err != nil {
		return fmt.Errorf("could not configure keepalive: %w", err)
	}
	return nil
}

// The first line: the token, and the peering to bring up.
//
// The deadline covers only this. Once a peering is up its connection is expected
// to be silent for long stretches — the api sends a command when something
// happens and not otherwise — so a read deadline that outlived the greeting would
// tear down healthy peerings on a quiet night.
func (c *controlServer) hello(connection *net.TCPConn, input *bufio.Reader) (*hello, error) {
	if err := connection.SetReadDeadline(time.Now().Add(helloTimeout)); err != nil {
		return nil, fmt.Errorf("could not set a greeting deadline: %w", err)
	}
	line, err := input.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("could not read the greeting: %w", err)
	}
	if err = connection.SetReadDeadline(time.Time{}); err != nil {
		return nil, fmt.Errorf("could not lift the greeting deadline: %w", err)
	}

	var greeting hello
	// Unknown fields are refused rather than ignored: a field the api thinks it is
	// setting and this build silently drops is the kind of disagreement that shows
	// up as a tunnel that works and carries the wrong AllowedIPs.
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&greeting); err != nil {
		return nil, fmt.Errorf("the greeting is not the expected JSON: %w", err)
	}

	if greeting.ID == "" {
		return nil, fmt.Errorf("the greeting carries no id")
	}
	return &greeting, nil
}
