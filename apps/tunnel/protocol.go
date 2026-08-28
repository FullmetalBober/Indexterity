package main

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// The wire between the api and this service: line-delimited JSON, a greeting and
// then commands in, events out, one control connection per peering.
//
// Two rules shape it. The PrivateKey arrives on the connection and never on argv
// or on disk — argv is world-readable through /proc and a file outlives the
// process that needed it. And the connection carries protocol and nothing else,
// which is why wireguard-go's own logger is pointed at stderr: device.NewLogger
// writes to stdout, and the service's log and its protocol must not be the same
// stream even now that they are no longer the same file descriptor.
//
// Everything here is a concrete struct. A map[string]any would move the shape
// of the protocol out of the compiler's reach on both sides of a connection that
// is carrying a private key.

// The first line of a control connection: who is asking, and what to bring up.
//
// The token is the whole of the control plane's authentication. It rides here
// rather than in a header because there is no header — the transport is a socket
// carrying JSON lines — and it is compared in constant time before the config is
// so much as looked at (server.go).
type hello struct {
	Token string `json:"token"`
	// The api's own id for this peering, echoed into this service's log so a line
	// about a failing peering names the tunnel an operator can look up. Never a
	// secret and never used for routing: what selects a peering on the data path
	// is its generated SOCKS5 credential, not this.
	ID     string `json:"id"`
	Config config `json:"config"`
}

// What the api hands over inside the greeting. A serialization of the
// WireGuardConf it has already parsed and validated (tunnel/conf.ts) — this
// process re-decodes the keys, because it has to, and re-parses nothing else.
type config struct {
	// Base64, as a wg0.conf carries it. Converted to the hex UAPI wants in
	// keys.go, which is the one representation change this process makes.
	PrivateKey string `json:"privateKey"`
	// CIDRs from [Interface] Address. IPv4, IPv6 or both — gvisor's stack
	// carries either, unlike the userspace stack this replaces.
	Addresses []string `json:"addresses"`
	// The resolvers that answer names INSIDE the tunnel.
	DNS []string `json:"dns"`
	MTU int      `json:"mtu"`

	Peer peerConfig `json:"peer"`
}

type peerConfig struct {
	PublicKey    string   `json:"publicKey"`
	PresharedKey string   `json:"presharedKey,omitempty"`
	AllowedIPs   []string `json:"allowedIps"`
	// ALREADY RESOLVED, and vetted by the api's network guard as a PUBLIC
	// target. This process never resolves the gateway: a customer-supplied
	// endpoint is an outbound dial somebody else decided to make, and the
	// decision stays with the side that owns the guard. A gateway on dynamic
	// DNS moves by the api sending an `endpoint` command.
	Endpoint            string `json:"endpoint"`
	PersistentKeepalive int    `json:"persistentKeepalive,omitempty"`
}

// One line of stdin after the config. Optional fields rather than a union,
// because the vocabulary is four verbs and a tagged union across a pipe costs
// more to read than it saves.
type command struct {
	Cmd string `json:"cmd"`
	// Correlates a reply with the request that is waiting for it. Required on
	// dialAllow and dialDeny, which answer a dial holding a socket open.
	ID string `json:"id,omitempty"`
	// resolve
	Host string `json:"host,omitempty"`
	// endpoint — a re-resolved gateway, already vetted
	Endpoint string `json:"endpoint,omitempty"`
	// dialAllow: the address to dial, resolved and vetted by the api
	Address string `json:"address,omitempty"`
	// dialDeny / resolve failure: why, in the guard's own words
	Message string `json:"message,omitempty"`
}

const (
	cmdHandshake = "handshake"
	cmdResolve   = "resolve"
	cmdEndpoint  = "endpoint"
	cmdDialAllow = "dialAllow"
	cmdDialDeny  = "dialDeny"
	cmdShutdown  = "shutdown"
)

// Events. Each one is its own type so that a field can never be set on an event
// that has no business carrying it.
type event interface {
	isEvent()
}

// The SOCKS5 front end is up and these are its credentials. The api turns this
// straight into the DialProxy the three drivers already speak.
type listeningEvent struct {
	Type     string `json:"type"`
	Port     uint16 `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (listeningEvent) isEvent() {}

func newListening(port uint16, username, password string) listeningEvent {
	return listeningEvent{Type: "listening", Port: port, Username: username, Password: password}
}

// down | handshaking | up, the same three the dashboard draws.
type stateEvent struct {
	Type  string `json:"type"`
	State string `json:"state"`
}

func (stateEvent) isEvent() {}

func newState(state string) stateEvent { return stateEvent{Type: "state", State: state} }

// A handshake COMPLETED. Distinct from a state change on purpose: a rekey on a
// tunnel that is already up changes no state at all, and that is the case the
// reachability test exists to observe.
type handshakeEvent struct {
	Type       string  `json:"type"`
	AgeSeconds float64 `json:"ageSeconds"`
}

func (handshakeEvent) isEvent() {}

func newHandshake(age float64) handshakeEvent {
	return handshakeEvent{Type: "handshake", AgeSeconds: age}
}

// What the customer's own resolver answered, for a name that means something
// only inside their network.
type resolvedEvent struct {
	Type      string   `json:"type"`
	ID        string   `json:"id"`
	Addresses []string `json:"addresses"`
}

func (resolvedEvent) isEvent() {}

func newResolved(id string, addresses []string) resolvedEvent {
	return resolvedEvent{Type: "resolved", ID: id, Addresses: addresses}
}

// A request this process could not answer — a resolve that failed, so the api
// can treat it as "cannot check" rather than as "allowed".
type failedEvent struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Message string `json:"message"`
}

func (failedEvent) isEvent() {}

func newFailed(id, message string) failedEvent {
	return failedEvent{Type: "failed", ID: id, Message: message}
}

// A dial wants a verdict: may this connection be made, and to which address?
// Asked for EVERY connection, including one whose host is already an IP
// literal. This process holds no policy — the FORBIDDEN tier and the AllowedIPs
// containment live in the api's net-guard.ts, and a second copy of a security
// table in a second language is a copy that drifts.
type dialRequestEvent struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Host string `json:"host"`
	Port uint16 `json:"port"`
}

func (dialRequestEvent) isEvent() {}

func newDialRequest(id, host string, port uint16) dialRequestEvent {
	return dialRequestEvent{Type: "dialRequest", ID: id, Host: host, Port: port}
}

// A condition of this tunnel, not of the process: logged by the api against the
// tunnel and shown as the reason a probe found nothing.
type errorEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func (errorEvent) isEvent() {}

func newError(message string) errorEvent { return errorEvent{Type: "error", Message: message} }

// Serializes events to stdout, one JSON object per line.
//
// Locked, because three sources emit concurrently: the state poller, the
// command loop and a SOCKS connection asking for a verdict. Flushed per event —
// an event still sitting in a buffer is an event the api is waiting for.
type eventWriter struct {
	mu      sync.Mutex
	buffer  *bufio.Writer
	encoder *json.Encoder
}

func newEventWriter(out io.Writer) *eventWriter {
	buffer := bufio.NewWriter(out)
	encoder := json.NewEncoder(buffer)
	return &eventWriter{buffer: buffer, encoder: encoder}
}

// A failure here means stdout is gone, which means the api is gone. The caller
// treats it as a reason to shut down rather than as something to retry into a
// closed pipe.
func (w *eventWriter) emit(e event) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.encoder.Encode(e); err != nil {
		return err
	}
	return w.buffer.Flush()
}
