/**
 * APEX Protocol Notification Builders
 *
 * Constructs rich APEX-specific notification envelopes for the 6 core
 * event types: order filled, order partially filled, order rejected,
 * candle closed, kill switch engaged, and replay failed.
 */

import { nowIso } from "./helpers.js";
import type { ReferenceOrder } from "./resources.js";

export const ACCOUNT_ID = "ACC_12345";
export const INSTRUMENT_ID = "APEX:FX:EURUSD";

/* ------------------------------------------------------------------ */
/*  Envelope                                                          */
/* ------------------------------------------------------------------ */

export interface ApexNotification {
  jsonrpc: "2.0";
  method: string;
  params: {
    event_id: string;
    event_type: string;
    account_id: string;
    instrument_id: string;
    resource_uri: string;
    timestamp: string;
    sequence: number;
    payload: Record<string, unknown>;
  };
}

interface BuildNotificationOpts {
  accountId?: string;
  instrumentId?: string;
  resourceUri: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export function buildApexNotification(
  method: string,
  opts: BuildNotificationOpts,
): ApexNotification {
  return {
    jsonrpc: "2.0",
    method,
    params: {
      event_id: `evt_${crypto.randomUUID().slice(0, 8)}`,
      event_type: method,
      account_id: opts.accountId ?? ACCOUNT_ID,
      instrument_id: opts.instrumentId ?? INSTRUMENT_ID,
      resource_uri: opts.resourceUri,
      timestamp: nowIso(),
      sequence: opts.sequence,
      payload: opts.payload,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Order Filled                                                      */
/* ------------------------------------------------------------------ */

export function orderFilledNotification(
  order: ReferenceOrder,
  fillSequence: number,
): ApexNotification {
  return buildApexNotification("notifications/apex.order.filled", {
    accountId: order.account_id ?? ACCOUNT_ID,
    instrumentId: order.instrument_id,
    resourceUri: `apex://account/fills/${order.account_id ?? ACCOUNT_ID}`,
    sequence: fillSequence,
    payload: {
      order_id: order.order_id,
      side: order.side,
      fill_price: order.average_fill_price ?? 0,
      fill_quantity: order.filled_quantity,
      commission: -0.5,
      position_id: "pos_001",
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Order Partially Filled                                            */
/* ------------------------------------------------------------------ */

export function orderPartiallyFilledNotification(
  order: ReferenceOrder,
  fillSequence: number,
): ApexNotification {
  return buildApexNotification("notifications/apex.order.partially_filled", {
    accountId: order.account_id ?? ACCOUNT_ID,
    instrumentId: order.instrument_id,
    resourceUri: `apex://account/fills/${order.account_id ?? ACCOUNT_ID}`,
    sequence: fillSequence,
    payload: {
      order_id: order.order_id,
      side: order.side,
      fill_price: order.average_fill_price ?? 0,
      fill_quantity: order.filled_quantity,
      remaining_quantity: order.remaining_quantity,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Order Rejected                                                    */
/* ------------------------------------------------------------------ */

export function orderRejectedNotification(
  code: string,
  reason: string,
  riskSequence: number,
): ApexNotification {
  return buildApexNotification("notifications/apex.order.rejected", {
    resourceUri: `apex://account/risk/${ACCOUNT_ID}`,
    sequence: riskSequence,
    payload: {
      code,
      reason,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Candle Closed                                                     */
/* ------------------------------------------------------------------ */

export function candleClosedNotification(
  instrumentId: string,
  timeframe: string,
  candle: { time: string; open: number; high: number; low: number; close: number; volume: number },
  candleSequence: number,
): ApexNotification {
  return buildApexNotification("notifications/apex.market.candle_closed", {
    instrumentId,
    resourceUri: `apex://market/candles/${instrumentId}?timeframe=${timeframe}&limit=200`,
    sequence: candleSequence,
    payload: {
      instrument_id: instrumentId,
      timeframe,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      complete: true,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Kill Switch Engaged                                               */
/* ------------------------------------------------------------------ */

export function killSwitchEngagedNotification(
  riskSequence: number,
): ApexNotification {
  return buildApexNotification("notifications/apex.risk.kill_switch_engaged", {
    resourceUri: `apex://account/risk/${ACCOUNT_ID}`,
    sequence: riskSequence,
    payload: {
      account_id: ACCOUNT_ID,
      reason: "Daily loss limit exceeded",
    },
  });
}

