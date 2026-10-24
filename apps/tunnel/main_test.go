package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// Run as the SERVICE when the test binary is started with this set, so a test can
// signal the real run() in its own process — the wiring a unit test of drain()
// cannot see. See TestTheServiceDrainsOnSIGTERM.
const asService = "INDEXTERITY_TUNNEL_TEST_AS_SERVICE"

func TestMain(m *testing.M) {
	if os.Getenv(asService) == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

// SIGTERM drains (#649). Every deployment signals the api and this service
// together, and the api finishes its in-flight passes before it closes its
// peerings. A service that exited at once left those passes dialling a SOCKS5
// listener that had gone, and each was reported as an unreachable cluster.

// A peering brought up the way the api brings one up, with the credentials its
// `listening` event announced.
func openPeering(t *testing.T, control *controlServer, id string) (net.Conn, string, string) {
	t.Helper()
	client := dialControl(t, control)
	greet(t, client, id)
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	var announced struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err = json.Unmarshal([]byte(line), &announced); err != nil {
		t.Fatalf("unmarshal %q: %v", line, err)
	}
	return client, announced.Username, announced.Password
}

func TestDrainRefusesNewPeeringsAndServesTheOpenOnes(t *testing.T) {
	control, socks, peerings, _ := testService(t)
	client, username, password := openPeering(t, control, "draining-peering")
	waitForCount(t, peerings, 1)
	address := control.listener.Addr().String()

	left := make(chan int, 1)
	go func() { left <- drain(control, peerings, time.Minute) }()

	// No new peering: the control listener is closed.
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			break
		}
		_ = probe.Close()
		if time.Now().After(deadline) {
			t.Fatal("the control listener still accepts during a drain")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The open peering still serves: its connection takes a command, and its
	// credentials still get a SOCKS5 caller in — the dial a pass the api is
	// finishing makes.
	if _, err := client.Write([]byte("{\"cmd\":\"handshake\"}\n")); err != nil {
		t.Fatalf("the open peering's connection is gone: %v", err)
	}
	if err := authenticate(t, dialServer(t, socks), username, password); err != nil {
		t.Fatalf("the open peering's SOCKS5 credentials stopped working: %v", err)
	}

	select {
	case n := <-left:
		t.Fatalf("the drain ended with %d peerings up while one was open", n)
	case <-time.After(300 * time.Millisecond):
	}

	// The api closing its peering is what ends the drain.
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case n := <-left:
		if n != 0 {
			t.Fatalf("the drain ended with %d peerings up", n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the drain did not end once the last peering closed")
	}
}

// A signal nobody follows with a kill still ends the service.
func TestDrainGivesUpAtItsLimit(t *testing.T) {
	control, peerings, _ := testControl(t)
	_, _, _ = openPeering(t, control, "lingering-peering")
	waitForCount(t, peerings, 1)

	started := time.Now()
	if left := drain(control, peerings, 200*time.Millisecond); left != 1 {
		t.Fatalf("the drain gave up with %d peerings up, want 1", left)
	}
	if waited := time.Since(started); waited < 200*time.Millisecond {
		t.Fatalf("the drain gave up after %s, before its limit", waited)
	}
}

// The service as a process, given a free control port, started and waited on.
func startService(t *testing.T) (*exec.Cmd, string, <-chan error) {
	t.Helper()
	free, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	bound, ok := free.Addr().(*net.TCPAddr)
	_ = free.Close()
	if !ok {
		t.Fatalf("the listener's address %v is not TCP", free.Addr())
	}
	port := bound.Port

	service := exec.Command(os.Args[0], "-test.run=^$")
	service.Env = append(os.Environ(), asService+"=1", "TUNNEL_PORT="+strconv.Itoa(port))
	service.Stderr = os.Stderr
	if err = service.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- service.Wait() }()
	t.Cleanup(func() { _ = service.Process.Kill() })

	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, dialErr := net.DialTimeout("tcp", address, time.Second)
		if dialErr == nil {
			_ = probe.Close()
			return service, address, exited
		}
		if time.Now().After(deadline) {
			t.Fatalf("the service never listened on %s", address)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The api's side of a peering, over the real control port.
func peerThrough(t *testing.T, address string) (net.Conn, uint16, string, string) {
	t.Helper()
	client, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	greet(t, client, "process-peering")
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	var announced struct {
		Port     uint16 `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err = json.Unmarshal([]byte(line), &announced); err != nil {
		t.Fatalf("unmarshal %q: %v", line, err)
	}
	return client, announced.Port, announced.Username, announced.Password
}

// What production needed: SIGTERM while the api still holds a peering leaves the
// data path up, and the process goes once the api lets the peering go.
func TestTheServiceDrainsOnSIGTERM(t *testing.T) {
	service, address, exited := startService(t)
	client, socksPort, username, password := peerThrough(t, address)

	if err := service.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal: %v", err)
	}

	// New peerings are refused.
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			break
		}
		_ = probe.Close()
		if time.Now().After(deadline) {
			t.Fatal("the control port still accepts after SIGTERM")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The open peering's SOCKS5 credentials still get a caller in, which is the
	// dial an in-flight pass makes.
	socks, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(socksPort))), time.Second)
	if err != nil {
		t.Fatalf("the SOCKS5 port is gone after SIGTERM: %v", err)
	}
	t.Cleanup(func() { _ = socks.Close() })
	if err = socks.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	if err = authenticate(t, socks, username, password); err != nil {
		t.Fatalf("the open peering stopped authenticating after SIGTERM: %v", err)
	}

	select {
	case err = <-exited:
		t.Fatalf("the service exited while a peering was open: %v", err)
	case <-time.After(300 * time.Millisecond):
	}

	// The api letting the peering go is what ends it, and cleanly.
	_ = client.Close()
	select {
	case err = <-exited:
		if err != nil {
			t.Fatalf("the service exited with %v, want 0", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the service did not exit once its last peering closed")
	}
}

// A second signal ends it at once, for whoever is not willing to wait.
func TestASecondSignalEndsTheDrain(t *testing.T) {
	service, address, exited := startService(t)
	_, _, _, _ = peerThrough(t, address)

	if err := service.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal: %v", err)
	}
	// After the drain has begun: the control port refusing is when it has.
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			break
		}
		_ = probe.Close()
		if time.Now().After(deadline) {
			t.Fatal("the drain never began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := service.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("second signal: %v", err)
	}
	select {
	case err := <-exited:
		var exit *exec.ExitError
		if err == nil || !errors.As(err, &exit) {
			t.Fatalf("the service exited with %v, want the signal", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a second signal did not end the drain")
	}
}
