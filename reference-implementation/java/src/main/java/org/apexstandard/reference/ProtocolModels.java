package org.apexstandard.reference;

import java.util.List;
import java.util.Map;

final class ProtocolModels {
    private ProtocolModels() {
    }

    /**
     * Encodes a numeric value as a string-decimal matching the wire pattern
     * {@code ^-?[0-9]+(\.[0-9]+)?$}. Avoids scientific notation and trailing
     * zeros so {@code 5000.0} renders as "5000" and {@code 1.0875} as "1.0875".
     */
    static String dec(double v) {
        if (v == 0.0) {
            return "0";
        }
        return java.math.BigDecimal.valueOf(v).stripTrailingZeros().toPlainString();
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
        String balance,
        String equity,
        String used_margin,
        String free_margin,
        String margin_level_pct,
        String unrealised_pnl,
        String realised_pnl_today,
        String as_of
    ) {
    }

    record PositionProfileData(
        String rollover_long_daily,
        String rollover_short_daily,
        String accrued_rollover,
        String pip_value,
        String pip_value_currency
    ) {
    }

    record Position(
        String position_id,
        String instrument_id,
        String broker_symbol,
        String side,
        String quantity,
        String quantity_unit,
        String broker_quantity,
        String broker_quantity_unit,
        String open_price,
        String current_price,
        String unrealised_pnl,
        String unrealised_pnl_currency,
        String used_margin,
        String open_time,
        String stop_loss,
        String take_profit,
        PositionProfileData profile_data
    ) {
    }

    record AccountPositionsResponse(List<Position> positions, String total_unrealised_pnl, String as_of) {
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
        String fill_quantity,
        String remaining_quantity,
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
        String bid,
        String ask,
        String mid,
        String spread,
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
        String pip_size,
        int lot_size,
        String quantity_unit,
        String broker_quantity_unit,
        String min_quantity,
        String max_quantity,
        String quantity_step,
        String margin_rate_pct,
        String commission_per_lot,
        String spread_type,
        String typical_spread_pips,
        List<TradingHours> trading_hours,
        Map<String, Object> profile_data
    ) {
    }

    record RiskCheckResponse(
        boolean approved,
        String required_margin,
        String available_margin,
        String margin_after_trade,
        String exposure_increase,
        List<Object> warnings,
        Object rejection_reason
    ) {
    }

    record RiskLimitsResponse(
        String account_id,
        String max_position_size,
        int max_open_orders,
        String daily_loss_limit,
        String daily_loss_used,
        String margin_call_level_pct,
        String stop_out_level_pct,
        List<Object> restricted_instruments,
        boolean kill_switch_active
    ) {
    }

    // FX profile records

    record FxRolloverResponse(
        String instrument_id,
        String broker_symbol,
        String rollover_long,
        String rollover_short,
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
        String net_units,
        String net_direction,
        String value_in_base,
        List<String> contributing_positions
    ) {
    }

    record FxExposureResponse(
        String account_id,
        String base_currency,
        List<ExposureEntry> exposures,
        String total_gross_exposure,
        String as_of
    ) {
    }

    record FxConversionResponse(
        String from_currency,
        String to_currency,
        String rate,
        String converted_amount,
        String timestamp
    ) {
    }

    record PositionCloseResponse(
        String order_id,
        String position_id,
        String status,
        String fill_price,
        String fill_quantity,
        String remaining_quantity,
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
        String current_rate,
        String current_rate_annualised,
        String predicted_rate,
        int funding_interval_hours,
        String next_funding_time,
        long countdown_seconds,
        String index_price,
        String mark_price,
        String timestamp
    ) {
    }

    record CryptoLiquidationEstimateResponse(
        String instrument_id,
        String side,
        String entry_price,
        String liquidation_price,
        String margin_required,
        String maintenance_margin,
        String margin_currency,
        String distance_pct,
        List<Object> warnings
    ) {
    }

    record CryptoTransferResponse(
        String transfer_id,
        String from_wallet,
        String to_wallet,
        String currency,
        String amount,
        String status,
        Object rejection_reason,
        String completed_at
    ) {
    }
}
