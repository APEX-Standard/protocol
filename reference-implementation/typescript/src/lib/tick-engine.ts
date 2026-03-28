import { nowIso } from "./helpers.js";

export interface CandleState {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: string;
  complete: boolean;
}

export interface TickEngineCallbacks {
  onQuoteUpdate(mid: number, bid: number, ask: number): void;
  onCandleUpdate(timeframe: string): void;
  onCandleClose(timeframe: string, candle: CandleState): void;
  onFeatureUpdate(): void;
}

const TIMEFRAMES = ["M1", "M5", "H1"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const HALF_SPREAD = 0.0001;
const MAX_PIP_STEP = 0.0002;
const HISTORY_LIMIT = 300;
const TICK_INTERVAL_MS = 2_000;

function roundTo5(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

export class TickEngine {
  private mid = 1.0875;
  private priceHistory: number[] = [];
  private candles = new Map<Timeframe, CandleState>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private callbacks: TickEngineCallbacks;

  constructor(callbacks: TickEngineCallbacks) {
    this.callbacks = callbacks;
    for (const tf of TIMEFRAMES) {
      this.candles.set(tf, this.freshCandle(this.mid));
    }
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  forceCandleClose(timeframe: string): void {
    const tf = timeframe as Timeframe;
    const candle = this.candles.get(tf);
    if (!candle) return;
    candle.complete = true;
    this.callbacks.onCandleClose(tf, { ...candle });
    this.candles.set(tf, this.freshCandle(this.mid));
  }

  getCandle(timeframe: string): CandleState | undefined {
    return this.candles.get(timeframe as Timeframe);
  }

  getMid(): number {
    return this.mid;
  }

  getReturns(): { r_1s: number; r_5s: number; r_1m: number } {
    const len = this.priceHistory.length;
    if (len < 2) {
      return { r_1s: 0, r_5s: 0, r_1m: 0 };
    }

    const current = this.priceHistory[len - 1];
    // Each tick is 2 seconds apart.
    // r_1s: 1 tick back (closest we have to 1s at 2s interval)
    const r_1s = len >= 2
      ? (current - this.priceHistory[len - 2]) / this.priceHistory[len - 2]
      : 0;
    // r_5s: ~3 ticks back (6s worth, closest to 5s)
    const idx5s = Math.max(0, len - 3);
    const r_5s = (current - this.priceHistory[idx5s]) / this.priceHistory[idx5s];
    // r_1m: ~30 ticks back (60s)
    const idx1m = Math.max(0, len - 30);
    const r_1m = (current - this.priceHistory[idx1m]) / this.priceHistory[idx1m];

    return {
      r_1s: roundTo5(r_1s),
      r_5s: roundTo5(r_5s),
      r_1m: roundTo5(r_1m),
    };
  }

  getVolatility(): { rv_1m: number; rv_5m: number } {
    const len = this.priceHistory.length;
    if (len < 3) {
      return { rv_1m: 0, rv_5m: 0 };
    }

    // Compute log returns over the available history
    const logReturns: number[] = [];
    for (let i = 1; i < len; i++) {
      logReturns.push(Math.log(this.priceHistory[i] / this.priceHistory[i - 1]));
    }

    // rv_1m: variance of last ~30 ticks (60s) annualized
    // rv_5m: variance of last ~150 ticks (300s) annualized
    const rv_1m = this.annualizedVol(logReturns.slice(-30));
    const rv_5m = this.annualizedVol(logReturns.slice(-150));

    return {
      rv_1m: roundTo5(rv_1m),
      rv_5m: roundTo5(rv_5m),
    };
  }

  private annualizedVol(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
    // Each observation is 2 seconds apart.
    // Observations per year = 252 days * 24h * 3600s / 2s = 10,886,400
    const obsPerYear = 252 * 24 * 3600 / 2;
    return Math.sqrt(variance * obsPerYear);
  }

  private tick(): void {
    // Random walk
    const delta = (Math.random() - 0.5) * 2 * MAX_PIP_STEP;
    this.mid = roundTo5(this.mid + delta);

    const bid = roundTo5(this.mid - HALF_SPREAD);
    const ask = roundTo5(this.mid + HALF_SPREAD);

    // Push to history, cap at HISTORY_LIMIT
    this.priceHistory.push(this.mid);
    if (this.priceHistory.length > HISTORY_LIMIT) {
      this.priceHistory.shift();
    }

    // Update all candle states
    for (const tf of TIMEFRAMES) {
      const candle = this.candles.get(tf)!;
      candle.high = Math.max(candle.high, this.mid);
      candle.low = Math.min(candle.low, this.mid);
      candle.close = this.mid;
      candle.volume += 1;
    }

    // Check wall-clock boundaries for candle closes
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();

    if (seconds < 2) {
      const m1Candle = this.candles.get("M1")!;
      if (m1Candle.volume > 0) {
        this.forceCandleClose("M1");
      }

      if (minutes % 5 === 0) {
        const m5Candle = this.candles.get("M5")!;
        if (m5Candle.volume > 0) {
          this.forceCandleClose("M5");
        }
      }

      if (minutes === 0) {
        const h1Candle = this.candles.get("H1")!;
        if (h1Candle.volume > 0) {
          this.forceCandleClose("H1");
        }
      }
    }

    // Fire callbacks
    this.callbacks.onQuoteUpdate(this.mid, bid, ask);
    this.callbacks.onCandleUpdate("M1");
    this.callbacks.onFeatureUpdate();
  }

  private freshCandle(price: number): CandleState {
    return {
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      openTime: nowIso(),
      complete: false,
    };
  }
}
