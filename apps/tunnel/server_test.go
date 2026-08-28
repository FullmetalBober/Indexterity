package main

import (
	"bufio"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

// The control plane: what a connection has to prove before a peering exists, and
// what becomes of the peering when the connection goes.
//
// These bring up REAL devices — wireguard-go and gvisor's netstack, pointed at a
// gateway address nothing answers at. No handshake is needed for any of it, which
// is the point: a greeting being accepted, a listener being announced and a
// closed connection taking the stack down are all decided on this side.

// Lines the service logged, so a test can assert on SILENCE — which is the
// contract for a connection that was never the api (hello()).
type logCapture struct {
	mu    sync.Mutex
	lines []string
}

func (c *logCapture) add(message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, message)
}

func (c *logCapture) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.lines...)
}

func testControl(t *testing.T) (*controlServer, *registry, *logCapture) {
	t.Helper()
	logged := &logCapture{}
	peerings := newRegistry()
	socks, err := startSocks("127.0.0.1:0", peerings, func(message string) {
		t.Logf("socks: %s", message)
	})
	if err != nil {
		t.Fatalf("startSocks: %v", err)
	}
	t.Cleanup(func() { _ = socks.close() })
	port, err := socks.port()
	if err != nil {
		t.Fatalf("port: %v", err)
	}

	control, err := startControl("127.0.0.1:0", peerings, port, stderrLogger(), func(message string) {
		t.Logf("control: %s", message)
		logged.add(message)
	})
	if err != nil {
		t.Fatalf("startControl: %v", err)
	}
	t.Cleanup(func() { _ = control.close() })
	go control.serve(t.Context())
	return control, peerings, logged
}

func dialControl(t *testing.T, control *controlServer) net.Conn {
	t.Helper()
	client, err := net.Dial("tcp", control.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err = client.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	return client
}

func greet(t *testing.T, client net.Conn, id string) {
	t.Helper()
	line, err := json.Marshal(hello{ID: id, Config: testConfig()})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err = client.Write(append(line, '\n')); err != nil {
		t.Fatalf("greeting: %v", err)
	}
}

// Waits for the registry to reach a size, because a peering appearing and
// disappearing are both consequences of a goroutine the test does not hold.
func waitForCount(t *testing.T, peerings *registry, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if peerings.count() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("registry holds %d peerings, want %d", peerings.count(), want)
}

// There is no token to get wrong — the listener is loopback, so reaching it is
// the credential. What a greeting still has to carry is an id and a config that
// can come up, and neither being refused quietly is what these pin.
func TestControlRefusesAGreetingThatNamesNoPeering(t *testing.T) {
	control, peerings, _ := testControl(t)
	client := dialControl(t, control)

	greet(t, client, "")

	// Refused by closing: an unnamed peering would be a device whose log lines
	// name nothing, which is worse than no device.
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered a greeting carrying no id")
	}
	if peerings.count() != 0 {
		t.Fatalf("a refused greeting left %d peerings", peerings.count())
	}
}

func TestControlRefusesAnUnreadableGreeting(t *testing.T) {
	control, peerings, _ := testControl(t)
	client := dialControl(t, control)

	// Unknown fields are refused rather than ignored, so a build that disagrees
	// with the api about the config's shape fails here instead of carrying an
	// AllowedIPs nobody chose.
	if _, err := client.Write([]byte("{\"id\":\"x\",\"nonsense\":true}\n")); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered a greeting it could not read")
	}
	if peerings.count() != 0 {
		t.Fatalf("a refused greeting left %d peerings", peerings.count())
	}
}

// Loopback, and the same port the api is told to look on. Both halves of the
// design that replaced the shared secret, so both are pinned.
func TestTheListenersAreLoopbackOnly(t *testing.T) {
	t.Setenv("TUNNEL_PORT", "9999")
	chosen, err := fromEnvironment()
	if err != nil {
		t.Fatalf("fromEnvironment: %v", err)
	}
	if chosen.control != "127.0.0.1:9999" {
		t.Fatalf("control listens on %q", chosen.control)
	}
	// Port 0: ephemeral, announced per peering, nothing to configure.
	if chosen.socks != "127.0.0.1:0" {
		t.Fatalf("socks listens on %q", chosen.socks)
	}

	t.Setenv("TUNNEL_PORT", "not-a-port")
	if _, err = fromEnvironment(); err == nil {
		t.Fatal("a TUNNEL_PORT that is not a port was accepted")
	}
}

func TestControlAnnouncesTheSharedSocksPortAndThePeeringsOwnCredentials(t *testing.T) {
	control, peerings, _ := testControl(t)
	client := dialControl(t, control)

	greet(t, client, "tunnel-under-test")

	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	var announced struct {
		Type     string `json:"type"`
		Port     uint16 `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err = json.Unmarshal([]byte(line), &announced); err != nil {
		t.Fatalf("unmarshal %q: %v", line, err)
	}
	if announced.Type != "listening" {
		t.Fatalf("first event is %q, want listening", announced.Type)
	}
	if announced.Username == "" || announced.Password == "" {
		t.Fatal("the listener was announced with no credentials")
	}

	waitForCount(t, peerings, 1)

	// The credentials announced are the ones that reach THIS peering, which is the
	// contract the api relies on to dial through the shared port.
	entry := peerings.authenticate(announced.Username, announced.Password)
	if entry == nil {
		t.Fatal("the announced credentials do not authenticate")
	}
	if entry.id != "tunnel-under-test" {
		t.Fatalf("the announced credentials reach peering %q", entry.id)
	}
}

// The connection is the peering's lifetime. This is what stdin closing used to
// do, and losing it would mean an api that died left a live WireGuard session
// into a customer's network behind.
func TestClosingTheConnectionTakesThePeeringDown(t *testing.T) {
	control, peerings, _ := testControl(t)
	client := dialControl(t, control)

	greet(t, client, "tunnel-under-test")
	if _, err := bufio.NewReader(client).ReadString('\n'); err != nil {
		t.Fatalf("listening: %v", err)
	}
	waitForCount(t, peerings, 1)

	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	waitForCount(t, peerings, 0)
}

// One peering ending must not touch another, which is the property a shared
// process has to earn and a process per peering got for free.
func TestOnePeeringEndingLeavesTheOthersUp(t *testing.T) {
	control, peerings, _ := testControl(t)

	first := dialControl(t, control)
	greet(t, first, "first-peering")
	if _, err := bufio.NewReader(first).ReadString('\n'); err != nil {
		t.Fatalf("first listening: %v", err)
	}

	second := dialControl(t, control)
	greet(t, second, "second-peering")
	secondReader := bufio.NewReader(second)
	if _, err := secondReader.ReadString('\n'); err != nil {
		t.Fatalf("second listening: %v", err)
	}
	waitForCount(t, peerings, 2)

	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	waitForCount(t, peerings, 1)

	// The survivor is still serving: a command it would answer is answered rather
	// than met with a closed socket.
	if _, err := second.Write([]byte("{\"cmd\":\"handshake\"}\n")); err != nil {
		t.Fatalf("the surviving peering's connection is gone: %v", err)
	}
}

// A platform prober speaking HTTP at every open port it finds is what this port
// actually receives most of, and each one used to write a line — about once a
// second on Render, which buried everything else in the container's log.
func TestControlIgnoresAPortProbeWithoutSayingAnything(t *testing.T) {
	control, peerings, logged := testControl(t)
	client := dialControl(t, control)

	if _, err := client.Write([]byte("HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n")); err != nil {
		t.Fatalf("probe: %v", err)
	}

	// Closed, and nothing written back: a caller that is not the api learns
	// nothing about what this service is.
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered an HTTP probe")
	}
	if peerings.count() != 0 {
		t.Fatalf("a probe left %d peerings", peerings.count())
	}
	// The point of the fix: silence.
	if lines := logged.all(); len(lines) != 0 {
		t.Fatalf("a probe was logged: %q", lines)
	}
}

// The other half — a greeting that IS this protocol and still wrong means an api
// disagreeing with this build, and that stays visible.
func TestControlStillLogsAGreetingItCouldNotRead(t *testing.T) {
	control, _, logged := testControl(t)
	client := dialControl(t, control)

	if _, err := client.Write([]byte("{\"id\":\"x\",\"nonsense\":true}\n")); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered a greeting it could not read")
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(logged.all()) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("an unreadable greeting was not logged")
}
