package main

import (
	"fmt"
	"strconv"
	"sync"
)

const maxBufferSize = 10000

// requiredMethods lists JSON-RPC methods that must be replayed in full
// (not elided into gap_fill summaries) during reconnect replay.
var requiredMethods = map[string]bool{
	"notifications/apex.order.filled":              true,
	"notifications/apex.order.partially_filled":    true,
	"notifications/apex.order.rejected":            true,
	"notifications/apex.risk.kill_switch_engaged":  true,
}

// StoredEvent represents a single event stored in the replay buffer.
type StoredEvent struct {
	ID       int
	StreamID string
	Message  map[string]any
}

// ReplayBuffer is a fixed-size ring buffer that stores SSE events for replay.
type ReplayBuffer struct {
	mu                   sync.Mutex
	events               []StoredEvent
	nextID               int
	acknowledgedThroughID int
}

// NewReplayBuffer creates a new empty replay buffer.
func NewReplayBuffer() *ReplayBuffer {
	return &ReplayBuffer{
		events: make([]StoredEvent, 0, maxBufferSize),
		nextID: 1,
	}
}

// Store adds an event to the buffer and returns its string ID.
func (rb *ReplayBuffer) Store(streamID string, message map[string]any) string {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	id := rb.nextID
	rb.nextID++

	rb.events = append(rb.events, StoredEvent{
		ID:       id,
		StreamID: streamID,
		Message:  message,
	})

	if len(rb.events) > maxBufferSize {
		rb.events = rb.events[1:]
	}

	return fmt.Sprintf("%d", id)
}

// Acknowledge marks events through lastEventID as acknowledged, trimming them
// from the buffer. Returns (acknowledgedThroughID, remaining buffer depth).
func (rb *ReplayBuffer) Acknowledge(lastEventID string) (string, int) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	targetID, err := strconv.Atoi(lastEventID)
	if err != nil {
		return "0", len(rb.events)
	}
	if targetID > rb.acknowledgedThroughID {
		rb.acknowledgedThroughID = targetID
	}
	cutoff := 0
	for i, e := range rb.events {
		if e.ID <= rb.acknowledgedThroughID {
			cutoff = i + 1
		} else {
			break
		}
	}
	if cutoff > 0 {
		rb.events = rb.events[cutoff:]
	}
	return strconv.Itoa(rb.acknowledgedThroughID), len(rb.events)
}

// extractMethod extracts the JSON-RPC "method" field from a stored event message.
func extractMethod(msg map[string]any) string {
	if m, ok := msg["method"]; ok {
		if s, ok := m.(string); ok {
			return s
		}
	}
	return ""
}

// ReplayAfter returns events after the given lastEventId, classifying them
// into required events (replayed in full) and gap_fill summaries for elided events.
// Returns (nil, false) if the lastEventId has been evicted from the buffer.
func (rb *ReplayBuffer) ReplayAfter(lastEventID string) ([]StoredEvent, bool) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	var cursorID int
	if _, err := fmt.Sscanf(lastEventID, "%d", &cursorID); err != nil {
		return nil, false
	}

	if len(rb.events) == 0 {
		return nil, true
	}

	oldestID := rb.events[0].ID

	// If the cursor is older than the oldest event, replay has failed
	if cursorID < oldestID {
		return nil, false
	}

	// Collect events after cursor
	var afterCursor []StoredEvent
	for _, evt := range rb.events {
		if evt.ID > cursorID {
			afterCursor = append(afterCursor, evt)
		}
	}

	if len(afterCursor) == 0 {
		return nil, true
	}

	// Classify into required / elided with gap_fill summaries
	var result []StoredEvent
	var gapFromID, gapToID, gapCount int

	flushGap := func() {
		if gapCount == 0 {
			return
		}
		gapFillID := gapToID
		gapNotif := map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/apex.session.gap_fill",
			"params": map[string]any{
				"elided_count": gapCount,
				"from_id":      gapFromID,
				"to_id":        gapToID,
			},
		}
		result = append(result, StoredEvent{
			ID:       gapFillID,
			StreamID: "default",
			Message:  gapNotif,
		})
		gapCount = 0
	}

	for _, evt := range afterCursor {
		method := extractMethod(evt.Message)
		if requiredMethods[method] {
			// Flush any pending gap before this required event
			flushGap()
			result = append(result, evt)
		} else {
			// Accumulate into gap fill run
			if gapCount == 0 {
				gapFromID = evt.ID
			}
			gapToID = evt.ID
			gapCount++
		}
	}
	// Flush trailing gap
	flushGap()

	return result, true
}

// ReplayAfterRaw returns all events after the given lastEventId without
// gap fill classification. Used internally when raw replay is needed.
func (rb *ReplayBuffer) ReplayAfterRaw(lastEventID string) ([]StoredEvent, bool) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	var cursorID int
	if _, err := fmt.Sscanf(lastEventID, "%d", &cursorID); err != nil {
		return nil, false
	}

	if len(rb.events) == 0 {
		return nil, true
	}

	oldestID := rb.events[0].ID
	if cursorID < oldestID {
		return nil, false
	}

	var result []StoredEvent
	for _, evt := range rb.events {
		if evt.ID > cursorID {
			result = append(result, evt)
		}
	}

	return result, true
}

// LastAvailableID returns the ID of the most recently stored event, or 0 if empty.
func (rb *ReplayBuffer) LastAvailableID() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	if len(rb.events) == 0 {
		return 0
	}
	return rb.events[len(rb.events)-1].ID
}

// OldestID returns the ID of the oldest event in the buffer, or 0 if empty.
func (rb *ReplayBuffer) OldestID() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	if len(rb.events) == 0 {
		return 0
	}
	return rb.events[0].ID
}
