package main

type sessionResponse struct {
	SessionID    string   `json:"session_id"`
	AccountID    string   `json:"account_id"`
	ExpiresAt    string   `json:"expires_at"`
	Capabilities []string `json:"capabilities"`
	Profiles     []string `json:"profiles"`
	BrokerID     string   `json:"broker_id"`
	BrokerName   string   `json:"broker_name"`
}

type capabilitiesResponse struct {
	ApexVersion         string            `json:"apex_version"`
	BrokerID            string            `json:"broker_id"`
	CoreTools           []string          `json:"core_tools"`
	Profiles            map[string]string `json:"profiles"`
	VendorExtensions    any               `json:"vendor_extensions"`
	RateLimits          map[string]int    `json:"rate_limits"`
	SupportedOrderTypes []string          `json:"supported_order_types"`
	SupportedTif        []string          `json:"supported_tif"`
	RealtimeContract    map[string]any    `json:"realtime_contract,omitempty"`
}

type accountSummaryResponse struct {
	AccountID           string  `json:"account_id"`
	AccountBaseCurrency string  `json:"account_base_currency"`
	ResponseCurrency    string  `json:"response_currency"`
	Balance             float64 `json:"balance"`
	Equity              float64 `json:"equity"`
	UsedMargin          float64 `json:"used_margin"`
	FreeMargin          float64 `json:"free_margin"`
	MarginLevelPct      float64 `json:"margin_level_pct"`
	UnrealisedPnL       float64 `json:"unrealised_pnl"`
	RealisedPnLToday    float64 `json:"realised_pnl_today"`
	AsOf                string  `json:"as_of"`
}

type profileData struct {
	RolloverLongDaily  float64 `json:"rollover_long_daily"`
	RolloverShortDaily float64 `json:"rollover_short_daily"`
	AccruedRollover    float64 `json:"accrued_rollover"`
	PipValue           float64 `json:"pip_value"`
	PipValueCurrency   string  `json:"pip_value_currency"`
}

type position struct {
	PositionID            string      `json:"position_id"`
	InstrumentID          string      `json:"instrument_id"`
	BrokerSymbol          string      `json:"broker_symbol"`
	Side                  string      `json:"side"`
	Quantity              int         `json:"quantity"`
	QuantityUnit          string      `json:"quantity_unit"`
	BrokerQuantity        string      `json:"broker_quantity"`
	BrokerQuantityUnit    string      `json:"broker_quantity_unit"`
	OpenPrice             float64     `json:"open_price"`
	CurrentPrice          float64     `json:"current_price"`
	UnrealisedPnL         float64     `json:"unrealised_pnl"`
	UnrealisedPnLCurrency string      `json:"unrealised_pnl_currency"`
	UsedMargin            float64     `json:"used_margin"`
	OpenTime              string      `json:"open_time"`
	StopLoss              float64     `json:"stop_loss"`
	TakeProfit            float64     `json:"take_profit"`
	ProfileData           profileData `json:"profile_data"`
}

type accountPositionsResponse struct {
	Positions          []position `json:"positions"`
	TotalUnrealisedPnL float64    `json:"total_unrealised_pnl"`
	AsOf               string     `json:"as_of"`
}

type orderListResponse struct {
	Orders []any  `json:"orders"`
	AsOf   string `json:"as_of"`
}

type historyResponse struct {
	Events     []any `json:"events"`
	NextCursor any   `json:"next_cursor"`
	HasMore    bool  `json:"has_more"`
}

type orderPlacementResponse struct {
	OrderID           string  `json:"order_id"`
	ClientOrderID     any     `json:"client_order_id"`
	Status            string  `json:"status"`
	FillPrice         any     `json:"fill_price"`
	FillQuantity      float64 `json:"fill_quantity"`
	RemainingQuantity float64 `json:"remaining_quantity"`
	PositionID        any     `json:"position_id"`
	RejectionReason   any     `json:"rejection_reason"`
	CreatedAt         string  `json:"created_at"`
}

type orderModifyResponse struct {
	TargetType      string `json:"target_type"`
	TargetID        string `json:"target_id"`
	Status          string `json:"status"`
	RejectionReason any    `json:"rejection_reason"`
	UpdatedAt       string `json:"updated_at"`
}

type orderCancelResponse struct {
	OrderID         string `json:"order_id"`
	Status          string `json:"status"`
	RejectionReason any    `json:"rejection_reason"`
	CancelledAt     string `json:"cancelled_at"`
}

type quoteResponse struct {
	InstrumentID string  `json:"instrument_id"`
	BrokerSymbol string  `json:"broker_symbol"`
	Bid          float64 `json:"bid"`
	Ask          float64 `json:"ask"`
	Mid          float64 `json:"mid"`
	Spread       float64 `json:"spread"`
	Timestamp    string  `json:"timestamp"`
	IsTradeable  bool    `json:"is_tradeable"`
	MarketStatus string  `json:"market_status"`
}

type snapshotResponse struct {
	InstrumentID string `json:"instrument_id"`
	Timeframe    string `json:"timeframe"`
	Candles      []any  `json:"candles"`
}

type instrumentSearchResult struct {
	InstrumentID string `json:"instrument_id"`
	BrokerSymbol string `json:"broker_symbol"`
	DisplayName  string `json:"display_name"`
	Profile      string `json:"profile"`
	IsTradeable  bool   `json:"is_tradeable"`
}

type marketSearchResponse struct {
	Instruments []instrumentSearchResult `json:"instruments"`
}

type tradingHours struct {
	Day      string `json:"day"`
	Open     string `json:"open"`
	Close    string `json:"close"`
	Timezone string `json:"timezone"`
}

type marketDetailsResponse struct {
	InstrumentID       string         `json:"instrument_id"`
	BrokerSymbol       string         `json:"broker_symbol"`
	DisplayName        string         `json:"display_name"`
	Profile            string         `json:"profile"`
	BaseCurrency       string         `json:"base_currency"`
	QuoteCurrency      string         `json:"quote_currency"`
	PipSize            float64        `json:"pip_size"`
	LotSize            int            `json:"lot_size"`
	QuantityUnit       string         `json:"quantity_unit"`
	BrokerQuantityUnit string         `json:"broker_quantity_unit"`
	MinQuantity        int            `json:"min_quantity"`
	MaxQuantity        int            `json:"max_quantity"`
	QuantityStep       int            `json:"quantity_step"`
	MarginRatePct      float64        `json:"margin_rate_pct"`
	CommissionPerLot   float64        `json:"commission_per_lot"`
	SpreadType         string         `json:"spread_type"`
	TypicalSpreadPips  float64        `json:"typical_spread_pips"`
	TradingHours       []tradingHours `json:"trading_hours"`
	ProfileData        map[string]any `json:"profile_data"`
}

type riskCheckResponse struct {
	Approved         bool    `json:"approved"`
	RequiredMargin   float64 `json:"required_margin"`
	AvailableMargin  float64 `json:"available_margin"`
	MarginAfterTrade float64 `json:"margin_after_trade"`
	ExposureIncrease float64 `json:"exposure_increase"`
	Warnings         []any   `json:"warnings"`
	RejectionReason  any     `json:"rejection_reason"`
}

type riskLimitsResponse struct {
	AccountID             string  `json:"account_id"`
	MaxPositionSize       int     `json:"max_position_size"`
	MaxOpenOrders         int     `json:"max_open_orders"`
	DailyLossLimit        float64 `json:"daily_loss_limit"`
	DailyLossUsed         float64 `json:"daily_loss_used"`
	MarginCallLevelPct    int     `json:"margin_call_level_pct"`
	StopOutLevelPct       int     `json:"stop_out_level_pct"`
	RestrictedInstruments []any   `json:"restricted_instruments"`
	KillSwitchActive      bool    `json:"kill_switch_active"`
}
