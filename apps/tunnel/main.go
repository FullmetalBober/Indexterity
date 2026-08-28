package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.zx2c4.com/wireguard/device"
)

// indexterity-tunnel: WireGuard peerings terminated in userspace, as a service
// the api connects to.
//
// It needs no capability and no TUN device — which is the whole reason it can
// serve a hosted install, where NET_ADMIN and /dev/net/tun are both unavailable
// and one routing table per pod could not tell two customers on 10.0.0.0/8
// apart. It holds no policy either: the api decides every dial (see socks.go).
//
// It used to be spawned per tunnel and speak over stdin and stdout. It is now
// one process holding many devices, and the pipe became a socket — see D112 for
// why, and for what that costs. The protocol did not change.
//
// Two listeners:
//
//	control   one connection per peering. First line is the greeting (token, id,
//	          config, including the PrivateKey), then commands: handshake,
//	          resolve, endpoint, dialAllow, dialDeny, shutdown. Events come back
//	          on the same connection — listening, state, handshake, resolved,
//	          failed, dialRequest, error — one JSON object per line. The
//	          connection IS the peering's lifetime: closing it takes the device
//	          down, and nothing else's.
//	socks     SOCKS5, shared by every peering. The credentials announced to a
//	          peering in its `listening` event are what select it.
//
// stderr carries wireguard-go's log and this service's own, and neither is ever
// protocol. It exits 0 on SIGTERM, and 1 only when it could not start, having
// said why on stderr.
//
// Environment:
//
//	TUNNEL_TOKEN          required. The shared secret a greeting must carry.
//	TUNNEL_LISTEN         control address, default :9411
//	TUNNEL_SOCKS_LISTEN   socks address, default :9412

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "indexterity-tunnel: "+err.Error())
		os.Exit(1)
	}
}

// Where the service listens and what it trusts.
//
// From the environment rather than argv, for the same reason the private key is
// not on argv: /proc/<pid>/cmdline is readable by anything on the host, and the
// token is the whole of the control plane's authentication.
type settings struct {
	control string
	socks   string
	token   string
}

const (
	defaultControlListen = ":9411"
	defaultSocksListen   = ":9412"
)

func fromEnvironment() (settings, error) {
	token := os.Getenv("TUNNEL_TOKEN")
	// Refused rather than defaulted to empty. An unauthenticated control port
	// lets anything that can reach it stand up a peering with a key of its own
	// choosing and be handed a proxy into whatever that peering allows — so a
	// service that cannot authenticate its api must not start at all.
	if token == "" {
		return settings{}, fmt.Errorf("TUNNEL_TOKEN is empty, and an unauthenticated control port would serve any caller that can reach it")
	}

	chosen := settings{control: defaultControlListen, socks: defaultSocksListen, token: token}
	if listen := os.Getenv("TUNNEL_LISTEN"); listen != "" {
		chosen.control = listen
	}
	if listen := os.Getenv("TUNNEL_SOCKS_LISTEN"); listen != "" {
		chosen.socks = listen
	}
	return chosen, nil
}

func run() error {
	chosen, err := fromEnvironment()
	if err != nil {
		return err
	}

	log := func(message string) {
		fmt.Fprintln(os.Stderr, "indexterity-tunnel: "+message)
	}

	// The SOCKS5 listener comes up FIRST, because its port is announced to every
	// peering in the greeting's answer. A control connection accepted before there
	// is a port to name would have to be told later, which is a second message
	// nobody needs.
	peerings := newRegistry()
	socks, err := startSocks(chosen.socks, peerings, log)
	if err != nil {
		return err
	}
	defer func() {
		// Best effort: the process is on its way out and the listener is going
		// with it either way.
		_ = socks.close()
	}()
	port, err := socks.port()
	if err != nil {
		return err
	}

	// wireguard-go's NewLogger writes to STDOUT. Rebuilt onto stderr rather than
	// configured, so the service's log and its peerings' protocol can never be the
	// same stream.
	control, err := startControl(chosen.control, chosen.token, peerings, port, stderrLogger(), log)
	if err != nil {
		return err
	}
	defer func() {
		_ = control.close()
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go socks.serve(ctx)
	go control.serve(ctx)

	log(fmt.Sprintf("control on %s, socks on %s", chosen.control, chosen.socks))

	// A signal is the only thing that ends the SERVICE now. A peering ending is a
	// condition of one connection and is handled there — which is the difference
	// this refactor makes: one customer's gateway going away used to be a process
	// exit, and an exiting process was the api's signal to give up on it.
	<-ctx.Done()
	log(fmt.Sprintf("shutting down, %d peerings were up", peerings.count()))
	return nil
}

// A device logger that keeps stdout clean. Verbose output is dropped rather than
// written: it is per-packet at times, and the api has no use for it — an error
// is a condition of the tunnel and goes to stderr, where the api's own logger
// picks it up against the tunnel id.
func stderrLogger() *device.Logger {
	return &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "wireguard: "+format+"\n", args...)
		},
	}
}

func readCommands(
	ctx context.Context,
	input *bufio.Reader,
	peering *tunnel,
	pending *verdicts,
	emit func(event) error,
) error {
	for {
		line, err := input.ReadString('\n')
		if err != nil {
			// EOF means the api's end of the pipe is gone, which is a reason to
			// exit rather than an error to report to it.
			return nil
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		var instruction command
		decoder := json.NewDecoder(strings.NewReader(trimmed))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&instruction); err != nil {
			if emitErr := emit(newError("unreadable command: " + err.Error())); emitErr != nil {
				return emitErr
			}
			continue
		}

		done, err := dispatch(ctx, instruction, peering, pending, emit)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}
}

// Handles one command. The bool says whether the process should stop.
func dispatch(
	ctx context.Context,
	instruction command,
	peering *tunnel,
	pending *verdicts,
	emit func(event) error,
) (bool, error) {
	switch instruction.Cmd {
	case cmdShutdown:
		return true, nil

	case cmdHandshake:
		// A failure here is a condition of the tunnel — a gateway address that
		// cannot be reached at all — so it is reported and the process stays up.
		if err := peering.handshake(); err != nil {
			return false, emit(newError(err.Error()))
		}
		return false, nil

	case cmdResolve:
		// Answered on its own goroutine: a resolver inside a tunnel that is not up
		// takes as long as the timeout, and the command loop has dial verdicts to
		// deliver in the meantime.
		go func() {
			addresses, err := peering.resolve(ctx, instruction.Host)
			if err != nil {
				_ = emit(newFailed(instruction.ID, err.Error()))
				return
			}
			_ = emit(newResolved(instruction.ID, addresses))
		}()
		return false, nil

	case cmdEndpoint:
		if err := peering.setEndpoint(instruction.Endpoint); err != nil {
			return false, emit(newError(err.Error()))
		}
		return false, nil

	case cmdDialAllow:
		address, err := netip.ParseAddrPort(instruction.Address)
		if err != nil {
			// The api allowed something this process cannot dial. Refused rather
			// than guessed at: the alternative is resolving it here, which is the
			// decision that does not belong here.
			if !pending.deliver(instruction.ID, verdict{refusal: "the allowed address is not an ip:port"}) {
				return false, emit(newError("dialAllow for " + instruction.ID + " has nobody waiting"))
			}
			return false, emit(newError(fmt.Sprintf("dialAllow %q: %v", instruction.Address, err)))
		}
		if !pending.deliver(instruction.ID, verdict{address: address}) {
			return false, emit(newError("dialAllow for " + instruction.ID + " has nobody waiting"))
		}
		return false, nil

	case cmdDialDeny:
		refusal := instruction.Message
		if refusal == "" {
			refusal = "the api refused this dial"
		}
		if !pending.deliver(instruction.ID, verdict{refusal: refusal}) {
			return false, emit(newError("dialDeny for " + instruction.ID + " has nobody waiting"))
		}
		return false, nil

	default:
		return false, emit(newError("unknown command " + instruction.Cmd))
	}
}
