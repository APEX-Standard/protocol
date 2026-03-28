package main

import (
	"fmt"
	"sync"
)

const maxBufferSize = 1000

// StoredEvent represents a single event stored in the replay buffer.
type StoredEvent struct {
	ID       int
	StreamID string
	Message  map[string]any
}

// ReplayBuffer is a fixed-size ring buffer that stores SSE events for replay.
type ReplayBuffer struct {
	mu     sync.Mutex
	events []StoredEvent
	nextID int
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

// ReplayAfter returns all events after the given lastEventId.
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
