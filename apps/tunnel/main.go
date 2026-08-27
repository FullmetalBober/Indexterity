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

// indexterity-tunnel: one WireGuard peering, terminated in userspace, spawned by
// the api per tunnel.
//
// It needs no capability and no TUN device — which is the whole reason it can
// serve a hosted install, where NET_ADMIN and /dev/net/tun are both unavailable
// and one routing table per pod could not tell two customers on 10.0.0.0/8
// apart. It holds no policy either: the api decides every dial (see socks.go).
//
// Contract, in both directions:
//
//	stdin   line 1      the config, as JSON — including the PrivateKey
//	stdin   line 2..n   commands: handshake, resolve, endpoint, dialAllow,
//	                    dialDeny, shutdown
//	stdout              events: listening, state, handshake, resolved, failed,
//	                    dialRequest, error — one JSON object per line
//	stderr              wireguard-go's own log, and nothing that is protocol
//
// It exits 0 when told to shut down, when stdin closes (the api is gone), or on
// SIGTERM. It exits 1 only when it could not start, having said why on stderr.

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "indexterity-tunnel: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	events := newEventWriter(os.Stdout)
	input := bufio.NewReader(os.Stdin)

	configLine, err := input.ReadString('\n')
	if err != nil {
		return fmt.Errorf("could not read the config from stdin: %w", err)
	}
	var settings config
	// Unknown fields are refused rather than ignored: a field the api thinks it
	// is setting and this build silently drops is the kind of disagreement that
	// shows up as a tunnel that works and carries the wrong AllowedIPs.
	decoder := json.NewDecoder(strings.NewReader(configLine))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&settings); err != nil {
		return fmt.Errorf("the config is not the expected JSON: %w", err)
	}

	// wireguard-go's NewLogger writes to STDOUT, which here carries protocol. One
	// Verbosef line into it would corrupt the stream, so the log is rebuilt onto
	// stderr rather than configured.
	logger := stderrLogger()

	peering, err := newTunnel(settings, logger)
	if err != nil {
		return err
	}
	defer peering.close()

	pending := newVerdicts()
	socks, err := startSocks(peering, pending, events.emit)
	if err != nil {
		return err
	}
	defer func() {
		// Best effort: the process is on its way out and the listener is going
		// with it either way.
		_ = socks.close()
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go socks.serve(ctx)

	watching := make(chan error, 1)
	go func() { watching <- peering.watch(ctx, events.emit) }()

	port, err := socks.port()
	if err != nil {
		return err
	}
	if err = events.emit(newListening(port, socks.username, socks.password)); err != nil {
		return fmt.Errorf("could not announce the listener: %w", err)
	}

	commands := make(chan error, 1)
	go func() { commands <- readCommands(ctx, input, peering, pending, events.emit) }()

	// Whichever ends first ends the process: stdin closing means the api is gone,
	// a signal means the pod is going, and a failed emit means stdout is broken —
	// in every case there is nobody left to serve.
	select {
	case <-ctx.Done():
		return nil
	case err = <-commands:
		return err
	case err = <-watching:
		return err
	}
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
