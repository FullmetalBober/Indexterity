package main

import (
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"
)

// The SOCKS5 front end, exercised over a real socket pair but with no tunnel
// behind it. What is pinned is the half that decides whether a connection may be
// made at all: the credentials, the request parsing, and — the load-bearing one
// — that a name is passed to the api verbatim rather than resolved here.

// A server holding one peering with no device behind it: every test below ends
// before a dial is attempted, either at authentication, at parsing, or at the
// verdict.
//
// The peering is returned rather than the server's credentials, because the
// server no longer has any — they belong to the peering the caller authenticates
// as, which is the whole of the routing change.
func testServer(t *testing.T) (*socksServer, *peering, chan event) {
	t.Helper()
	emitted := make(chan event, 16)
	peerings := newRegistry()
	entry, err := peerings.add("test-peering", nil, newVerdicts(), func(e event) error {
		emitted <- e
		return nil
	})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	server, err := startSocks("127.0.0.1:0", peerings, func(message string) {
		t.Logf("socks: %s", message)
	})
	if err != nil {
		t.Fatalf("startSocks: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := server.close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	})
	return server, entry, emitted
}

func dialServer(t *testing.T, server *socksServer) net.Conn {
	t.Helper()
	port, err := server.port()
	if err != nil {
		t.Fatalf("port: %v", err)
	}
	client, err := net.Dial("tcp", netip.AddrPortFrom(netip.AddrFrom4([4]byte{127, 0, 0, 1}), port).String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err = client.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	return client
}

// RFC 1928 greeting + RFC 1929 auth, as a driver sends them.
func authenticate(t *testing.T, client net.Conn, username, password string) error {
	t.Helper()
	if _, err := client.Write([]byte{socksVersion, 0x01, methodUserPass}); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(client, reply); err != nil {
		return err
	}
	if reply[1] != methodUserPass {
		t.Fatalf("server chose method %#x", reply[1])
	}

	request := []byte{authVersion, byte(len(username))}
	request = append(request, username...)
	request = append(request, byte(len(password)))
	request = append(request, password...)
	if _, err := client.Write(request); err != nil {
		return err
	}
	status := make([]byte, 2)
	if _, err := io.ReadFull(client, status); err != nil {
		return err
	}
	if status[1] != 0x00 {
		t.Fatalf("authentication was refused with %#x", status[1])
	}
	return nil
}

func connect(t *testing.T, client net.Conn, host string, port uint16) {
	t.Helper()
	request := []byte{socksVersion, commandConnect, 0x00, atypDomain, byte(len(host))}
	request = append(request, host...)
	request = binary.BigEndian.AppendUint16(request, port)
	if _, err := client.Write(request); err != nil {
		t.Fatalf("connect: %v", err)
	}
}

func TestSocksRefusesTheWrongPassword(t *testing.T) {
	server, entry, _ := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	if _, err := client.Write([]byte{socksVersion, 0x01, methodUserPass}); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("greeting reply: %v", err)
	}

	request := []byte{authVersion, byte(len(entry.username))}
	request = append(request, entry.username...)
	request = append(request, byte(len("wrong")))
	request = append(request, "wrong"...)
	if _, err := client.Write(request); err != nil {
		t.Fatalf("auth: %v", err)
	}

	status := make([]byte, 2)
	if _, err := io.ReadFull(client, status); err != nil {
		t.Fatalf("auth reply: %v", err)
	}
	// A loopback proxy into a customer's private network is reachable by every
	// process on the host; the credential is the only thing between them.
	if status[1] == 0x00 {
		t.Fatal("the wrong password was accepted")
	}
}

func TestSocksRefusesACallerOfferingNoAuth(t *testing.T) {
	server, _, _ := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	// Method 0x00 only: "no authentication required".
	if _, err := client.Write([]byte{socksVersion, 0x01, 0x00}); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("greeting reply: %v", err)
	}
	if reply[1] != methodNone {
		t.Fatalf("server offered method %#x to a caller with no credentials", reply[1])
	}
}

func TestSocksAsksTheApiAboutTheNameItWasGiven(t *testing.T) {
	server, entry, emitted := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	if err := authenticate(t, client, entry.username, entry.password); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	connect(t, client, "db.internal", 27017)

	select {
	case e := <-emitted:
		request, ok := e.(dialRequestEvent)
		if !ok {
			t.Fatalf("first event is %T, want a dialRequest", e)
		}
		// Verbatim, unresolved. This process holds no policy and no resolver
		// verdict: the api resolves through the tunnel and judges every answer
		// against the same guard the direct path uses.
		if request.Host != "db.internal" || request.Port != 27017 {
			t.Fatalf("asked about %s:%d", request.Host, request.Port)
		}
		if request.ID == "" {
			t.Fatal("the dial request carries no id to answer")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no dial request was emitted")
	}

	// Nobody waiting is worth saying so: it means the two sides disagree about
	// what is in flight.
	if entry.verdicts.deliver("nobody", verdict{refusal: "no"}) {
		t.Fatal("delivering to an unknown id claimed a waiter")
	}
}

func TestSocksRefusesTheDialTheApiRefuses(t *testing.T) {
	server, entry, emitted := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	if err := authenticate(t, client, entry.username, entry.password); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	connect(t, client, "169.254.169.254", 80)

	var id string
	select {
	case e := <-emitted:
		request, ok := e.(dialRequestEvent)
		if !ok {
			t.Fatalf("first event is %T, want a dialRequest", e)
		}
		id = request.ID
	case <-time.After(5 * time.Second):
		t.Fatal("no dial request was emitted")
	}

	// The guard's own sentence, from the api.
	if !entry.verdicts.deliver(id, verdict{refusal: "cloud metadata — never a database, whatever route reaches it"}) {
		t.Fatal("nothing was waiting for the verdict")
	}

	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if reply[1] != replyNotAllowed {
		t.Fatalf("reply code is %#x, want %#x (not allowed)", reply[1], replyNotAllowed)
	}
}

func TestSocksRefusesBind(t *testing.T) {
	server, entry, _ := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	if err := authenticate(t, client, entry.username, entry.password); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	// A database driver opens outbound connections. A proxy that also listens on
	// a customer's behalf is a different thing with a different threat model.
	const commandBind = 0x02
	if _, err := client.Write([]byte{socksVersion, commandBind, 0x00, atypIPv4, 10, 0, 0, 1, 0, 80}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if reply[1] != replyCommandNotSupported {
		t.Fatalf("reply code is %#x, want %#x", reply[1], replyCommandNotSupported)
	}
}

func TestSocksPassesAnIPLiteralThroughTheSameVerdict(t *testing.T) {
	server, entry, emitted := testServer(t)
	go server.serve(t.Context())
	client := dialServer(t, server)

	if err := authenticate(t, client, entry.username, entry.password); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	// atyp=1, no name to resolve — and it is asked about anyway. An address the
	// api has not judged is an address that has not been checked against
	// AllowedIPs, whatever form it arrived in.
	if _, err := client.Write([]byte{socksVersion, commandConnect, 0x00, atypIPv4, 10, 1, 2, 3, 0x69, 0x89}); err != nil {
		t.Fatalf("connect: %v", err)
	}

	select {
	case e := <-emitted:
		request, ok := e.(dialRequestEvent)
		if !ok {
			t.Fatalf("first event is %T, want a dialRequest", e)
		}
		if request.Host != "10.1.2.3" || request.Port != 27017 {
			t.Fatalf("asked about %s:%d", request.Host, request.Port)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an IP literal was dialled without a verdict")
	}
}
