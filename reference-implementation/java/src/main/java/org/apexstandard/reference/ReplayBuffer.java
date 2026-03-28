package org.apexstandard.reference;

import java.util.ArrayList;
import java.util.List;

/**
 * Fixed 1000-event ring buffer for SSE event replay.
 * Stores events with monotonically increasing integer IDs and supports
 * replay-after-cursor semantics for session resumability.
 */
final class ReplayBuffer {
    private static final int MAX_SIZE = 1000;

    private final ArrayList<StoredEvent> events = new ArrayList<>();
    private int nextId = 1;

    record StoredEvent(int id, String streamId, Object message) {
    }

    record ReplayResult(boolean success, List<StoredEvent> events, String reason, Integer lastAvailableId) {
        static ReplayResult ok(List<StoredEvent> events) {
            return new ReplayResult(true, events, null, null);
        }

        static ReplayResult failed(String reason, int lastAvailableId) {
            return new ReplayResult(false, List.of(), reason, lastAvailableId);
        }
    }

    synchronized String store(String streamId, Object message) {
        int id = nextId++;
        events.add(new StoredEvent(id, streamId, message));
        if (events.size() > MAX_SIZE) {
            events.remove(0);
        }
        return String.valueOf(id);
    }

    synchronized ReplayResult replayAfter(String lastEventId) {
        int cursorId;
        try {
            cursorId = Integer.parseInt(lastEventId);
        } catch (NumberFormatException e) {
            int lastAvail = events.isEmpty() ? 0 : events.get(events.size() - 1).id();
            return ReplayResult.failed("Invalid Last-Event-ID: " + lastEventId, lastAvail);
        }

        if (events.isEmpty()) {
            return ReplayResult.ok(List.of());
        }

        int oldestId = events.get(0).id();
        int newestId = events.get(events.size() - 1).id();

        // If cursor is older than the oldest buffered event, replay has failed
        if (cursorId < oldestId) {
            return ReplayResult.failed(
                "Events before this point have been evicted from the replay buffer",
                newestId
            );
        }

        // Find events strictly after the cursor
        List<StoredEvent> result = new ArrayList<>();
        for (StoredEvent event : events) {
            if (event.id() > cursorId) {
                result.add(event);
            }
        }
        return ReplayResult.ok(result);
    }

    synchronized int getNextId() {
        return nextId;
    }
}
