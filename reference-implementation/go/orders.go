package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerOrderTools(s *server.MCPServer) {
	registerOrderToolsWithState(s, state)
}

func registerOrderToolsWithState(s *server.MCPServer, st *referenceState) {
	s.AddTool(
		mcp.NewTool("apex.order.place",
			mcp.WithDescription("Unified order entry across all asset classes. Profile-composable."),
			mcp.WithReadOnlyHintAnnotation(false),
			mcp.WithDestructiveHintAnnotation(true),
			mcp.WithIdempotentHintAnnotation(false),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithObject("order", mcp.Required(), mcp.Description("Order specification"),
				mcp.Properties(map[string]any{
					"instrument_id":   map[string]any{"type": "string", "description": "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"},
					"broker_symbol":   map[string]any{"type": "string", "description": "Broker-specific symbol"},
					"side":            map[string]any{"type": "string", "description": "Order side: buy or sell", "enum": []string{"buy", "sell"}},
					"order_type":      map[string]any{"type": "string", "description": "Order type: market, limit, stop, stop_limit", "enum": []string{"market", "limit", "stop", "stop_limit"}},
					"quantity":        map[string]any{"type": "number", "description": "Order quantity"},
					"quantity_unit":   map[string]any{"type": "string", "description": "Canonical quantity unit: base_units, shares, or contracts", "enum": []string{"base_units", "shares", "contracts"}},
					"time_in_force":   map[string]any{"type": "string", "description": "Time in force: GTC, IOC, FOK, DAY", "enum": []string{"GTC", "IOC", "FOK", "DAY"}},
					"limit_price":     map[string]any{"type": "number", "description": "Limit price (required for limit orders)"},
					"stop_price":      map[string]any{"type": "number", "description": "Stop price (required for stop orders)"},
					"stop_loss":       map[string]any{"type": "object", "description": "Stop loss protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"price", "pips", "percent"}}, "value": map[string]any{"type": "number"}}},
					"take_profit":     map[string]any{"type": "object", "description": "Take profit protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"price", "pips", "percent"}}, "value": map[string]any{"type": "number"}}},
					"trailing_stop":   map[string]any{"type": "object", "description": "Trailing stop protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"pips", "percent"}}, "value": map[string]any{"type": "number"}}},
					"profile_data":    map[string]any{"type": "object", "description": "Profile-specific fields"},
					"profile":         map[string]any{"type": "string", "description": "Asset class profile"},
					"client_order_id": map[string]any{"type": "string", "description": "Client-assigned order ID"},
					"strategy_id":     map[string]any{"type": "string", "description": "Strategy ID"},
					"comment":         map[string]any{"type": "string", "description": "Order comment"},
				}),
			),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if ok, code, category, reason := st.orderAcceptance(); !ok {
				// Emit order rejected notification in HTTP mode
				if st.notifyCallback != nil {
					st.mu.Lock()
					riskSeq := st.nextSequence(referenceURIs.Risk)
					cb := st.notifyCallback
					st.mu.Unlock()
					cb(orderRejectedNotification(code, reason, riskSeq))
				}
				return jsonResult(apexError(code, category, reason))
			}

			order := mapParam(request.GetArguments(), "order")
			if order == nil {
				return jsonResult(apexError("APEX_4011", "validation", "order is required"))
			}

			orderType := strParam(order, "order_type", "market")

			if orderType == "limit" {
				if _, ok := order["limit_price"]; !ok {
					return jsonResult(apexError("APEX_4011", "validation", "limit_price required for limit orders"))
				}
			}

			return jsonResult(st.createOrder(request.GetArguments()))
		},
	)

	s.AddTool(
		mcp.NewTool("apex.order.modify",
			mcp.WithDescription("Amend a working order or an open position's protection settings."),
			mcp.WithReadOnlyHintAnnotation(false),
			mcp.WithDestructiveHintAnnotation(true),
			mcp.WithIdempotentHintAnnotation(false),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("target_type", mcp.Required(), mcp.Enum("order", "position")),
			mcp.WithString("target_id", mcp.Required()),
			mcp.WithObject("modifications", mcp.Required(), mcp.Description("Fields to modify"),
				mcp.Properties(map[string]any{
					"limit_price":   map[string]any{"type": "number", "description": "New limit price"},
					"stop_price":    map[string]any{"type": "number", "description": "New stop price"},
					"quantity":      map[string]any{"type": "number", "description": "New quantity"},
					"stop_loss":     map[string]any{"type": "object", "description": "Stop loss protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"price", "pips", "percent"}}, "value": map[string]any{"type": "number"}}},
					"take_profit":   map[string]any{"type": "object", "description": "Take profit protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"price", "pips", "percent"}}, "value": map[string]any{"type": "number"}}},
					"trailing_stop": map[string]any{"type": "object", "description": "Trailing stop protection", "properties": map[string]any{"type": map[string]any{"type": "string", "enum": []string{"pips", "percent"}}, "value": map[string]any{"type": "number"}}},
				}),
			),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			targetType := strParam(args, "target_type", "")
			modifications := mapParam(args, "modifications")

			if targetType == "position" && modifications != nil {
				if _, ok := modifications["limit_price"]; ok {
					return jsonResult(apexError("APEX_4011", "validation", "positions may only amend stop_loss, take_profit, or trailing_stop"))
				}
				if _, ok := modifications["stop_price"]; ok {
					return jsonResult(apexError("APEX_4011", "validation", "positions may only amend stop_loss, take_profit, or trailing_stop"))
				}
				if _, ok := modifications["quantity"]; ok {
					return jsonResult(apexError("APEX_4011", "validation", "positions may only amend stop_loss, take_profit, or trailing_stop"))
				}
			}

			st.modifyOrder(strParam(args, "target_id", ""))
			return jsonResult(orderModifyResponse{
				TargetType:      targetType,
				TargetID:        strParam(args, "target_id", ""),
				Status:          "modified",
				RejectionReason: nil,
				UpdatedAt:       nowISO(),
			})
		},
	)

	s.AddTool(
		mcp.NewTool("apex.order.cancel",
			mcp.WithDescription("Cancel a working or partially filled order."),
			mcp.WithReadOnlyHintAnnotation(false),
			mcp.WithDestructiveHintAnnotation(true),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("order_id", mcp.Required()),
			mcp.WithString("reason", mcp.Description("Agent-provided reason for audit trail")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			orderID := strParam(request.GetArguments(), "order_id", "")
			st.cancelOrder(orderID)
			return jsonResult(orderCancelResponse{
				OrderID:         orderID,
				Status:          "cancelled",
				RejectionReason: nil,
				CancelledAt:     nowISO(),
			})
		},
	)

	s.AddTool(
		mcp.NewTool("apex.order.status",
			mcp.WithDescription("Query the current state of a single order."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("order_id", mcp.Required()),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			order, found := st.orderStatus(strParam(request.GetArguments(), "order_id", ""))
			if !found {
				return jsonResult(apexError("APEX_4011", "validation", "Unknown order"))
			}
			return jsonResult(order)
		},
	)

	s.AddTool(
		mcp.NewTool("apex.position.close",
			mcp.WithDescription("Close an open position fully or partially by executing an opposite-direction market order."),
			mcp.WithReadOnlyHintAnnotation(false),
			mcp.WithDestructiveHintAnnotation(true),
			mcp.WithIdempotentHintAnnotation(false),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("position_id", mcp.Required()),
			mcp.WithNumber("quantity", mcp.Description("Partial close quantity. If omitted, closes full position.")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if ok, code, category, reason := st.orderAcceptance(); !ok {
				if st.notifyCallback != nil {
					st.mu.Lock()
					riskSeq := st.nextSequence(referenceURIs.Risk)
					cb := st.notifyCallback
					st.mu.Unlock()
					cb(orderRejectedNotification(code, reason, riskSeq))
				}
				return jsonResult(apexError(code, category, reason))
			}

			args := request.GetArguments()
			positionID := strParam(args, "position_id", "")
			if positionID == "" {
				return jsonResult(apexError("APEX_4011", "validation", "position_id is required"))
			}

			var closeQuantity *float64
			if _, ok := args["quantity"]; ok {
				qty := floatParam(args, "quantity", 0)
				if qty <= 0 {
					return jsonResult(apexError("APEX_4011", "validation", "quantity must be positive"))
				}
				closeQuantity = &qty
			}

			result, errMsg := st.closePosition(positionID, closeQuantity)
			if result == nil {
				return jsonResult(apexError("APEX_4011", "validation", errMsg))
			}
			return jsonResult(result)
		},
	)
}
