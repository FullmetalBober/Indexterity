package main

import (
	"bufio"
	"encoding/json"
	"net"
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

const testToken = "a-shared-secret-the-api-was-given"

func testControl(t *testing.T) (*controlServer, *registry) {
	t.Helper()
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

	control, err := startControl("127.0.0.1:0", testToken, peerings, port, stderrLogger(), func(message string) {
		t.Logf("control: %s", message)
	})
	if err != nil {
		t.Fatalf("startControl: %v", err)
	}
	t.Cleanup(func() { _ = control.close() })
	go control.serve(t.Context())
	return control, peerings
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

func greet(t *testing.T, client net.Conn, token string) {
	t.Helper()
	line, err := json.Marshal(hello{Token: token, ID: "tunnel-under-test", Config: testConfig()})
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

func TestControlRefusesAGreetingWithTheWrongToken(t *testing.T) {
	control, peerings := testControl(t)
	client := dialControl(t, control)

	greet(t, client, "not-the-token")

	// Refused by closing, with nothing written back: a caller that cannot
	// authenticate is told nothing about what this service is or holds.
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered a greeting it should have refused")
	}
	if peerings.count() != 0 {
		t.Fatalf("a refused greeting left %d peerings", peerings.count())
	}
}

func TestControlRefusesAGreetingWithNoToken(t *testing.T) {
	control, peerings := testControl(t)
	client := dialControl(t, control)

	// The shape a caller that has found the port but not the secret would send.
	if _, err := client.Write([]byte("{\"id\":\"x\",\"config\":{}}\n")); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	if _, err := bufio.NewReader(client).ReadString('\n'); err == nil {
		t.Fatal("the service answered a greeting carrying no token")
	}
	if peerings.count() != 0 {
		t.Fatalf("a refused greeting left %d peerings", peerings.count())
	}
}

func TestControlAnnouncesTheSharedSocksPortAndThePeeringsOwnCredentials(t *testing.T) {
	control, peerings := testControl(t)
	client := dialControl(t, control)

	greet(t, client, testToken)

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
	control, peerings := testControl(t)
	client := dialControl(t, control)

	greet(t, client, testToken)
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
	control, peerings := testControl(t)

	first := dialControl(t, control)
	greet(t, first, testToken)
	if _, err := bufio.NewReader(first).ReadString('\n'); err != nil {
		t.Fatalf("first listening: %v", err)
	}

	second := dialControl(t, control)
	greet(t, second, testToken)
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
