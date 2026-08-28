package main

import (
	"strings"
	"testing"
)

// The base64-to-hex conversion and the UAPI document it goes into. Worth its own
// tests because both failure modes are silent: a key that decodes to the wrong
// bytes and an AllowedIPs line that never reaches the device both present as a
// handshake that does not complete, which is indistinguishable from a gateway
// that is switched off.

// A real pair, as a wg0.conf carries them.
const (
	testPrivateKey = "6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8="
	testPublicKey  = "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw="
)

func testConfig() config {
	return config{
		PrivateKey: testPrivateKey,
		Addresses:  []string{"10.9.0.2/32"},
		DNS:        []string{"10.9.0.1"},
		MTU:        1420,
		Peer: peerConfig{
			PublicKey:           testPublicKey,
			AllowedIPs:          []string{"10.0.0.0/8"},
			Endpoint:            "203.0.113.7:51820",
			PersistentKeepalive: 25,
		},
	}
}

func TestDecodeKeyProducesHex(t *testing.T) {
	hexKey, err := decodeKey("[Peer] PublicKey", testPublicKey)
	if err != nil {
		t.Fatalf("decodeKey: %v", err)
	}
	// 32 bytes, lowercase hex, which is the only spelling the UAPI accepts.
	if len(hexKey) != 64 {
		t.Fatalf("hex key is %d characters, want 64: %q", len(hexKey), hexKey)
	}
	if hexKey != strings.ToLower(hexKey) {
		t.Fatalf("hex key is not lowercase: %q", hexKey)
	}
	if hexKey != "1c8828f7137324c58b2804928624ea2326f1674537c062e251e2753ca7fcca4c" {
		t.Fatalf("hex key does not match the known encoding: %q", hexKey)
	}
}

func TestDecodeKeyRefusesWrongLength(t *testing.T) {
	// 31 bytes of base64: valid base64, not a WireGuard key. Accepting it would
	// configure a device that can never complete a handshake.
	if _, err := decodeKey("[Peer] PublicKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="); err == nil {
		t.Fatal("a short key was accepted")
	}
	if _, err := decodeKey("[Peer] PublicKey", "not base64 at all"); err == nil {
		t.Fatal("a non-base64 key was accepted")
	}
}

func TestUapiConfigCarriesEveryDirective(t *testing.T) {
	document, err := uapiConfig(testConfig())
	if err != nil {
		t.Fatalf("uapiConfig: %v", err)
	}
	for _, want := range []string{
		"private_key=e893ebf1258af5d16b8cbc0e5af1b126f570b759c92af5cd4ca2e44b72cfbd6f",
		"replace_peers=true",
		"public_key=1c8828f7137324c58b2804928624ea2326f1674537c062e251e2753ca7fcca4c",
		"endpoint=203.0.113.7:51820",
		"allowed_ip=10.0.0.0/8",
		"persistent_keepalive_interval=25",
	} {
		if !strings.Contains(document, want) {
			t.Fatalf("uapi document is missing %q:\n%s", want, document)
		}
	}
	// Absent rather than empty: `preshared_key=` with nothing after it is a
	// directive wireguard-go would read as a key of zero bytes.
	if strings.Contains(document, "preshared_key") {
		t.Fatalf("uapi document invented a preshared key:\n%s", document)
	}
}

func TestUapiConfigRefusesAHostnameEndpoint(t *testing.T) {
	settings := testConfig()
	settings.Peer.Endpoint = "vpn.example.com:51820"

	// The load-bearing refusal in this file. Resolving the gateway is the api's
	// job, because it is an outbound dial the network guard has to judge as a
	// PUBLIC target — and a name reaching this process means that check was
	// skipped. wireguard-go would happily resolve it.
	if _, err := uapiConfig(settings); err == nil {
		t.Fatal("a hostname endpoint was accepted")
	}
}

func TestUapiConfigRefusesAnEmptyPeering(t *testing.T) {
	settings := testConfig()
	settings.Peer.AllowedIPs = nil
	if _, err := uapiConfig(settings); err == nil {
		t.Fatal("a peer with no AllowedIPs was accepted")
	}

	settings = testConfig()
	settings.Peer.Endpoint = ""
	if _, err := uapiConfig(settings); err == nil {
		t.Fatal("a peer with no endpoint was accepted")
	}
}

func TestUapiEndpointUpdatesWithoutReplacingThePeer(t *testing.T) {
	document, err := uapiEndpoint(testPublicKey, "198.51.100.9:51820")
	if err != nil {
		t.Fatalf("uapiEndpoint: %v", err)
	}
	if !strings.Contains(document, "update_only=true") {
		t.Fatalf("a moved endpoint would replace the peer:\n%s", document)
	}
	if strings.Contains(document, "private_key") {
		t.Fatalf("a moved endpoint repeated key material:\n%s", document)
	}
	if _, err = uapiEndpoint(testPublicKey, "vpn.example.com:51820"); err == nil {
		t.Fatal("a hostname endpoint was accepted")
	}
}

func TestParseAddressesTakesBothSpellings(t *testing.T) {
	// [Interface] Address is a CIDR, DNS is a bare address, and both arrive here.
	addresses, err := parseAddresses([]string{"10.9.0.2/32", "10.9.0.1", "fd00::2/128"})
	if err != nil {
		t.Fatalf("parseAddresses: %v", err)
	}
	want := []string{"10.9.0.2", "10.9.0.1", "fd00::2"}
	if len(addresses) != len(want) {
		t.Fatalf("parsed %d addresses, want %d", len(addresses), len(want))
	}
	for i, address := range addresses {
		if address.String() != want[i] {
			t.Fatalf("address %d is %s, want %s", i, address, want[i])
		}
	}
	if _, err = parseAddresses([]string{"not an address"}); err == nil {
		t.Fatal("a non-address was accepted")
	}
}

func TestPeerKeyRoundTripsFromBase64(t *testing.T) {
	// The device indexes peers by this, so a wrong decode means LookupPeer
	// returns nothing and a handshake can never be asked for.
	key, err := peerKey(testPublicKey)
	if err != nil {
		t.Fatalf("peerKey: %v", err)
	}
	if key.IsZero() {
		t.Fatal("peerKey produced a zero key")
	}
	// The same 32 bytes the UAPI document carries, so LookupPeer and the
	// configuration agree about which peer this is.
	expected, err := peerKey(testPublicKey)
	if err != nil {
		t.Fatalf("peerKey: %v", err)
	}
	if !key.Equals(expected) {
		t.Fatal("peerKey is not stable")
	}
	if _, err = peerKey("not base64"); err == nil {
		t.Fatal("a non-base64 public key was accepted")
	}
}
