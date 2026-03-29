use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::{json, Value};

const MAX_BUFFER_SIZE: usize = 10000;

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub id: u64,
    #[allow(dead_code)]
    pub stream_id: String,
    pub message: Value,
}

/// A replay item is either an original required event or a gap_fill marker
/// covering a run of elided (non-required) events.
#[derive(Debug, Clone)]
pub enum ReplayItem {
    Event(StoredEvent),
    GapFill {
        id: u64,
        elided_count: usize,
        from_id: u64,
        to_id: u64,
    },
}

pub enum ReplayResult {
    Items(Vec<ReplayItem>),
    Failed { oldest_available_id: Option<u64> },
}

pub struct ReplayBuffer {
    inner: Mutex<InnerBuffer>,
}

struct InnerBuffer {
    events: VecDeque<StoredEvent>,
    next_id: u64,
    acknowledged_through_id: u64,
}

/// Classify whether a JSON-RPC notification method is "required" —
/// meaning it must be replayed verbatim rather than elided into a gap fill.
fn is_required(method: &str) -> bool {
    matches!(
        method,
        "notifications/apex.order.filled"
            | "notifications/apex.order.partially_filled"
            | "notifications/apex.order.rejected"
            | "notifications/apex.risk.kill_switch_engaged"
    )
}

impl ReplayBuffer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InnerBuffer {
                events: VecDeque::new(),
                next_id: 1,
                acknowledged_through_id: 0,
            }),
        }
    }

    /// Store an event in the buffer. Returns the assigned event ID as a string.
    pub fn store(&self, stream_id: &str, message: Value) -> String {
        let mut inner = self.inner.lock().expect("replay buffer mutex poisoned");
        let id = inner.next_id;
        inner.next_id += 1;

        inner.events.push_back(StoredEvent {
            id,
            stream_id: stream_id.to_owned(),
            message,
        });

        if inner.events.len() > MAX_BUFFER_SIZE {
            inner.events.pop_front();
        }

        id.to_string()
    }

    /// Acknowledge all events up through `last_event_id`.
    /// Acknowledged events that are at the front of the buffer are removed.
    /// Returns `(acknowledged_through, buffer_depth)`.
    pub fn acknowledge(&self, last_event_id: &str) -> (String, usize) {
        let mut inner = self.inner.lock().expect("replay buffer mutex poisoned");
        let target_id = last_event_id.parse::<u64>().unwrap_or(0);
        inner.acknowledged_through_id = inner.acknowledged_through_id.max(target_id);
        while let Some(front) = inner.events.front() {
            if front.id <= inner.acknowledged_through_id {
                inner.events.pop_front();
            } else {
                break;
            }
        }
        (inner.acknowledged_through_id.to_string(), inner.events.len())
    }

    /// Replay events after the given last_event_id with gap-fill classification.
    ///
    /// Required events (order fills, rejections, kill switch) are sent verbatim.
    /// Consecutive runs of non-required events are collapsed into `gap_fill`
    /// markers carrying `elided_count`, `from_id`, and `to_id`.
    pub fn replay_after(&self, last_event_id: &str) -> ReplayResult {
        let cursor_id: u64 = match last_event_id.parse() {
            Ok(id) => id,
            Err(_) => return ReplayResult::Failed { oldest_available_id: None },
        };

        let mut inner = self.inner.lock().expect("replay buffer mutex poisoned");

        let oldest_id = inner.events.front().map(|e| e.id);

        // If cursor is older than oldest buffered event, replay has failed
        if let Some(oldest) = oldest_id {
            if cursor_id < oldest {
                return ReplayResult::Failed {
                    oldest_available_id: Some(oldest),
                };
            }
        }

        // Collect events after cursor first to avoid borrow conflicts
        let after_cursor: Vec<StoredEvent> = inner
            .events
            .iter()
            .filter(|e| e.id > cursor_id)
            .cloned()
            .collect();

        // Walk collected events, classifying into required vs elided
        let mut items: Vec<ReplayItem> = Vec::new();
        let mut elide_run: Option<(usize, u64, u64)> = None; // (count, from_id, to_id)

        for event in &after_cursor {
            let method = event
                .message
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("");

            if is_required(method) {
                // Flush any pending elide run before emitting the required event
                if let Some((count, from_id, to_id)) = elide_run.take() {
                    items.push(ReplayItem::GapFill {
                        id: to_id,
                        elided_count: count,
                        from_id,
                        to_id,
                    });
                }
                items.push(ReplayItem::Event(event.clone()));
            } else {
                // Accumulate into the current elide run
                match elide_run {
                    Some((count, from, _to)) => {
                        elide_run = Some((count + 1, from, event.id));
                    }
                    None => {
                        elide_run = Some((1, event.id, event.id));
                    }
                }
            }
        }

        // Flush trailing elide run
        if let Some((count, from_id, to_id)) = elide_run.take() {
            items.push(ReplayItem::GapFill {
                id: to_id,
                elided_count: count,
                from_id,
                to_id,
            });
        }

        ReplayResult::Items(items)
    }

    /// Get the current next_id (useful for generating replay_failed notification IDs).
    pub fn next_event_id(&self) -> u64 {
        let mut inner = self.inner.lock().expect("replay buffer mutex poisoned");
        let id = inner.next_id;
        inner.next_id += 1;
        id
    }

    /// Build a gap_fill JSON-RPC notification value.
    pub fn gap_fill_notification(_id: u64, elided_count: usize, from_id: u64, to_id: u64) -> Value {
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/apex.session.gap_fill",
            "params": {
                "elided_count": elided_count,
                "from_id": from_id.to_string(),
                "to_id": to_id.to_string(),
            }
        })
    }
}
