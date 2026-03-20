export const SERVER_NAME = "apex-reference";
export const SERVER_VERSION = "0.1.0";

export const CORE_TOOL_CAPABILITIES = [
  "apex.session.*",
  "apex.account.*",
  "apex.order.*",
  "apex.market.*",
  "apex.risk.*",
] as const;

export const SUPPORTED_PROFILES = ["fx"] as const;
export const SUPPORTED_ORDER_TYPES = ["market", "limit", "stop", "stop_limit"] as const;
export const SUPPORTED_TIF = ["GTC", "IOC", "FOK", "DAY"] as const;
