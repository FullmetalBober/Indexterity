package main

import "testing"

// Credential routing, which is what replaces the process boundary.
//
// When each peering was its own process, a caller that authenticated reached the
// only device there was. Now one process holds many, and the thing that decides
// WHICH one is the credential — so these tests are the isolation property itself,
// not a detail of it.

func testPeering(t *testing.T, peerings *registry, id string) *peering {
	t.Helper()
	entry, err := peerings.add(id, nil, newVerdicts(), func(event) error { return nil })
	if err != nil {
		t.Fatalf("add %s: %v", id, err)
	}
	return entry
}

func TestRegistryRoutesEachCredentialToItsOwnPeering(t *testing.T) {
	peerings := newRegistry()
	first := testPeering(t, peerings, "first")
	second := testPeering(t, peerings, "second")

	if first.username == second.username || first.password == second.password {
		t.Fatal("two peerings were given the same credential")
	}

	// The whole of the refactor's isolation claim: a credential reaches the one
	// peering it belongs to. If this crosses, one customer's driver dials through
	// another customer's gateway.
	if got := peerings.authenticate(first.username, first.password); got != first {
		t.Fatalf("the first credential reached %v", got)
	}
	if got := peerings.authenticate(second.username, second.password); got != second {
		t.Fatalf("the second credential reached %v", got)
	}

	// Halves of two different peerings' credentials, which is the shape a
	// crossed-wires bug would present as.
	if got := peerings.authenticate(first.username, second.password); got != nil {
		t.Fatalf("a mixed credential reached %v", got)
	}
}

func TestRegistryRefusesAWrongPassword(t *testing.T) {
	peerings := newRegistry()
	entry := testPeering(t, peerings, "only")

	if got := peerings.authenticate(entry.username, "wrong"); got != nil {
		t.Fatal("a wrong password authenticated")
	}
	if got := peerings.authenticate("wrong", entry.password); got != nil {
		t.Fatal("a wrong username authenticated")
	}
	if got := peerings.authenticate("", ""); got != nil {
		t.Fatal("empty credentials authenticated")
	}
}

// A peering whose connection has gone must stop being reachable BEFORE its
// device is closed, or a SOCKS5 caller can authenticate into a stack that is
// being torn down.
func TestRegistryStopsRoutingToARemovedPeering(t *testing.T) {
	peerings := newRegistry()
	entry := testPeering(t, peerings, "going")
	if peerings.count() != 1 {
		t.Fatalf("count is %d, want 1", peerings.count())
	}

	peerings.remove(entry)

	if got := peerings.authenticate(entry.username, entry.password); got != nil {
		t.Fatal("a removed peering still authenticates")
	}
	if peerings.count() != 0 {
		t.Fatalf("count is %d after removal, want 0", peerings.count())
	}
	// Removing twice is what happens when a session ends while the service is
	// shutting down. It must not panic or resurrect anything.
	peerings.remove(entry)
	if peerings.count() != 0 {
		t.Fatalf("count is %d after a second removal, want 0", peerings.count())
	}
}
