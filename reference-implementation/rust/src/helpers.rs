use rmcp::model::{CallToolResult, Content};
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

pub fn json_result<T>(payload: &T) -> CallToolResult
where
    T: Serialize,
{
    CallToolResult::success(vec![Content::text(
        serde_json::to_string(payload).expect("reference responses should serialize"),
    )])
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
