package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// One WireGuard peering, terminated in this process: wireguard-go doing the
// protocol, gvisor's netstack doing IP and TCP, and neither of them ours.
//
// Each tunnel is its own process and therefore its own stack, which is what
// makes two customers on 10.0.0.0/8 a non-question rather than a routing
// conflict — the same property the userspace stack this replaces had, arrived at
// by isolation rather than by instancing.

// WireGuard's own numbers (whitepaper §6.1), and the reason the state below is
// derived rather than reported: wireguard-go exposes the time of the last
// completed handshake and nothing about whether one is in flight.
const (
	// After this long with no handshake, keys may not be used — so a session
	// older than this is not "up" however recently it worked.
	rejectAfter = 180 * time.Second
	// The reference implementation gives up on an attempt after this long. Until
	// then, asked-for-and-not-yet-answered is `handshaking`.
	attemptWindow = 90 * time.Second
	// How often the last-handshake time is read back. A handshake completing is
	// worth knowing about promptly — the dashboard's Test waits for it — and the
	// read is a string from memory, so this is cheap.
	pollInterval = 250 * time.Millisecond
)

type tunnelState string

const (
	stateDown        tunnelState = "down"
	stateHandshaking tunnelState = "handshaking"
	stateUp          tunnelState = "up"
)

type tunnel struct {
	config config
	device *device.Device
	net    *netstack.Net
	// The peer, so a handshake can be asked for directly.
	peer *device.Peer

	mu sync.Mutex
	// When traffic last asked for a session. Ours to track, because it is the
	// half wireguard-go does not report, and without it a tunnel nobody has
	// dialled is indistinguishable from one whose gateway is not answering.
	askedAt time.Time
	// The last handshake this process has already told the api about.
	reportedHandshake time.Time
	reportedState     tunnelState
}

// Brings the device up. The caller owns close().
func newTunnel(c config, logger *device.Logger) (*tunnel, error) {
	addresses, err := parseAddresses(c.Addresses)
	if err != nil {
		return nil, fmt.Errorf("[Interface] Address: %w", err)
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("[Interface] Address is empty — the stack would have no address")
	}
	resolvers, err := parseAddresses(c.DNS)
	if err != nil {
		return nil, fmt.Errorf("[Interface] DNS: %w", err)
	}
	publicKey, err := peerKey(c.Peer.PublicKey)
	if err != nil {
		return nil, err
	}
	uapi, err := uapiConfig(c)
	if err != nil {
		return nil, err
	}

	tunDevice, tunnelNet, err := netstack.CreateNetTUN(addresses, resolvers, c.MTU)
	if err != nil {
		return nil, fmt.Errorf("could not create the network stack: %w", err)
	}
	wireguard := device.NewDevice(tunDevice, conn.NewDefaultBind(), logger)
	if err = wireguard.IpcSet(uapi); err != nil {
		wireguard.Close()
		return nil, fmt.Errorf("could not configure the device: %w", err)
	}
	if err = wireguard.Up(); err != nil {
		wireguard.Close()
		return nil, fmt.Errorf("could not bring the device up: %w", err)
	}

	// Looked up once and held: the peer is created by the IpcSet above and this
	// device has exactly one, so a nil here would mean the configuration did not
	// take — worth failing on rather than discovering at the first handshake.
	peer := wireguard.LookupPeer(publicKey)
	if peer == nil {
		wireguard.Close()
		return nil, fmt.Errorf("the device did not keep the peer it was configured with")
	}

	return &tunnel{
		config:        c,
		device:        wireguard,
		net:           tunnelNet,
		peer:          peer,
		reportedState: stateDown,
	}, nil
}

func (t *tunnel) close() {
	t.device.Close()
}

// Ask for a handshake now, with no packet of anyone's to send.
//
// Sent through the device's own peer rather than by pushing traffic through the
// stack, because traffic is NOT enough: a device holding a valid session simply
// encrypts with it, and no new handshake happens until a rekey is due. That is
// the whole thing the reachability test needs to defeat — a session negotiated
// an hour ago against a gateway that has been switched off since.
//
// wireguard-go suppresses an initiation sent within RekeyTimeout (5s) of the
// last one and returns nil, which is its own flood protection and is left in
// place. It means a caller pressing Test twice in five seconds gets one
// handshake, so the api treats a handshake younger than that window as the
// answer rather than asking for another.
func (t *tunnel) handshake() error {
	t.mu.Lock()
	t.askedAt = time.Now()
	t.mu.Unlock()

	if err := t.peer.SendHandshakeInitiation(false); err != nil {
		return fmt.Errorf("could not send a handshake initiation: %w", err)
	}
	return nil
}

// Names inside the tunnel, answered by the customer's own resolver.
//
// The addresses are handed back rather than dialled: the api judges every one
// of them against the same guard the direct path uses, and a resolver that
// answers about a host on OUR side is exactly what this exists to avoid.
func (t *tunnel) resolve(ctx context.Context, host string) ([]string, error) {
	if len(t.config.DNS) == 0 {
		return nil, fmt.Errorf("this tunnel's config carries no DNS, so names inside it cannot be resolved")
	}
	addresses, err := t.net.LookupContextHost(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("%s does not resolve inside the tunnel: %w", host, err)
	}
	return addresses, nil
}

// A gateway that has moved — dynamic DNS, re-resolved and re-vetted by the api.
func (t *tunnel) setEndpoint(endpoint string) error {
	uapi, err := uapiEndpoint(t.config.Peer.PublicKey, endpoint)
	if err != nil {
		return err
	}
	if err = t.device.IpcSet(uapi); err != nil {
		return fmt.Errorf("could not move the endpoint to %s: %w", endpoint, err)
	}
	t.config.Peer.Endpoint = endpoint
	return nil
}

// Dial through the tunnel, to an address the api has already allowed.
func (t *tunnel) dial(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
	t.mu.Lock()
	t.askedAt = time.Now()
	t.mu.Unlock()

	connection, err := t.net.DialContextTCPAddrPort(ctx, address)
	if err != nil {
		return nil, err
	}
	return connection, nil
}

// When the last handshake completed, read back from the device.
//
// The UAPI document is the only place wireguard-go says so, which is why this
// parses one. Zero means there has never been one in this process.
func (t *tunnel) lastHandshake() (time.Time, error) {
	document, err := t.device.IpcGet()
	if err != nil {
		return time.Time{}, fmt.Errorf("could not read the device: %w", err)
	}
	return parseLastHandshake(document)
}

// What the api and the dashboard call this tunnel, derived from the two facts
// available: when a handshake last completed, and when traffic last asked for
// one. wireguard-go reports the first; the second is ours because nothing
// reports it.
func (t *tunnel) stateAt(handshake time.Time, now time.Time) tunnelState {
	if !handshake.IsZero() && now.Sub(handshake) < rejectAfter {
		return stateUp
	}
	t.mu.Lock()
	asked := t.askedAt
	t.mu.Unlock()
	if !asked.IsZero() && now.Sub(asked) < attemptWindow {
		return stateHandshaking
	}
	return stateDown
}

// Reads the device on a tick and reports what moved: a completed handshake, and
// a state that is not the state last announced. Returns when ctx is done.
//
// Polled rather than pushed because wireguard-go offers no callback for either,
// and a poll of an in-memory string is cheaper than the machinery that would
// avoid it.
func (t *tunnel) watch(ctx context.Context, emit func(event) error) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			handshake, err := t.lastHandshake()
			if err != nil {
				if emitErr := emit(newError(err.Error())); emitErr != nil {
					return emitErr
				}
				continue
			}
			now := time.Now()

			t.mu.Lock()
			fresh := !handshake.IsZero() && handshake.After(t.reportedHandshake)
			if fresh {
				t.reportedHandshake = handshake
			}
			t.mu.Unlock()

			if fresh {
				if err = emit(newHandshake(now.Sub(handshake).Seconds())); err != nil {
					return err
				}
			}

			state := t.stateAt(handshake, now)
			t.mu.Lock()
			changed := state != t.reportedState
			if changed {
				t.reportedState = state
			}
			t.mu.Unlock()

			if changed {
				if err = emit(newState(string(state))); err != nil {
					return err
				}
			}
		}
	}
}
