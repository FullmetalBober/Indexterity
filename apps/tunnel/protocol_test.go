package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The pipe is a contract with the api, so what is pinned here is the wire: the
// exact field names the TypeScript side reads, and the fact that an event
// carries nothing it has no business carrying.

func TestEventsSerializeAsTheApiReadsThem(t *testing.T) {
	cases := []struct {
		name  string
		event event
		want  string
	}{
		{
			name:  "listening",
			event: newListening(34567, "user", "pass"),
			want:  `{"type":"listening","port":34567,"username":"user","password":"pass"}`,
		},
		{
			name:  "state",
			event: newState(string(stateUp)),
			want:  `{"type":"state","state":"up"}`,
		},
		{
			name:  "handshake",
			event: newHandshake(0.25),
			want:  `{"type":"handshake","ageSeconds":0.25}`,
		},
		{
			name:  "resolved",
			event: newResolved("7", []string{"10.1.2.3"}),
			want:  `{"type":"resolved","id":"7","addresses":["10.1.2.3"]}`,
		},
		{
			name:  "failed",
			event: newFailed("7", "does not resolve"),
			want:  `{"type":"failed","id":"7","message":"does not resolve"}`,
		},
		{
			name:  "dialRequest",
			event: newDialRequest("7", "db.internal", 27017),
			want:  `{"type":"dialRequest","id":"7","host":"db.internal","port":27017}`,
		},
		{
			name:  "error",
			event: newError("the gateway is not answering"),
			want:  `{"type":"error","message":"the gateway is not answering"}`,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := json.Marshal(testCase.event)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(encoded) != testCase.want {
				t.Fatalf("\n got %s\nwant %s", encoded, testCase.want)
			}
		})
	}
}

func TestEventWriterEmitsOnePerLineAndFlushes(t *testing.T) {
	var out strings.Builder
	writer := newEventWriter(&out)

	if err := writer.emit(newState(string(stateHandshaking))); err != nil {
		t.Fatalf("emit: %v", err)
	}
	// Flushed per event rather than at exit: an event sitting in a buffer is one
	// the api is waiting for, and Test waits for exactly one of these.
	if out.String() != `{"type":"state","state":"handshaking"}`+"\n" {
		t.Fatalf("first line is %q", out.String())
	}

	if err := writer.emit(newError("second")); err != nil {
		t.Fatalf("emit: %v", err)
	}
	if lines := strings.Count(out.String(), "\n"); lines != 2 {
		t.Fatalf("wrote %d lines, want 2:\n%s", lines, out.String())
	}
}

func TestConfigRefusesFieldsItDoesNotKnow(t *testing.T) {
	// The api and this binary are versioned together but deployed as two files.
	// A field one side sets and the other silently drops is how a tunnel comes up
	// carrying an AllowedIPs nobody chose.
	decoder := json.NewDecoder(strings.NewReader(`{"privateKey":"x","allowedIps":["10.0.0.0/8"]}`))
	decoder.DisallowUnknownFields()
	var settings config
	if err := decoder.Decode(&settings); err == nil {
		t.Fatal("a misplaced field was accepted")
	}
}

func TestCommandsParse(t *testing.T) {
	cases := map[string]command{
		`{"cmd":"handshake"}`:                                        {Cmd: cmdHandshake},
		`{"cmd":"resolve","id":"3","host":"db.internal"}`:            {Cmd: cmdResolve, ID: "3", Host: "db.internal"},
		`{"cmd":"dialAllow","id":"4","address":"10.1.2.3:27017"}`:    {Cmd: cmdDialAllow, ID: "4", Address: "10.1.2.3:27017"},
		`{"cmd":"dialDeny","id":"5","message":"outside AllowedIPs"}`: {Cmd: cmdDialDeny, ID: "5", Message: "outside AllowedIPs"},
		`{"cmd":"endpoint","endpoint":"198.51.100.9:51820"}`:         {Cmd: cmdEndpoint, Endpoint: "198.51.100.9:51820"},
		`{"cmd":"shutdown"}`:                                         {Cmd: cmdShutdown},
	}
	for line, want := range cases {
		var got command
		if err := json.Unmarshal([]byte(line), &got); err != nil {
			t.Fatalf("unmarshal %s: %v", line, err)
		}
		if got != want {
			t.Fatalf("%s parsed as %+v, want %+v", line, got, want)
		}
	}
}

func TestParseLastHandshake(t *testing.T) {
	// A device that has completed one. The UAPI document is the only place
	// wireguard-go says so, which is why this is parsed rather than read.
	document := strings.Join([]string{
		"private_key=0000",
		"listen_port=51820",
		"public_key=1111",
		"endpoint=203.0.113.7:51820",
		"last_handshake_time_sec=1787825126",
		"last_handshake_time_nsec=500000000",
		"tx_bytes=148",
		"errno=0",
		"",
	}, "\n")

	at, err := parseLastHandshake(document)
	if err != nil {
		t.Fatalf("parseLastHandshake: %v", err)
	}
	if !at.Equal(time.Unix(1787825126, 500000000)) {
		t.Fatalf("parsed %s", at)
	}
}

func TestParseLastHandshakeTreatsZeroAsNever(t *testing.T) {
	// The ordinary state of a tunnel nobody has needed yet — IDLE on the
	// dashboard, and emphatically not a fault.
	at, err := parseLastHandshake("last_handshake_time_sec=0\nlast_handshake_time_nsec=0\nerrno=0\n")
	if err != nil {
		t.Fatalf("parseLastHandshake: %v", err)
	}
	if !at.IsZero() {
		t.Fatalf("a device with no handshake reported %s", at)
	}

	// A document with no such line at all — a device with no peer.
	at, err = parseLastHandshake("private_key=0000\nerrno=0\n")
	if err != nil {
		t.Fatalf("parseLastHandshake: %v", err)
	}
	if !at.IsZero() {
		t.Fatalf("a device with no peer reported %s", at)
	}
}

func TestParseLastHandshakeRefusesNonsense(t *testing.T) {
	if _, err := parseLastHandshake("last_handshake_time_sec=soon\n"); err == nil {
		t.Fatal("a non-numeric handshake time was accepted")
	}
}
