use chrono::Timelike;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ApexError {
    code: String,
    category: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
    request_id: String,
    retry_after: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ApexErrorResponse {
    error: ApexError,
}

pub fn apex_error(
    code: &str,
    category: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> ApexErrorResponse {
    ApexErrorResponse {
        error: ApexError {
            code: code.to_owned(),
            category: category.to_owned(),
            message: message.to_owned(),
            details,
            request_id: uuid::Uuid::new_v4().to_string(),
            retry_after: (category == "rate_limit").then_some(1),
        },
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn hours_ago(hours: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::hours(hours))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn hours_from_now(hours: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::hours(hours))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Compute the next 8-hour funding boundary (00:00, 08:00, 16:00 UTC).
pub fn next_funding_time() -> (String, i64) {
    let now = chrono::Utc::now();
    let current_hour = now.hour();
    let next_boundary = ((current_hour / 8) + 1) * 8;
    let next = if next_boundary >= 24 {
        (now.date_naive() + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .expect("valid time")
            .and_utc()
    } else {
        now.date_naive()
            .and_hms_opt(next_boundary, 0, 0)
            .expect("valid time")
            .and_utc()
    };
    let countdown = (next - now).num_seconds().max(0);
    (
        next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        countdown,
    )
}

/// Compute the next 21:00 UTC rollover time.
pub fn next_rollover_time() -> String {
    let now = chrono::Utc::now();
    let today_21 = now
        .date_naive()
        .and_hms_opt(21, 0, 0)
        .expect("valid time")
        .and_utc();
    let next = if today_21 > now {
        today_21
    } else {
        today_21 + chrono::Duration::days(1)
    };
    next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
