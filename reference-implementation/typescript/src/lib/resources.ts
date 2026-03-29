import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ApexErrorCategory } from "./helpers.js";
import { nowIso } from "./helpers.js";
import type { ApexNotification } from "./notifications.js";
import { killSwitchEngagedNotification } from "./notifications.js";

const ACCOUNT_ID = "ACC_12345";
const INSTRUMENT_ID = "APEX:FX:EURUSD";
const BROKER_SYMBOL = "EURUSD";

export interface ReferenceOrder {
  order_id: string;
  client_order_id: string | null;
  account_id?: string;
  instrument_id: string;
  broker_symbol: string;
  side: "buy" | "sell";
  order_type: "market" | "limit" | "stop" | "stop_limit";
  quantity: number;
  quantity_unit: "base_units" | "shares" | "contracts";
  limit_price: number | null;
  stop_price: number | null;
  time_in_force: "GTC" | "IOC" | "FOK" | "DAY";
  status: "working" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
  filled_quantity: number;
  remaining_quantity: number;
  average_fill_price?: number | null;
  reason?: string | null;
  created_at: string;
  updated_at: string;
}

type ResourceEnvelope<T> = T & {
  sequence: number;
  stale_after_ms: number;
};

const quoteUri = (instrumentId = INSTRUMENT_ID) => `apex://market/quote/${instrumentId}`;
const candlesUri = (timeframe: string, instrumentId = INSTRUMENT_ID) =>
  `apex://market/candles/${instrumentId}?timeframe=${timeframe}&limit=200`;
const featuresUri = (instrumentId = INSTRUMENT_ID) => `apex://market/features/${instrumentId}`;
const accountSummaryUri = (accountId = ACCOUNT_ID) => `apex://account/summary/${accountId}`;
const positionsUri = (accountId = ACCOUNT_ID) => `apex://account/positions/${accountId}`;
const ordersUri = (accountId = ACCOUNT_ID) => `apex://account/orders/${accountId}`;
const fillsUri = (accountId = ACCOUNT_ID) => `apex://account/fills/${accountId}`;
const riskUri = (accountId = ACCOUNT_ID) => `apex://account/risk/${accountId}`;
const decisionContextUri = (instrumentId = INSTRUMENT_ID) =>
  `apex://agent/decision-context/${instrumentId}`;

const canonicalUris = {
  quote: quoteUri(),
  candlesM1: candlesUri("M1"),
  candlesM5: candlesUri("M5"),
  candlesH1: candlesUri("H1"),
  features: featuresUri(),
  accountSummary: accountSummaryUri(),
  positions: positionsUri(),
  orders: ordersUri(),
  fills: fillsUri(),
  risk: riskUri(),
  decisionContext: decisionContextUri(),
};

const initialPosition = () => ({
  position_id: "pos_001",
  instrument_id: INSTRUMENT_ID,
  broker_symbol: BROKER_SYMBOL,
  side: "buy" as const,
  quantity: 100000,
  quantity_unit: "base_units" as const,
  broker_quantity: "1.0",
  broker_quantity_unit: "lots",
  open_price: 1.0850,
  current_price: 1.0875,
  unrealised_pnl: 250.0,
  unrealised_pnl_currency: "USD",
  used_margin: 500.0,
  open_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  stop_loss: 1.08,
  take_profit: 1.1,
  profile_data: {
    rollover_long_daily: -2.5,
    rollover_short_daily: 1.8,
    accrued_rollover: -7.5,
    pip_value: 10.0,
    pip_value_currency: "USD",
  },
});

export class ReferenceTradingState {
  private resourceSequences = new Map<string, number>();
  private orders: ReferenceOrder[] = [];
  private positions = [initialPosition()];
  private fillEvents: Array<Record<string, unknown>> = [];
  private quoteStale = false;
  private riskStale = false;
  private forceSequenceGap = false;
  private killSwitchActive = false;
  private partialFillNextOrder = false;

  /** Mutable quote state — updated by tick engine in HTTP mode. */
  private liveBid = 1.0874;
  private liveAsk = 1.0876;
  private liveMid = 1.0875;

  /** Optional callback for emitting APEX notifications (set in HTTP mode). */
  emitNotification?: (notif: ApexNotification) => void;

  readonly accountId = ACCOUNT_ID;
  readonly instrumentId = INSTRUMENT_ID;
  readonly brokerSymbol = BROKER_SYMBOL;
  readonly uris = canonicalUris;

  updateQuote(mid: number, bid: number, ask: number) {
    this.liveMid = mid;
    this.liveBid = bid;
    this.liveAsk = ask;
  }

  getQuote() {
    return this.withMeta(this.uris.quote, {
      instrument_id: this.instrumentId,
      broker_symbol: this.brokerSymbol,
      bid: this.liveBid,
      ask: this.liveAsk,
      mid: this.liveMid,
      spread: Math.round((this.liveAsk - this.liveBid) * 100000) / 100000,
      timestamp: this.quoteStale ? new Date(Date.now() - 5_000).toISOString() : nowIso(),
      is_tradeable: true,
      market_status: "open",
    }, 1_000);
  }

  getCandles(timeframe: "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN") {
    const base = {
      M1: 1.0875,
      M5: 1.0868,
      M15: 1.0862,
      M30: 1.0854,
      H1: 1.0842,
      H4: 1.0829,
      D1: 1.0811,
      W1: 1.0795,
      MN: 1.076,
    }[timeframe];

    const candle = {
      time: new Date(Date.now() - 60 * 1000).toISOString(),
      open: base - 0.0006,
      high: base + 0.0008,
      low: base - 0.0010,
      close: base,
      volume: 125000,
      complete: true,
    };

    return this.withMeta(candlesUri(timeframe), {
      instrument_id: this.instrumentId,
      timeframe,
      partial_candle_included: true,
      as_of: nowIso(),
      candles: [candle],
    }, 60_000);
  }

  getFeatures() {
    return this.withMeta(this.uris.features, {
      instrument_id: this.instrumentId,
      as_of: nowIso(),
      quote: {
        bid: 1.0874,
        ask: 1.0876,
        mid: 1.0875,
        spread: 0.0002,
      },
      returns: {
        r_1s: 0.00002,
        r_5s: 0.00005,
        r_1m: 0.0008,
      },
      volatility: {
        rv_1m: 0.12,
        rv_5m: 0.37,
        rv_30m: 0.55,
      },
      book: {
        top_level_imbalance: 0.21,
        depth_imbalance: 0.18,
        microprice: 1.08753,
      },
      flow: {
        trade_intensity_30s: 0.67,
        aggressor_imbalance_30s: 0.44,
      },
      regime: {
        label: "trend_up",
        confidence: 0.81,
      },
      execution: {
        liquidity_score: 0.79,
        expected_slippage_bps: 0.6,
      },
    }, 2_000);
  }

  getAccountSummary() {
    return this.withMeta(this.uris.accountSummary, {
      account_id: this.accountId,
      account_base_currency: "USD",
      response_currency: "USD",
      balance: 10000.0,
      equity: 10250.0,
      used_margin: 500.0,
      free_margin: 9750.0,
      margin_level_pct: 2050.0,
      unrealised_pnl: 250.0,
      realised_pnl_today: 0.0,
      as_of: this.riskStale ? new Date(Date.now() - 5_000).toISOString() : nowIso(),
    }, 2_000);
  }

  getPositions() {
    return this.withMeta(this.uris.positions, {
      account_id: this.accountId,
      as_of: nowIso(),
      positions: this.positions,
      total_unrealised_pnl: this.positions.reduce((sum, position) => sum + position.unrealised_pnl, 0),
    }, 2_000);
  }

  getOrders() {
    return this.withMeta(this.uris.orders, {
      account_id: this.accountId,
      as_of: nowIso(),
      orders: this.orders,
    }, 2_000);
  }

  getFills() {
    return this.withMeta(this.uris.fills, {
      account_id: this.accountId,
      as_of: nowIso(),
      fills: this.fillEvents,
    }, 2_000);
  }

  getRisk() {
    return this.withMeta(this.uris.risk, {
      account_id: this.accountId,
      as_of: this.riskStale ? new Date(Date.now() - 5_000).toISOString() : nowIso(),
      available_margin: 9750.0,
      kill_switch_active: this.killSwitchActive,
      max_position_size: 5000000,
      max_open_orders: 50,
      daily_loss_limit: -1000.0,
      daily_loss_used: -150.0,
      restricted_instruments: [],
      margin_call_level_pct: 100,
      stop_out_level_pct: 50,
    }, 2_000);
  }

  getDecisionContext() {
    return this.withMeta(this.uris.decisionContext, {
      instrument_id: this.instrumentId,
      timestamp: nowIso(),
      market: {
        quote_resource: this.uris.quote,
        feature_resource: this.uris.features,
        candle_resources: [this.uris.candlesM1, this.uris.candlesM5, this.uris.candlesH1],
      },
      account: {
        summary_resource: this.uris.accountSummary,
        positions_resource: this.uris.positions,
        orders_resource: this.uris.orders,
        risk_resource: this.uris.risk,
      },
      constraints: {
        kill_switch_active: this.killSwitchActive,
        max_position_size: 5000000,
        max_open_orders: 50,
      },
    }, 5_000);
  }

  listResources() {
    return [
      { name: "quote", uri: this.uris.quote, description: "Live top-of-book quote", mimeType: "application/json" },
      { name: "candles-m1", uri: this.uris.candlesM1, description: "M1 candles", mimeType: "application/json" },
      { name: "candles-m5", uri: this.uris.candlesM5, description: "M5 candles", mimeType: "application/json" },
      { name: "candles-h1", uri: this.uris.candlesH1, description: "H1 candles", mimeType: "application/json" },
      { name: "features", uri: this.uris.features, description: "Derived market features", mimeType: "application/json" },
      { name: "account-summary", uri: this.uris.accountSummary, description: "Realtime account summary", mimeType: "application/json" },
      { name: "account-positions", uri: this.uris.positions, description: "Realtime positions", mimeType: "application/json" },
      { name: "account-orders", uri: this.uris.orders, description: "Realtime orders", mimeType: "application/json" },
      { name: "account-fills", uri: this.uris.fills, description: "Realtime fills", mimeType: "application/json" },
      { name: "account-risk", uri: this.uris.risk, description: "Realtime risk state", mimeType: "application/json" },
      { name: "decision-context", uri: this.uris.decisionContext, description: "Model-ready decision context", mimeType: "application/json" },
    ];
  }

  readResource(uri: string): unknown {
    switch (uri) {
      case this.uris.quote:
        return this.getQuote();
      case this.uris.candlesM1:
        return this.getCandles("M1");
      case this.uris.candlesM5:
        return this.getCandles("M5");
      case this.uris.candlesH1:
        return this.getCandles("H1");
      case this.uris.features:
        return this.getFeatures();
      case this.uris.accountSummary:
        return this.getAccountSummary();
      case this.uris.positions:
        return this.getPositions();
      case this.uris.orders:
        return this.getOrders();
      case this.uris.fills:
        return this.getFills();
      case this.uris.risk:
        return this.getRisk();
      case this.uris.decisionContext:
        return this.getDecisionContext();
      default:
        return null;
    }
  }

  createOrUpdateOrder(order: Omit<ReferenceOrder, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string }) {
    const existingIndex = this.orders.findIndex((existing) => existing.order_id === order.order_id);
    const nextOrder: ReferenceOrder = {
      ...order,
      created_at: order.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    if (existingIndex >= 0) {
      this.orders[existingIndex] = nextOrder;
    } else {
      this.orders.push(nextOrder);
    }
  }

  cancelOrder(orderId: string) {
    const order = this.orders.find((candidate) => candidate.order_id === orderId);
    if (order) {
      order.status = "cancelled";
      order.remaining_quantity = 0;
      order.updated_at = nowIso();
    }
  }

  updatePosition(positionId: string, remainingQuantity: number) {
    if (remainingQuantity <= 0) {
      this.positions = this.positions.filter((p) => p.position_id !== positionId);
    } else {
      const pos = this.positions.find((p) => p.position_id === positionId);
      if (pos) {
        pos.quantity = remainingQuantity;
      }
    }
  }

  recordFill(fill: Record<string, unknown>) {
    this.fillEvents.unshift(fill);
  }

  bumpResources(...uris: string[]) {
    for (const uri of uris) {
      const current = this.resourceSequences.get(uri) ?? 1;
      const increment = this.forceSequenceGap ? 5 : 1;
      this.resourceSequences.set(uri, current + increment);
    }
    this.forceSequenceGap = false;
  }

  async notifyResources(server: McpServer, ...uris: string[]) {
    this.bumpResources(...uris);
    for (const uri of uris) {
      await server.server.sendResourceUpdated({ uri });
    }
  }

  private withMeta<T extends Record<string, unknown>>(uri: string, value: T, staleAfterMs: number): ResourceEnvelope<T> {
    return {
      ...value,
      sequence: this.resourceSequences.get(uri) ?? 1,
      stale_after_ms: staleAfterMs,
    };
  }

  setRealtimeFaults(options: {
    quote_stale?: boolean;
    risk_stale?: boolean;
    force_sequence_gap?: boolean;
    kill_switch_active?: boolean;
    partial_fill_next_order?: boolean;
  }) {
    if (options.quote_stale !== undefined) {
      this.quoteStale = options.quote_stale;
    }
    if (options.risk_stale !== undefined) {
      this.riskStale = options.risk_stale;
    }
    if (options.force_sequence_gap !== undefined) {
      this.forceSequenceGap = options.force_sequence_gap;
    }
    if (options.kill_switch_active !== undefined) {
      const wasActive = this.killSwitchActive;
      this.killSwitchActive = options.kill_switch_active;
      if (!wasActive && options.kill_switch_active && this.emitNotification) {
        const seq = this.resourceSequences.get(this.uris.risk) ?? 1;
        this.emitNotification(killSwitchEngagedNotification(seq));
      }
    }
    if (options.partial_fill_next_order !== undefined) {
      this.partialFillNextOrder = options.partial_fill_next_order;
    }
  }

  currentFaults() {
    return {
      quote_stale: this.quoteStale,
      risk_stale: this.riskStale,
      force_sequence_gap: this.forceSequenceGap,
      kill_switch_active: this.killSwitchActive,
      partial_fill_next_order: this.partialFillNextOrder,
    };
  }

  canAcceptOrders() {
    return {
      ok: !(this.quoteStale || this.riskStale || this.forceSequenceGap || this.killSwitchActive),
      reason: this.quoteStale
        ? "Quote state is stale"
        : this.riskStale
          ? "Risk state is stale"
          : this.forceSequenceGap
            ? "Sequence continuity is broken"
            : this.killSwitchActive
              ? "Kill switch active"
            : null,
      code: this.quoteStale || this.riskStale ? "APEX_4024" : this.forceSequenceGap ? "APEX_4025" : this.killSwitchActive ? "APEX_4023" : null,
      category: (this.quoteStale || this.riskStale
        ? "operational"
        : this.forceSequenceGap
          ? "operational"
          : this.killSwitchActive
            ? "risk"
          : null) as ApexErrorCategory | null,
    };
  }

  consumePartialFillFlag(): boolean {
    const active = this.partialFillNextOrder;
    this.partialFillNextOrder = false;
    return active;
  }
}

export function registerReferenceResources(server: McpServer, state: ReferenceTradingState): void {
  for (const resource of state.listResources()) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: JSON.stringify(state.readResource(resource.uri)),
          },
        ],
      }),
    );
  }
}
