/**
 * SSE Event Replay Buffer for APEX Protocol HTTP/SSE transport.
 *
 * Implements the MCP SDK EventStore interface to support session resumability.
 * Stores the last 1000 events in a fixed-size ring buffer and replays events
 * from a Last-Event-ID cursor on reconnection.
 */

import type {
  EventStore,
  StreamId,
  EventId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MAX_BUFFER_SIZE = 1000;

interface BufferedEvent {
  id: number;
  streamId: StreamId;
  message: JSONRPCMessage;
}

export class ReplayBuffer implements EventStore {
  private _events: BufferedEvent[] = [];
  private _nextId = 1;

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
          reason: "Events before this point have been evicted from the replay buffer",
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

    for (const event of this._events) {
      if (event.id > cursorId) {
        await send(String(event.id), event.message);
      }
    }

    return streamId;
  }
}
