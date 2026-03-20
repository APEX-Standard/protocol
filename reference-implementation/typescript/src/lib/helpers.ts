export type ApexErrorCategory =
  | "auth"
  | "validation"
  | "risk"
  | "broker"
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

export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
