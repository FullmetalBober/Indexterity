package main

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"golang.zx2c4.com/wireguard/device"
)

// A wg0.conf carries keys in base64; wireguard-go's UAPI takes them in hex.
// That conversion is the only representation change this process makes, and it
// is the one place a silent mistake would be expensive: a key that decodes to
// the wrong 32 bytes fails as a handshake that never completes, which is
// indistinguishable from a gateway that is switched off.

const keyLength = 32

func decodeKey(name, value string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", fmt.Errorf("%s is not base64: %w", name, err)
	}
	if len(raw) != keyLength {
		return "", fmt.Errorf("%s decodes to %d bytes, want %d", name, len(raw), keyLength)
	}
	return hex.EncodeToString(raw), nil
}

// The UAPI document that configures the device, built from a config the api has
// already validated.
//
// `replace_peers=true` because this is the whole configuration of a
// single-peer device, and an update that added a second peer would mean two
// tunnels sharing one netstack — which is the collision the per-tunnel design
// exists to prevent.
func uapiConfig(c config) (string, error) {
	privateKey, err := decodeKey("[Interface] PrivateKey", c.PrivateKey)
	if err != nil {
		return "", err
	}
	publicKey, err := decodeKey("[Peer] PublicKey", c.Peer.PublicKey)
	if err != nil {
		return "", err
	}

	var out strings.Builder
	// strings.Builder's Write* never returns an error (its own doc says so), and
	// it is the only writer used here for that reason — every other writer in
	// this process has its error checked.
	//
	// A directive at a time rather than one concatenated string per line. The
	// concatenation allocated a temporary for the builder to copy, which is what
	// gopls objects to, and a helper says the shape once instead of six times.
	line := func(key, value string) {
		out.WriteString(key)
		out.WriteString("=")
		out.WriteString(value)
		out.WriteString("\n")
	}

	line("private_key", privateKey)
	line("replace_peers", "true")
	line("public_key", publicKey)
	if c.Peer.PresharedKey != "" {
		presharedKey, keyErr := decodeKey("[Peer] PresharedKey", c.Peer.PresharedKey)
		if keyErr != nil {
			return "", keyErr
		}
		line("preshared_key", presharedKey)
	}
	if c.Peer.Endpoint == "" {
		return "", fmt.Errorf("[Peer] Endpoint is empty — the api resolves and vets it before this")
	}
	// Refused here as well as in the api, because an endpoint that is not an
	// address means this process would resolve it, and resolving the gateway is
	// the api's job: it is an outbound dial the network guard has to judge.
	if _, err = netip.ParseAddrPort(c.Peer.Endpoint); err != nil {
		return "", fmt.Errorf("[Peer] Endpoint %q is not an ip:port: %w", c.Peer.Endpoint, err)
	}
	line("endpoint", c.Peer.Endpoint)
	if len(c.Peer.AllowedIPs) == 0 {
		return "", fmt.Errorf("[Peer] AllowedIPs is empty — the tunnel could carry nothing")
	}
	for _, cidr := range c.Peer.AllowedIPs {
		prefix, prefixErr := netip.ParsePrefix(strings.TrimSpace(cidr))
		if prefixErr != nil {
			return "", fmt.Errorf("[Peer] AllowedIPs %q is not a CIDR: %w", cidr, prefixErr)
		}
		line("allowed_ip", prefix.String())
	}
	if c.Peer.PersistentKeepalive > 0 {
		line("persistent_keepalive_interval", strconv.Itoa(c.Peer.PersistentKeepalive))
	}
	return out.String(), nil
}

// Moving a gateway that has changed address, as one on dynamic DNS does.
// `update_only=true` so it amends the peer this device already has rather than
// adding a second one, and no key material is repeated.
func uapiEndpoint(publicKeyBase64, endpoint string) (string, error) {
	publicKey, err := decodeKey("[Peer] PublicKey", publicKeyBase64)
	if err != nil {
		return "", err
	}
	if _, err = netip.ParseAddrPort(endpoint); err != nil {
		return "", fmt.Errorf("endpoint %q is not an ip:port: %w", endpoint, err)
	}
	return "public_key=" + publicKey + "\nupdate_only=true\nendpoint=" + endpoint + "\n", nil
}

// The interface addresses and resolvers, as gvisor's stack wants them.
func parseAddresses(values []string) ([]netip.Addr, error) {
	addresses := make([]netip.Addr, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		// An [Interface] Address is a CIDR and a DNS line is a bare address, so
		// both spellings are accepted here rather than in two near-identical
		// functions.
		if prefix, err := netip.ParsePrefix(trimmed); err == nil {
			addresses = append(addresses, prefix.Addr())
			continue
		}
		address, err := netip.ParseAddr(trimmed)
		if err != nil {
			return nil, fmt.Errorf("%q is not an address: %w", value, err)
		}
		addresses = append(addresses, address)
	}
	return addresses, nil
}

// The peer's public key, in the form the device indexes peers by.
//
// Needed because a handshake is forced through the device's own peer handle
// rather than by sending traffic — see tunnel.handshake().
func peerKey(publicKeyBase64 string) (device.NoisePublicKey, error) {
	var key device.NoisePublicKey
	hexKey, err := decodeKey("[Peer] PublicKey", publicKeyBase64)
	if err != nil {
		return key, err
	}
	if err = key.FromHex(hexKey); err != nil {
		return key, fmt.Errorf("[Peer] PublicKey is not a usable key: %w", err)
	}
	return key, nil
}
