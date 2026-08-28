package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"sync"
)

// One customer's peering, and the set of them this process is holding.
//
// This is the shape that replaces "the process IS one tunnel". The service holds
// many devices at once, so everything that used to be a package-level singleton
// — the device, its pending dial verdicts, the connection its events go back on
// — is a field here, and the SOCKS5 listener is shared by all of them.
//
// What separates two customers is therefore no longer a process boundary. It is
// still a stack boundary: each peering gets its own gvisor netstack from
// netstack.CreateNetTUN, so two customers who both use 10.0.0.0/8 remain a
// non-question rather than a routing conflict. What is genuinely given up by
// holding them together — every private key in one address space, and one crash
// taking every peering down — is on the record in D112.

// A peering, from the moment its control connection is accepted to the moment it
// closes.
type peering struct {
	// The name the api knows this peering by, echoed into every event so one
	// connection's log lines are attributable. Not a secret.
	id string

	device *tunnel
	// Dials waiting for the api to allow or refuse them.
	verdicts *verdicts
	// Events go back on THIS peering's control connection and no other. A
	// dialRequest delivered to the wrong api connection would be answered by an
	// api reasoning about a different customer's AllowedIPs.
	emit func(event) error

	// SOCKS5 credentials, which now do two jobs: they authenticate the caller,
	// and the username is what selects this peering out of the registry. That is
	// why they are generated per peering and never derived from anything the api
	// sends — a guessable username would be a route into someone else's network.
	username string
	password string
}

// Constant-time, because the password is compared against one an untrusted
// caller supplies and a length-or-prefix leak here is a leak about a credential
// that fronts a customer's private network.
func (p *peering) authenticates(username, password string) bool {
	return subtle.ConstantTimeCompare([]byte(p.username), []byte(username)) == 1 &&
		subtle.ConstantTimeCompare([]byte(p.password), []byte(password)) == 1
}

// Every peering this process holds, keyed by the SOCKS5 username that selects
// it.
//
// Keyed by username rather than by id because the lookup that has to be fast and
// unambiguous is the one on the data path: a SOCKS5 greeting arrives carrying
// only credentials, and the device it belongs to has to be found from those
// alone. The id is carried on the peering for the events.
type registry struct {
	mu       sync.RWMutex
	peerings map[string]*peering
}

func newRegistry() *registry {
	return &registry{peerings: make(map[string]*peering)}
}

// Generates the credentials as well as registering, so no caller can register a
// peering whose username it chose.
func (r *registry) add(id string, device *tunnel, v *verdicts, emit func(event) error) (*peering, error) {
	username, err := secret()
	if err != nil {
		return nil, err
	}
	password, err := secret()
	if err != nil {
		return nil, err
	}

	entry := &peering{
		id:       id,
		device:   device,
		verdicts: v,
		emit:     emit,
		username: username,
		password: password,
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	// 24 random bytes, so this cannot happen. Checked anyway: silently replacing
	// a live peering would hand its next dial to another customer's device.
	if _, taken := r.peerings[username]; taken {
		return nil, fmt.Errorf("a peering already holds that credential")
	}
	r.peerings[username] = entry
	return entry, nil
}

func (r *registry) remove(entry *peering) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peerings, entry.username)
}

// The peering a SOCKS5 caller has authenticated as, or nil.
//
// The username is looked up first and the password compared in constant time
// against that one peering. A wrong username therefore costs no comparison at
// all, which is fine: a username is not a secret worth hiding the existence of,
// and the password is what the caller must actually have.
func (r *registry) authenticate(username, password string) *peering {
	r.mu.RLock()
	entry := r.peerings[username]
	r.mu.RUnlock()
	if entry == nil {
		return nil
	}
	if !entry.authenticates(username, password) {
		return nil
	}
	return entry
}

func (r *registry) count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peerings)
}

func secret() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("could not generate a credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
