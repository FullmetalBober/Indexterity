package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Reading back what the device knows.
//
// wireguard-go says when a handshake last completed in exactly one place: the
// UAPI document, as `last_handshake_time_sec` and `_nsec`. There is no accessor
// and no event, so this parses the document — which is also why the device is
// polled rather than subscribed to.
//
// One peer per device here, so the first pair found is the answer. A document
// with no such line, or a zero one, means no handshake has completed in this
// process — which is the ordinary state of a tunnel nobody has needed yet, not
// a fault.
func parseLastHandshake(document string) (time.Time, error) {
	var seconds, nanoseconds int64
	var haveSeconds bool

	// SplitSeq rather than Split: the document is every field of the device, and
	// this reads two of them — no reason to allocate a slice of the rest.
	for line := range strings.SplitSeq(document, "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found {
			continue
		}
		switch key {
		case "last_handshake_time_sec":
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return time.Time{}, fmt.Errorf("last_handshake_time_sec %q is not a number: %w", value, err)
			}
			seconds = parsed
			haveSeconds = true
		case "last_handshake_time_nsec":
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return time.Time{}, fmt.Errorf("last_handshake_time_nsec %q is not a number: %w", value, err)
			}
			nanoseconds = parsed
		}
	}

	if !haveSeconds || (seconds == 0 && nanoseconds == 0) {
		return time.Time{}, nil
	}
	return time.Unix(seconds, nanoseconds), nil
}
