package main

import (
	"context"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const (
	perpInstrumentID = "APEX:CRYPTO:PERP:BTCUSDT"
	perpBrokerSymbol = "BTCUSDT"
)

// nextFundingTime computes the next 8-hour funding boundary (00:00, 08:00, 16:00 UTC).
func nextFundingTime() (string, int) {
	now := time.Now().UTC()
	currentHour := now.Hour()
	nextBoundary := ((currentHour / 8) + 1) * 8
	next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if nextBoundary >= 24 {
		next = next.AddDate(0, 0, 1)
	} else {
		next = next.Add(time.Duration(nextBoundary) * time.Hour)
	}
	countdown := int(math.Max(0, next.Sub(now).Seconds()))
	return next.Format(time.RFC3339), countdown
}

func registerCryptoToolsWithState(s *server.MCPServer, st *referenceState) {
	// apex.crypto.funding_rate
	s.AddTool(
		mcp.NewTool("apex.crypto.funding_rate",
			mcp.WithDescription("Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("instrument_id", mcp.Required(), mcp.Description("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			instrumentID := strParam(args, "instrument_id", "")

			if instrumentID != perpInstrumentID {
				return jsonResult(apexError("APEX_4010", "validation", "Unknown instrument"))
			}

			fundingTime, countdown := nextFundingTime()

			return jsonResult(map[string]any{
				"instrument_id":         perpInstrumentID,
				"broker_symbol":         perpBrokerSymbol,
				"current_rate":          0.0001,
				"current_rate_annualised": 0.1095,
				"predicted_rate":        0.00012,
				"funding_interval_hours": 8,
				"next_funding_time":     fundingTime,
				"countdown_seconds":     countdown,
				"index_price":           50000.00,
				"mark_price":            50050.00,
				"timestamp":             nowISO(),
			})
		},
	)

	// apex.crypto.liquidation_estimate
	s.AddTool(
		mcp.NewTool("apex.crypto.liquidation_estimate",
			mcp.WithDescription("Estimate liquidation price for a perpetual position based on leverage and margin mode."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("instrument_id", mcp.Required(), mcp.Description("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)")),
			mcp.WithString("side", mcp.Required(), mcp.Description("Position side: buy or sell")),
			mcp.WithNumber("quantity", mcp.Required(), mcp.Description("Position quantity")),
			mcp.WithNumber("leverage", mcp.Required(), mcp.Description("Leverage multiplier")),
			mcp.WithString("margin_mode", mcp.Required(), mcp.Description("Margin mode: cross or isolated")),
			mcp.WithNumber("entry_price", mcp.Required(), mcp.Description("Entry price")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			instrumentID := strParam(args, "instrument_id", "")

			if instrumentID != perpInstrumentID {
				return jsonResult(apexError("APEX_4010", "validation", "Unknown instrument"))
			}

			side := strParam(args, "side", "buy")
			quantity := floatParam(args, "quantity", 0)
			leverage := floatParam(args, "leverage", 1)
			entryPrice := floatParam(args, "entry_price", 0)

			marginRequired := (entryPrice * quantity) / leverage
			maintenanceMargin := marginRequired / 2

			var liquidationPrice float64
			if side == "buy" {
				liquidationPrice = entryPrice * (1 - (1/leverage)*0.95)
			} else {
				liquidationPrice = entryPrice * (1 + (1/leverage)*0.95)
			}
			liquidationPrice = math.Round(liquidationPrice*100) / 100

			distancePct := math.Round(math.Abs(entryPrice-liquidationPrice)/entryPrice*100*100) / 100

			return jsonResult(map[string]any{
				"instrument_id":      perpInstrumentID,
				"side":               side,
				"entry_price":        entryPrice,
				"liquidation_price":  liquidationPrice,
				"margin_required":    math.Round(marginRequired*100) / 100,
				"maintenance_margin": math.Round(maintenanceMargin*100) / 100,
				"margin_currency":    "USDT",
				"distance_pct":       distancePct,
				"warnings":           []any{},
			})
		},
	)

	// apex.crypto.transfer
	s.AddTool(
		mcp.NewTool("apex.crypto.transfer",
			mcp.WithDescription("Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion."),
			mcp.WithReadOnlyHintAnnotation(false),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(false),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("from_wallet", mcp.Required(), mcp.Description("Source wallet: spot, futures, or funding")),
			mcp.WithString("to_wallet", mcp.Required(), mcp.Description("Destination wallet: spot, futures, or funding")),
			mcp.WithString("currency", mcp.Required(), mcp.Description("Currency to transfer (e.g. USDT)")),
			mcp.WithNumber("amount", mcp.Required(), mcp.Description("Amount to transfer")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			accountID := strParam(args, "account_id", "")
			fromWallet := strParam(args, "from_wallet", "")
			toWallet := strParam(args, "to_wallet", "")
			currency := strParam(args, "currency", "")
			amount := floatParam(args, "amount", 0)

			if accountID == "" || fromWallet == "" || toWallet == "" || currency == "" {
				return jsonResult(apexError("APEX_4011", "validation", "All fields are required: account_id, from_wallet, to_wallet, currency, amount"))
			}

			if fromWallet == toWallet {
				return jsonResult(apexError("APEX_4011", "validation", "from_wallet and to_wallet must be different"))
			}

			return jsonResult(map[string]any{
				"transfer_id":     uuid.NewString(),
				"from_wallet":     fromWallet,
				"to_wallet":       toWallet,
				"currency":        currency,
				"amount":          amount,
				"status":          "completed",
				"rejection_reason": nil,
				"completed_at":    nowISO(),
			})
		},
	)
}
