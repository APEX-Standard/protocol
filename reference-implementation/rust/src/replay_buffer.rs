use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

const MAX_BUFFER_SIZE: usize = 1000;

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub id: u64,
    #[allow(dead_code)]
    pub stream_id: String,
    pub message: Value,
}

pub enum ReplayResult {
    Events(Vec<StoredEvent>),
    Failed { oldest_available_id: Option<u64> },
}

pub struct ReplayBuffer {
    inner: Mutex<InnerBuffer>,
}

struct InnerBuffer {
    events: VecDeque<StoredEvent>,
    next_id: u64,
}

impl ReplayBuffer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InnerBuffer {
                events: VecDeque::new(),
                next_id: 1,
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

    /// Replay all events after the given last_event_id.
    /// Returns `ReplayResult::Events` if the cursor is still in range,
    /// or `ReplayResult::Failed` if events have been evicted.
    pub fn replay_after(&self, last_event_id: &str) -> ReplayResult {
        let cursor_id: u64 = match last_event_id.parse() {
            Ok(id) => id,
            Err(_) => return ReplayResult::Failed { oldest_available_id: None },
        };

        let inner = self.inner.lock().expect("replay buffer mutex poisoned");

        let oldest_id = inner.events.front().map(|e| e.id);

        // If cursor is older than oldest buffered event, replay has failed
        if let Some(oldest) = oldest_id {
            if cursor_id < oldest {
                // The cursor event was evicted
                return ReplayResult::Failed {
                    oldest_available_id: Some(oldest),
                };
            }
        }

        // Collect events strictly after the cursor
        let events: Vec<StoredEvent> = inner
            .events
            .iter()
            .filter(|e| e.id > cursor_id)
            .cloned()
            .collect();

        ReplayResult::Events(events)
    }

    /// Get the current next_id (useful for generating replay_failed notification IDs).
    pub fn next_event_id(&self) -> u64 {
        let mut inner = self.inner.lock().expect("replay buffer mutex poisoned");
        let id = inner.next_id;
        inner.next_id += 1;
        id
    }
}
