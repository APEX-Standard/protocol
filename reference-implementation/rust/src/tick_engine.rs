use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::helpers::now_iso;

const HALF_SPREAD: f64 = 0.0001;
const MAX_PIP_STEP: f64 = 0.0002;
const TICK_INTERVAL_MS: u64 = 2_000;
const HISTORY_LIMIT: usize = 300;

fn round_to_5(value: f64) -> f64 {
    (value * 100_000.0).round() / 100_000.0
}

#[derive(Debug, Clone)]
pub struct CandleState {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
    #[allow(dead_code)]
    pub open_time: String,
    #[allow(dead_code)]
    pub complete: bool,
}

#[derive(Debug, Clone)]
pub enum TickEvent {
    QuoteUpdate {
        mid: f64,
        bid: f64,
        ask: f64,
    },
    CandleClose {
        timeframe: String,
        candle: CandleState,
    },
    CandleUpdate {
        timeframe: String,
    },
    FeatureUpdate,
}

struct TickEngineInner {
    mid: f64,
    price_history: Vec<f64>,
    candles: std::collections::HashMap<String, CandleState>,
}

impl TickEngineInner {
    fn new() -> Self {
        let mut candles = std::collections::HashMap::new();
        let mid = 1.0875;
        for tf in &["M1", "M5", "H1"] {
            candles.insert(tf.to_string(), fresh_candle(mid));
        }
        Self {
            mid,
            price_history: Vec::new(),
            candles,
        }
    }

    fn tick(&mut self) -> Vec<TickEvent> {
        let mut events = Vec::new();

        // Random walk
        let delta = (rand::random::<f64>() - 0.5) * 2.0 * MAX_PIP_STEP;
        self.mid = round_to_5(self.mid + delta);

        let bid = round_to_5(self.mid - HALF_SPREAD);
        let ask = round_to_5(self.mid + HALF_SPREAD);

        self.price_history.push(self.mid);
        if self.price_history.len() > HISTORY_LIMIT {
            self.price_history.remove(0);
        }

        // Update all candle states
        for tf in &["M1", "M5", "H1"] {
            if let Some(candle) = self.candles.get_mut(*tf) {
                if self.mid > candle.high {
                    candle.high = self.mid;
                }
                if self.mid < candle.low {
                    candle.low = self.mid;
                }
                candle.close = self.mid;
                candle.volume += 1;
            }
        }

        // Check wall-clock boundaries for candle closes
        let now = chrono::Utc::now();
        let seconds = now.format("%S").to_string().parse::<u32>().unwrap_or(0);
        let minutes = now.format("%M").to_string().parse::<u32>().unwrap_or(0);

        if seconds < 2 {
            if let Some(candle) = self.candles.get("M1") {
                if candle.volume > 0 {
                    events.extend(self.force_candle_close("M1"));
                }
            }

            if minutes % 5 == 0 {
                if let Some(candle) = self.candles.get("M5") {
                    if candle.volume > 0 {
                        events.extend(self.force_candle_close("M5"));
                    }
                }
            }

            if minutes == 0 {
                if let Some(candle) = self.candles.get("H1") {
                    if candle.volume > 0 {
                        events.extend(self.force_candle_close("H1"));
                    }
                }
            }
        }

        events.push(TickEvent::QuoteUpdate { mid: self.mid, bid, ask });
        events.push(TickEvent::CandleUpdate {
            timeframe: "M1".to_owned(),
        });
        events.push(TickEvent::FeatureUpdate);

        events
    }

    fn force_candle_close(&mut self, timeframe: &str) -> Vec<TickEvent> {
        let mut events = Vec::new();
        if let Some(candle) = self.candles.get_mut(timeframe) {
            candle.complete = true;
            let closed = candle.clone();
            events.push(TickEvent::CandleClose {
                timeframe: timeframe.to_owned(),
                candle: closed,
            });
            *candle = fresh_candle(self.mid);
        }
        events
    }
}

fn fresh_candle(price: f64) -> CandleState {
    CandleState {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        open_time: now_iso(),
        complete: false,
    }
}

pub struct TickEngine {
    inner: Arc<Mutex<TickEngineInner>>,
    handle: Option<JoinHandle<()>>,
    event_tx: mpsc::UnboundedSender<TickEvent>,
}

impl TickEngine {
    pub fn new(event_tx: mpsc::UnboundedSender<TickEvent>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TickEngineInner::new())),
            handle: None,
            event_tx,
        }
    }

    pub fn start(&mut self) {
        if self.handle.is_some() {
            return;
        }

        let inner = self.inner.clone();
        let tx = self.event_tx.clone();

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(
                tokio::time::Duration::from_millis(TICK_INTERVAL_MS),
            );
            loop {
                interval.tick().await;
                let events = {
                    let mut engine = inner.lock().expect("tick engine mutex poisoned");
                    engine.tick()
                };
                for event in events {
                    if tx.send(event).is_err() {
                        return;
                    }
                }
            }
        });
        self.handle = Some(handle);
    }

    pub fn force_candle_close(&self, timeframe: &str) -> Option<CandleState> {
        let mut inner = self.inner.lock().expect("tick engine mutex poisoned");
        let events = inner.force_candle_close(timeframe);
        let tx = &self.event_tx;
        let mut closed_candle = None;
        for event in events {
            if let TickEvent::CandleClose { candle, .. } = &event {
                closed_candle = Some(candle.clone());
            }
            let _ = tx.send(event);
        }
        closed_candle
    }

    #[allow(dead_code)]
    pub fn stop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}
