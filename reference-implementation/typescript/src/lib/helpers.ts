export type ApexErrorCategory =
  | "auth"
  | "validation"
  | "risk"
  | "broker"
  | "operational"
  | "rate_limit"
  | "internal";

export interface ApexErrorPayload extends Record<string, unknown> {
  error: {
    code: string;
    category: ApexErrorCategory;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
    retry_after: number | null;
  };
}

export function apexError(
  code: string,
  category: ApexErrorCategory,
  message: string,
  details?: Record<string, unknown>,
): ApexErrorPayload {
  return {
    error: {
      code,
      category,
      message,
      details,
      request_id: crypto.randomUUID(),
      retry_after: category === "rate_limit" ? 1 : null,
    },
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

// APEX 0.2.0-alpha: encode a numeric money/price/rate/quantity value as a
// string-encoded decimal for the JSON wire (pattern ^-?[0-9]+(\.[0-9]+)?$).
// Internal arithmetic stays numeric; only wire output is wrapped in dec(...).
// dec(5000) -> "5000", dec(1.0875) -> "1.0875", dec(-7.5) -> "-7.5".
export const dec = (v: number): string => v.toString();

export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
