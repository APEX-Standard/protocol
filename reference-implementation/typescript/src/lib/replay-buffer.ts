/**
 * SSE Event Replay Buffer for APEX Protocol HTTP/SSE transport.
 *
 * Implements the MCP SDK EventStore interface to support session resumability.
 * Stores up to 10000 events in a fixed-size ring buffer and replays events
 * from a Last-Event-ID cursor on reconnection.  Supports acknowledgment-driven
 * eviction and gap fill classification during replay.
 */

import type {
  EventStore,
  StreamId,
  EventId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MAX_BUFFER_SIZE = 10000;

interface BufferedEvent {
  id: number;
  streamId: StreamId;
  message: JSONRPCMessage;
}

export class ReplayBuffer implements EventStore {
  private _events: BufferedEvent[] = [];
  private _nextId = 1;
  private acknowledgedThroughId = 0;

  /**
   * The stream ID used by the MCP SDK for the standalone GET SSE stream.
   * Only events on this stream are visible to the client for acknowledgment
   * purposes; POST-stream responses (tool call results, priming events) are
   * delivered inline and should not inflate buffer_depth.
   */
  private static readonly STANDALONE_STREAM_ID = "_GET_stream";

  private static readonly REQUIRED_METHODS = new Set([
    "notifications/apex.order.filled",
    "notifications/apex.order.partially_filled",
    "notifications/apex.order.rejected",
    "notifications/apex.risk.kill_switch_engaged",
  ]);

  /**
   * Number of events currently held in the buffer.
   */
  get size(): number {
    return this._events.length;
  }

  /**
   * The ID of the most recently stored event, or undefined if empty.
   */
  get lastEventId(): EventId | undefined {
    if (this._events.length === 0) return undefined;
    return String(this._events[this._events.length - 1].id);
  }

  acknowledge(lastEventId: string): { acknowledged_through: string; buffer_depth: number } {
    const targetId = parseInt(lastEventId, 10);
    if (isNaN(targetId)) {
      return { acknowledged_through: "0", buffer_depth: this._events.length };
    }
    this.acknowledgedThroughId = Math.max(this.acknowledgedThroughId, targetId);
    while (this._events.length > 0 && this._events[0].id <= this.acknowledgedThroughId) {
      this._events.shift();
    }

    // buffer_depth reflects only events the client can observe on the
    // standalone GET SSE stream (notifications).  POST-stream events
    // (tool call JSON-RPC responses, priming events) are delivered via
    // the HTTP response to each POST and are not part of the
    // notification stream the client acknowledges.
    const notificationDepth = this._events.filter(
      (e) => e.streamId === ReplayBuffer.STANDALONE_STREAM_ID,
    ).length;

    return {
      acknowledged_through: String(this.acknowledgedThroughId),
      buffer_depth: notificationDepth,
    };
  }

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage,
  ): Promise<EventId> {
    const id = this._nextId++;
    this._events.push({ id, streamId, message });

    if (this._events.length > MAX_BUFFER_SIZE) {
      this._events.shift();
    }

    return String(id);
  }

  async getStreamIdForEventId(
    eventId: EventId,
  ): Promise<StreamId | undefined> {
    const numericId = parseInt(eventId, 10);
    if (Number.isNaN(numericId)) return undefined;

    const event = this._events.find((e) => e.id === numericId);
    if (event) return event.streamId;

    // The event was evicted from the buffer but its ID is still a valid
    // numeric cursor.  Return the stream ID of the oldest buffered event
    // so the SDK proceeds to call replayEventsAfter, which will emit
    // a replay_failed notification for the client.
    if (this._events.length > 0 && numericId < this._events[0].id) {
      return this._events[0].streamId;
    }

    return undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const cursorId = parseInt(lastEventId, 10);

    if (Number.isNaN(cursorId)) {
      throw new Error(`Invalid Last-Event-ID: ${lastEventId}`);
    }

    // Determine the stream from the cursor event (may already be evicted)
    const cursorEvent = this._events.find((e) => e.id === cursorId);

    // If the cursor is older than the oldest buffered event, replay has failed:
    // we can no longer guarantee continuity.
    const oldestId = this._events.length > 0 ? this._events[0].id : cursorId + 1;

    if (cursorId < oldestId && !cursorEvent) {
      // Cursor event was evicted. Determine stream from the first available event
      // so we can still return a streamId as the interface requires.
      const streamId = this._events.length > 0
        ? this._events[0].streamId
        : "unknown";

      // Send a replay-failed notification so the client knows the gap exists.
      const notification: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notifications/apex.session.replay_failed",
        params: {
          reason: "event_id_outside_log",
          last_available_id: this._events.length > 0 ? String(oldestId) : null,
          requested_event_id: lastEventId,
        },
      };
      await send(String(this._nextId++), notification);

      return streamId;
    }

    // Find events strictly after the cursor.
    const streamId = cursorEvent?.streamId ?? (
      this._events.length > 0 ? this._events[0].streamId : "unknown"
    );

    // Classify events as required or elided and emit gap_fill markers.
    let gapStart: number | undefined;
    let gapEnd: number | undefined;
    let gapCount = 0;

    const flushGap = async () => {
      if (gapCount > 0 && gapStart !== undefined && gapEnd !== undefined) {
        const gapFill: JSONRPCMessage = {
          jsonrpc: "2.0",
          method: "notifications/apex.session.gap_fill",
          params: {
            elided_count: gapCount,
            from_id: String(gapStart),
            to_id: String(gapEnd),
          },
        };
        await send(String(gapEnd), gapFill);
        gapStart = undefined;
        gapEnd = undefined;
        gapCount = 0;
      }
    };

    for (const event of this._events) {
      if (event.id <= cursorId) continue;

      const method = (event.message as { method?: string }).method;
      const isRequired = method !== undefined && ReplayBuffer.REQUIRED_METHODS.has(method);

      if (isRequired) {
        // Flush any pending gap before sending the required event.
        await flushGap();
        await send(String(event.id), event.message);
      } else {
        // Accumulate into the current gap run.
        if (gapCount === 0) {
          gapStart = event.id;
        }
        gapEnd = event.id;
        gapCount++;
      }
    }

    // Flush any trailing gap at the end of replay.
    await flushGap();

    return streamId;
  }
}
