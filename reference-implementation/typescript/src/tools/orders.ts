import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apexError, nowIso } from "../lib/helpers.js";
import type { ApexNotification } from "../lib/notifications.js";
import {
  orderFilledNotification,
  orderPartiallyFilledNotification,
  orderRejectedNotification,
} from "../lib/notifications.js";
import type { ReferenceTradingState } from "../lib/resources.js";
import {
  InstrumentIdSchema,
  OrderTypeSchema,
  PriceStopSchema,
  SideSchema,
  TifSchema,
  TrailingStopSchema,
} from "../lib/schemas.js";

const OrderSchema = z.object({
  instrument_id: InstrumentIdSchema,
  broker_symbol: z.string().optional(),
  side: SideSchema,
  order_type: OrderTypeSchema,
  quantity: z.number().positive(),
  quantity_unit: z.enum(["base_units", "shares", "contracts"]).default("base_units"),
  time_in_force: TifSchema.default("GTC"),
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  stop_loss: PriceStopSchema,
  take_profit: PriceStopSchema,
  trailing_stop: TrailingStopSchema,
  profile: z.string().optional(),
  profile_data: z.record(z.unknown()).optional(),
  client_order_id: z.string().optional(),
  strategy_id: z.string().optional(),
  comment: z.string().optional(),
});

const OrderModificationSchema = z.object({
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  stop_loss: PriceStopSchema,
  take_profit: PriceStopSchema,
  trailing_stop: TrailingStopSchema,
});

export function registerOrderTools(
  server: McpServer,
  state: ReferenceTradingState,
  emitNotification?: (notif: ApexNotification) => void,
): void {
  server.registerTool(
    "apex.order.place",
    {
      description: "Unified order entry across all asset classes. Profile-composable.",
      inputSchema: {
        account_id: z.string(),
        order: OrderSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account_id, order }) => {
      const orderGate = state.canAcceptOrders();
      if (!orderGate.ok) {
        if (emitNotification) {
          const riskSeq = (state.getRisk() as Record<string, unknown>).sequence as number ?? 1;
          emitNotification(orderRejectedNotification(
            orderGate.code ?? "APEX_5000",
            orderGate.reason ?? "Order rejected",
            riskSeq,
          ));
        }
        return {
          structuredContent: apexError(orderGate.code ?? "APEX_5000", orderGate.category ?? "internal", orderGate.reason ?? "Order rejected"),
          content: [],
        };
      }

      if (order.order_type === "limit" && order.limit_price === undefined) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "limit_price required for limit orders"),
          content: [],
        };
      }

      const isMarketOrder = order.order_type === "market";
      const isPartialFill = isMarketOrder && state.consumePartialFillFlag();
      const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
      const fillQuantity = isMarketOrder ? (isPartialFill ? order.quantity / 2 : order.quantity) : 0;
      const remainingQuantity = isMarketOrder ? order.quantity - fillQuantity : order.quantity;
      const status = isMarketOrder ? (isPartialFill ? "partially_filled" : "filled") : "working";

      state.createOrUpdateOrder({
        order_id: orderId,
        client_order_id: order.client_order_id ?? null,
        account_id: account_id,
        instrument_id: order.instrument_id,
        broker_symbol: order.broker_symbol ?? state.brokerSymbol,
        side: order.side,
        order_type: order.order_type,
        quantity: order.quantity,
        quantity_unit: order.quantity_unit,
        limit_price: order.limit_price ?? null,
        stop_price: order.stop_price ?? null,
        time_in_force: order.time_in_force,
        status,
        filled_quantity: fillQuantity,
        remaining_quantity: remainingQuantity,
        average_fill_price: isMarketOrder ? 1.08755 : null,
        reason: null,
      });

      if (isMarketOrder) {
        state.recordFill({
          fill_id: `fill_${crypto.randomUUID().slice(0, 8)}`,
          order_id: orderId,
          account_id,
          instrument_id: order.instrument_id,
          side: order.side,
          fill_quantity: fillQuantity,
          fill_price: 1.08755,
          commission: -0.5,
          commission_currency: "USD",
          liquidity_flag: "taker",
          position_id: "pos_001",
          timestamp: nowIso(),
        });
      }

      await state.notifyResources(
        server,
        state.uris.orders,
        state.uris.positions,
        state.uris.fills,
        state.uris.risk,
        state.uris.decisionContext,
      );

      if (emitNotification && isMarketOrder) {
        const placedOrder = state.getOrders().orders.find((o) => o.order_id === orderId);
        if (placedOrder) {
          const fillSeq = (state.getFills() as Record<string, unknown>).sequence as number ?? 1;
          if (status === "filled") {
            emitNotification(orderFilledNotification(placedOrder, fillSeq));
          } else if (status === "partially_filled") {
            emitNotification(orderPartiallyFilledNotification(placedOrder, fillSeq));
          }
        }
      }

      return {
        structuredContent: {
          order_id: orderId,
          client_order_id: order.client_order_id ?? null,
          status,
          fill_price: isMarketOrder ? 1.08755 : null,
          fill_quantity: fillQuantity,
          remaining_quantity: remainingQuantity,
          position_id: isMarketOrder ? "pos_001" : null,
          rejection_reason: null,
          created_at: nowIso(),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.order.modify",
    {
      description: "Amend a working order or an open position's protection settings.",
      inputSchema: {
        account_id: z.string(),
        target_type: z.enum(["order", "position"]),
        target_id: z.string(),
        modifications: OrderModificationSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ target_type, target_id, modifications }) => {
      if (
        target_type === "position" &&
        (modifications.limit_price !== undefined ||
          modifications.stop_price !== undefined ||
          modifications.quantity !== undefined)
      ) {
        return {
          structuredContent: apexError(
            "APEX_4011",
            "validation",
            "Positions may only amend stop_loss, take_profit, or trailing_stop",
          ),
          content: [],
        };
      }

      await state.notifyResources(server, state.uris.orders, state.uris.positions, state.uris.decisionContext);

      return {
        structuredContent: {
          target_type,
          target_id,
          status: "modified",
          rejection_reason: null,
          updated_at: nowIso(),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.order.cancel",
    {
      description: "Cancel a working or partially filled order.",
      inputSchema: {
        account_id: z.string(),
        order_id: z.string(),
        reason: z.string().optional().describe("Agent-provided reason for audit trail"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ order_id }) => {
      state.cancelOrder(order_id);
      await state.notifyResources(server, state.uris.orders, state.uris.decisionContext);

      return {
        structuredContent: {
          order_id,
          status: "cancelled",
          rejection_reason: null,
          cancelled_at: nowIso(),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.order.status",
    {
      description: "Query the current state of a single order.",
      inputSchema: {
        account_id: z.string(),
        order_id: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ order_id }) => {
      const knownOrder = state.getOrders().orders.find((order) => order.order_id === order_id);
      if (!knownOrder) {
        return {
          structuredContent: apexError("APEX_4011", "validation", `Unknown order: ${order_id}`),
          content: [],
        };
      }
      const { sequence, stale_after_ms, ...order } = knownOrder as unknown as Record<string, unknown>;
      return {
        structuredContent: { ...order, as_of: nowIso() },
        content: [],
      };
    },
  );
}
