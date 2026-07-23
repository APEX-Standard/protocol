import { z } from "zod";

export const InstrumentIdSchema = z
  .string()
  .regex(
    /^APEX:[A-Z]+:[A-Z0-9:.]+$/,
    "Must be a valid APEX canonical instrument ID (e.g. APEX:FX:EURUSD)",
  );

export const SideSchema = z.enum(["buy", "sell"]);
export const OrderTypeSchema = z.enum(["market", "limit", "stop", "stop_limit"]);
export const TifSchema = z.enum(["GTC", "IOC", "FOK", "DAY"]);

export const PriceStopSchema = z
  .object({
    type: z.enum(["price", "pips", "ticks", "percent"]),
    value: z.number().positive(),
  })
  .optional();

export const TrailingStopSchema = z
  .object({
    type: z.enum(["pips", "ticks", "percent"]),
    value: z.number().positive(),
  })
  .optional();
