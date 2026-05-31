package main

import (
	"fmt"

	"github.com/google/uuid"
)

// ApexNotification represents a rich APEX-specific notification envelope.
type ApexNotification struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// buildApexNotification constructs a JSON-RPC notification with the APEX envelope.
func buildApexNotification(method string, opts struct {
	AccountID    string
	InstrumentID string
	ResourceURI  string
	Sequence     int
	Payload      map[string]any
}) map[string]any {
	if opts.AccountID == "" {
		opts.AccountID = referenceAccountID
	}
	if opts.InstrumentID == "" {
		opts.InstrumentID = referenceInstrumentID
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params": map[string]any{
			"event_id":      fmt.Sprintf("evt_%s", uuid.NewString()[:8]),
			"event_type":    method,
			"account_id":    opts.AccountID,
			"instrument_id": opts.InstrumentID,
			"resource_uri":  opts.ResourceURI,
			"timestamp":     nowISO(),
			"sequence":      opts.Sequence,
			"payload":       opts.Payload,
		},
	}
}

// orderFilledNotification builds a notification for a fully filled order.
func orderFilledNotification(order referenceOrder, fillSequence int) map[string]any {
	accountID := order.AccountID
	if accountID == "" {
		accountID = referenceAccountID
	}
	fillPrice := "0"
	if fp, ok := order.AverageFillPrice.(string); ok {
		fillPrice = fp
	}
	return buildApexNotification("notifications/apex.order.filled", struct {
		AccountID    string
		InstrumentID string
		ResourceURI  string
		Sequence     int
		Payload      map[string]any
	}{
		AccountID:    accountID,
		InstrumentID: order.InstrumentID,
		ResourceURI:  fmt.Sprintf("apex://account/fills/%s", accountID),
		Sequence:     fillSequence,
		Payload: map[string]any{
			"order_id":      order.OrderID,
			"side":          order.Side,
			"fill_price":    fillPrice,
			"fill_quantity": order.FilledQuantity,
			"commission":    dec(-0.5),
			"position_id":   "pos_001",
		},
	})
}

// orderPartiallyFilledNotification builds a notification for a partially filled order.
func orderPartiallyFilledNotification(order referenceOrder, fillSequence int) map[string]any {
	accountID := order.AccountID
	if accountID == "" {
		accountID = referenceAccountID
	}
	fillPrice := "0"
	if fp, ok := order.AverageFillPrice.(string); ok {
		fillPrice = fp
	}
	return buildApexNotification("notifications/apex.order.partially_filled", struct {
		AccountID    string
		InstrumentID string
		ResourceURI  string
		Sequence     int
		Payload      map[string]any
	}{
		AccountID:    accountID,
		InstrumentID: order.InstrumentID,
		ResourceURI:  fmt.Sprintf("apex://account/fills/%s", accountID),
		Sequence:     fillSequence,
		Payload: map[string]any{
			"order_id":           order.OrderID,
			"side":               order.Side,
			"fill_price":         fillPrice,
			"fill_quantity":      order.FilledQuantity,
			"remaining_quantity": order.RemainingQuantity,
		},
	})
}

// orderRejectedNotification builds a notification for a rejected order.
func orderRejectedNotification(code, reason string, riskSequence int) map[string]any {
	return buildApexNotification("notifications/apex.order.rejected", struct {
		AccountID    string
		InstrumentID string
		ResourceURI  string
		Sequence     int
		Payload      map[string]any
	}{
		ResourceURI: fmt.Sprintf("apex://account/risk/%s", referenceAccountID),
		Sequence:    riskSequence,
		Payload: map[string]any{
			"code":   code,
			"reason": reason,
		},
	})
}

// candleClosedNotification builds a notification for a closed candle.
func candleClosedNotification(instrumentID, timeframe string, candle CandleState, candleSequence int) map[string]any {
	return buildApexNotification("notifications/apex.market.candle_closed", struct {
		AccountID    string
		InstrumentID string
		ResourceURI  string
		Sequence     int
		Payload      map[string]any
	}{
		InstrumentID: instrumentID,
		ResourceURI:  fmt.Sprintf("apex://market/candles/%s?timeframe=%s&limit=200", instrumentID, timeframe),
		Sequence:     candleSequence,
		Payload: map[string]any{
			"instrument_id": instrumentID,
			"timeframe":     timeframe,
			"open":          dec(candle.Open),
			"high":          dec(candle.High),
			"low":           dec(candle.Low),
			"close":         dec(candle.Close),
			"volume":        candle.Volume,
			"complete":      true,
		},
	})
}

// killSwitchEngagedNotification builds a notification for kill switch activation.
func killSwitchEngagedNotification(riskSequence int) map[string]any {
	return buildApexNotification("notifications/apex.risk.kill_switch_engaged", struct {
		AccountID    string
		InstrumentID string
		ResourceURI  string
		Sequence     int
		Payload      map[string]any
	}{
		ResourceURI: fmt.Sprintf("apex://account/risk/%s", referenceAccountID),
		Sequence:    riskSequence,
		Payload: map[string]any{
			"account_id": referenceAccountID,
			"reason":     "Daily loss limit exceeded",
		},
	})
}
