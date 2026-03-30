package org.apexstandard.reference;

import java.util.List;
import java.util.Map;

final class ProtocolModels {
    private ProtocolModels() {
    }

    record ApexError(String code, String category, String message, Object details, String request_id, Integer retry_after) {
    }

    record ApexErrorEnvelope(ApexError error) {
    }

    record SessionResponse(
        String session_id,
        String account_id,
        String expires_at,
        List<String> capabilities,
        List<String> profiles,
        String broker_id,
        String broker_name
    ) {
    }

    record CapabilitiesResponse(
        String apex_version,
        String broker_id,
        List<String> core_tools,
        Map<String, String> profiles,
        Object vendor_extensions,
        Map<String, Integer> rate_limits,
        List<String> supported_order_types,
        List<String> supported_tif,
        Map<String, Boolean> production_profiles,
        Object realtime_contract
    ) {
    }

    record HeartbeatResponse(String timestamp, String status) {
    }

    record AccountSummaryResponse(
        String account_id,
        String account_base_currency,
        String response_currency,
        double balance,
        double equity,
        double used_margin,
        double free_margin,
        double margin_level_pct,
        double unrealised_pnl,
        double realised_pnl_today,
        String as_of
    ) {
    }

    record PositionProfileData(
        double rollover_long_daily,
        double rollover_short_daily,
        double accrued_rollover,
        double pip_value,
        String pip_value_currency
    ) {
    }

    record Position(
        String position_id,
        String instrument_id,
        String broker_symbol,
        String side,
        int quantity,
        String quantity_unit,
        String broker_quantity,
        String broker_quantity_unit,
        double open_price,
        double current_price,
        double unrealised_pnl,
        String unrealised_pnl_currency,
        double used_margin,
        String open_time,
        double stop_loss,
        double take_profit,
        PositionProfileData profile_data
    ) {
    }

    record AccountPositionsResponse(List<Position> positions, double total_unrealised_pnl, String as_of) {
    }

    record OrderListResponse(List<Object> orders, String as_of) {
    }

    record AccountHistoryResponse(List<Object> events, Object next_cursor, boolean has_more) {
    }

    record OrderPlacementResponse(
        String order_id,
        Object client_order_id,
        String status,
        Object fill_price,
        double fill_quantity,
        double remaining_quantity,
        Object position_id,
        Object rejection_reason,
        String created_at
    ) {
    }

    record OrderModifyResponse(String target_type, String target_id, String status, Object rejection_reason, String updated_at) {
    }

    record OrderCancelResponse(String order_id, String status, Object rejection_reason, String cancelled_at) {
    }

    record MarketQuoteResponse(
        String instrument_id,
        String broker_symbol,
        double bid,
        double ask,
        double mid,
        double spread,
        String timestamp,
        boolean is_tradeable,
        String market_status
    ) {
    }

    record MarketSnapshotResponse(String instrument_id, String timeframe, List<Object> candles) {
    }

    record SearchInstrument(String instrument_id, String broker_symbol, String display_name, String profile, boolean is_tradeable) {
    }

    record MarketSearchResponse(List<SearchInstrument> instruments) {
    }

    record TradingHours(String day, String open, String close, String timezone) {
    }

    record MarketDetailsResponse(
        String instrument_id,
        String broker_symbol,
        String display_name,
        String profile,
        String base_currency,
        String quote_currency,
        double pip_size,
        int lot_size,
        String quantity_unit,
        String broker_quantity_unit,
        int min_quantity,
        int max_quantity,
        int quantity_step,
        double margin_rate_pct,
        double commission_per_lot,
        String spread_type,
        double typical_spread_pips,
        List<TradingHours> trading_hours,
        Map<String, Object> profile_data
    ) {
    }

    record RiskCheckResponse(
        boolean approved,
        double required_margin,
        double available_margin,
        double margin_after_trade,
        double exposure_increase,
        List<Object> warnings,
        Object rejection_reason
    ) {
    }

    record RiskLimitsResponse(
        String account_id,
        int max_position_size,
        int max_open_orders,
        double daily_loss_limit,
        double daily_loss_used,
        int margin_call_level_pct,
        int stop_out_level_pct,
        List<Object> restricted_instruments,
        boolean kill_switch_active
    ) {
    }

    // FX profile records

    record FxRolloverResponse(
        String instrument_id,
        String broker_symbol,
        double rollover_long,
        double rollover_short,
        String rollover_currency,
        String rollover_per,
        int lot_size,
        String triple_rollover_day,
        String next_rollover_time,
        String as_of
    ) {
    }

    record ExposureEntry(
        String currency,
        long net_units,
        String net_direction,
        double value_in_base,
        List<String> contributing_positions
    ) {
    }

    record FxExposureResponse(
        String account_id,
        String base_currency,
        List<ExposureEntry> exposures,
        double total_gross_exposure,
        String as_of
    ) {
    }

    record FxConversionResponse(
        String from_currency,
        String to_currency,
        double rate,
        double converted_amount,
        String timestamp
    ) {
    }

    record PositionCloseResponse(
        String order_id,
        String position_id,
        String status,
        double fill_price,
        double fill_quantity,
        double remaining_quantity,
        String closed_at
    ) {
    }

    // CFD profile records

    record CfdCorporateActionsResponse(List<Object> corporate_actions) {
    }

    record CfdDividendAdjustmentResponse(List<Object> adjustments) {
    }

    // Crypto profile records

    record CryptoFundingRateResponse(
        String instrument_id,
        String broker_symbol,
        double current_rate,
        double current_rate_annualised,
        double predicted_rate,
        int funding_interval_hours,
        String next_funding_time,
        long countdown_seconds,
        double index_price,
        double mark_price,
        String timestamp
    ) {
    }

    record CryptoLiquidationEstimateResponse(
        String instrument_id,
        String side,
        double entry_price,
        double liquidation_price,
        double margin_required,
        double maintenance_margin,
        String margin_currency,
        double distance_pct,
        List<Object> warnings
    ) {
    }

    record CryptoTransferResponse(
        String transfer_id,
        String from_wallet,
        String to_wallet,
        String currency,
        double amount,
        String status,
        Object rejection_reason,
        String completed_at
    ) {
    }
}
