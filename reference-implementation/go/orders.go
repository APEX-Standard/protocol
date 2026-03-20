package main

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerOrderTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("apex.order.place",
			mcp.WithDescription("Unified order entry across all asset classes. Profile-composable."),
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
					"profile":         map[string]any{"type": "string", "description": "Asset class profile"},
					"client_order_id": map[string]any{"type": "string", "description": "Client-assigned order ID"},
					"strategy_id":     map[string]any{"type": "string", "description": "Strategy ID"},
					"comment":         map[string]any{"type": "string", "description": "Order comment"},
				}),
			),
		),
		handleOrderPlace,
	)

	s.AddTool(
		mcp.NewTool("apex.order.modify",
			mcp.WithDescription("Amend a working order or an open position's protection settings."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("target_type", mcp.Required(), mcp.Enum("order", "position")),
			mcp.WithString("target_id", mcp.Required()),
			mcp.WithObject("modifications", mcp.Required(), mcp.Description("Fields to modify"),
				mcp.Properties(map[string]any{
					"limit_price": map[string]any{"type": "number", "description": "New limit price"},
					"stop_price":  map[string]any{"type": "number", "description": "New stop price"},
					"quantity":    map[string]any{"type": "number", "description": "New quantity"},
				}),
			),
		),
		handleOrderModify,
	)

	s.AddTool(
		mcp.NewTool("apex.order.cancel",
			mcp.WithDescription("Cancel a working or partially filled order."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("order_id", mcp.Required()),
			mcp.WithString("reason", mcp.Description("Agent-provided reason for audit trail")),
		),
		handleOrderCancel,
	)

	s.AddTool(
		mcp.NewTool("apex.order.status",
			mcp.WithDescription("Query the current state of a single order."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("order_id", mcp.Required()),
		),
		handleOrderStatus,
	)
}

func handleOrderPlace(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	order := mapParam(request.GetArguments(), "order")
	if order == nil {
		return jsonResult(apexError("APEX_4011", "validation", "order is required"))
	}

	orderType := strParam(order, "order_type", "market")
	quantity := floatParam(order, "quantity", 0)
	clientOrderID := strParam(order, "client_order_id", "")

	if orderType == "limit" {
		if _, ok := order["limit_price"]; !ok {
			return jsonResult(apexError("APEX_4011", "validation", "limit_price required for limit orders"))
		}
	}

	isMarketOrder := orderType == "market"
	var clientOrderValue any
	if clientOrderID != "" {
		clientOrderValue = clientOrderID
	}

	var fillPrice any
	var positionID any
	fillQuantity := 0.0
	remainingQuantity := quantity

	if isMarketOrder {
		fillPrice = 1.08755
		fillQuantity = quantity
		remainingQuantity = 0
		positionID = "pos_001"
	}

	return jsonResult(orderPlacementResponse{
		OrderID:           fmt.Sprintf("ord_%s", uuid.NewString()[:8]),
		ClientOrderID:     clientOrderValue,
		Status:            map[bool]string{true: "filled", false: "working"}[isMarketOrder],
		FillPrice:         fillPrice,
		FillQuantity:      fillQuantity,
		RemainingQuantity: remainingQuantity,
		PositionID:        positionID,
		RejectionReason:   nil,
		CreatedAt:         nowISO(),
	})
}

func handleOrderModify(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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

	return jsonResult(orderModifyResponse{
		TargetType:      targetType,
		TargetID:        strParam(args, "target_id", ""),
		Status:          "modified",
		RejectionReason: nil,
		UpdatedAt:       nowISO(),
	})
}

func handleOrderCancel(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(orderCancelResponse{
		OrderID:         strParam(request.GetArguments(), "order_id", ""),
		Status:          "cancelled",
		RejectionReason: nil,
		CancelledAt:     nowISO(),
	})
}

func handleOrderStatus(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(orderStatusResponse{
		OrderID:        strParam(request.GetArguments(), "order_id", ""),
		Status:         "working",
		FilledQuantity: 0,
		AsOf:           nowISO(),
	})
}
