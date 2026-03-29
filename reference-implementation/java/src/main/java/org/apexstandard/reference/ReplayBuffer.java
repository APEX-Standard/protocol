package org.apexstandard.reference;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Acknowledgment-driven replay buffer for SSE events.
 * Stores up to 10000 events with monotonically increasing integer IDs.
 * Supports acknowledgment-based pruning and gap-fill classification
 * during replay (required events replayed verbatim, elided events
 * collapsed into gap_fill notifications).
 */
final class ReplayBuffer {
    private static final int MAX_SIZE = 10000;

    private static final Set<String> REQUIRED_METHODS = Set.of(
        "notifications/apex.order.filled",
        "notifications/apex.order.partially_filled",
        "notifications/apex.order.rejected",
        "notifications/apex.risk.kill_switch_engaged"
    );

    private final ArrayList<StoredEvent> events = new ArrayList<>();
    private int nextId = 1;
    private int acknowledgedThroughId = 0;

    record StoredEvent(int id, String streamId, Object message) {
    }

    /**
     * A replay item: either a verbatim event or a gap_fill notification
     * that summarises a run of elided events.
     */
    record ReplayItem(int id, Object message) {
    }

    record ReplayResult(boolean success, List<ReplayItem> items, String reason, Integer lastAvailableId) {
        static ReplayResult ok(List<ReplayItem> items) {
            return new ReplayResult(true, items, null, null);
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

    synchronized Map<String, Object> acknowledge(String lastEventId) {
        int targetId;
        try {
            targetId = Integer.parseInt(lastEventId);
        } catch (NumberFormatException e) {
            targetId = 0;
        }
        acknowledgedThroughId = Math.max(acknowledgedThroughId, targetId);
        Iterator<StoredEvent> it = events.iterator();
        while (it.hasNext()) {
            if (it.next().id <= acknowledgedThroughId) {
                it.remove();
            } else {
                break;
            }
        }
        return Map.of(
            "acknowledged_through", String.valueOf(acknowledgedThroughId),
            "buffer_depth", events.size()
        );
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
            return ReplayResult.failed("event_id_outside_log", newestId);
        }

        // Collect events strictly after the cursor
        List<StoredEvent> afterCursor = new ArrayList<>();
        for (StoredEvent event : events) {
            if (event.id() > cursorId) {
                afterCursor.add(event);
            }
        }

        // Classify into required (verbatim) and elided (gap_fill) runs
        List<ReplayItem> items = new ArrayList<>();
        int gapFromId = -1;
        int gapToId = -1;
        int gapCount = 0;

        for (StoredEvent event : afterCursor) {
            String method = extractMethod(event.message);
            if (REQUIRED_METHODS.contains(method)) {
                // Flush any pending gap_fill run first
                if (gapCount > 0) {
                    items.add(buildGapFill(gapFromId, gapToId, gapCount));
                    gapFromId = -1;
                    gapToId = -1;
                    gapCount = 0;
                }
                // Emit required event verbatim with original ID
                items.add(new ReplayItem(event.id(), event.message()));
            } else {
                // Accumulate elided run
                if (gapCount == 0) {
                    gapFromId = event.id();
                }
                gapToId = event.id();
                gapCount++;
            }
        }

        // Flush trailing gap_fill run
        if (gapCount > 0) {
            items.add(buildGapFill(gapFromId, gapToId, gapCount));
        }

        return ReplayResult.ok(items);
    }

    synchronized int getNextId() {
        return nextId;
    }

    /* ------------------------------------------------------------------ */
    /*  Internal helpers                                                    */
    /* ------------------------------------------------------------------ */

    @SuppressWarnings("unchecked")
    private static String extractMethod(Object message) {
        if (message instanceof Map<?, ?> map) {
            Object method = map.get("method");
            return method != null ? method.toString() : "";
        }
        return "";
    }

    private static ReplayItem buildGapFill(int fromId, int toId, int elidedCount) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("from_id", String.valueOf(fromId));
        params.put("to_id", String.valueOf(toId));
        params.put("elided_count", elidedCount);

        Map<String, Object> gapFill = new LinkedHashMap<>();
        gapFill.put("jsonrpc", "2.0");
        gapFill.put("method", "notifications/apex.session.gap_fill");
        gapFill.put("params", params);

        // Use toId as the event id for the gap_fill so the client's
        // cursor advances past all elided events.
        return new ReplayItem(toId, gapFill);
    }
}
