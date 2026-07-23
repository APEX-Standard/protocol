# RFC-0002: Futures Asset Class Profile

**Status:** Accepted
**Author(s):** APEX TAC
**Created:** 2026-07-23
**Target Version:** 0.3.0-alpha

---

## Summary

Introduce a Layer 2 **Futures Profile** ([`spec/profiles/futures.md`](../../spec/profiles/futures.md)) covering exchange-listed futures contracts, and introduce the top-level `APEX:FUT:` instrument namespace — superseding the `APEX:DERIV:{TYPE}:{UNDERLYING}` umbrella reserved (never populated) in `0.1.0-alpha`, which is retired by this RFC. The profile adds futures position `profile_data` (contract identity, expiration, settlement, two-tier margin), two profile tools (`apex.futures.contract_chain`, `apex.futures.margin_schedule`), and a seed registry of major contract roots. Brokers declare `"futures"` in `apex.session.capabilities`.

## Motivation

- **Listed futures are a major asset class with no APEX coverage.** The existing profiles (FX, CFD, Crypto) cover margined OTC and exchange-crypto products, but not regulated derivatives exchanges — equity index, energy, metals, rates, currency, and agricultural futures. Futures brokers and platforms cannot currently claim any APEX profile that matches their product.
- **Top-level `FUT` matches how real markets classify.** ISO 10962 (CFI) makes Futures (category `F`) and Options (category `O`) top-level instrument categories — there is no "derivatives" parent in CFI. FIX `SecurityType` uses flat `FUT`/`OPT`. Regulators split them (CFTC vs SEC), and every platform markets "futures" and "options" as distinct asset classes; "derivatives" is a legal/risk umbrella, not a product-taxonomy segment. Top-level `FUT` also makes the asset-class↔profile mapping 1:1 (`FX`↔fx, `CFD`↔cfd, `CRYPTO`↔crypto, `FUT`↔futures) and shortens every permanent ID by a segment. The `DERIV` umbrella reserved in `0.1.0-alpha` was never populated, so retiring it has no compatibility impact; `APEX:OPT:` is reserved for a future options profile.
- **Futures have mechanics no existing profile expresses.** Dated contract expiration and rolls, front-month resolution, exchange-set (SPAN) initial/maintenance margin vs broker-set intraday margin, daily mark-to-market settlement, and physical-delivery first-notice protection have no analog in FX rollover, CFD financing, or perpetual funding.
- **Adding a profile is a compatible change.** [`spec/core/stability.md`](../../spec/core/stability.md) §3.1 lists "adding new profiles" as compatible pre-`1.0.0`. Core changes are limited to compatible enum expansions (`ticks` protective offsets, `variation_margin` history subtype) plus the replacement of the never-implemented `derivatives` placeholder in the search-filter enum (see Proposal); a plain core order object trades futures because contract identity (including expiry) is fully encoded in the dated instrument ID.

The profile is implementation-neutral: any futures trading firm can implement it exactly as written. Exchange and contract references are illustrative market infrastructure, never endorsements.

## Proposal

- **Instrument identity** — dated contracts `APEX:FUT:{ROOT}{MONTH_CODE}{YY}` (e.g. `APEX:FUT:ESZ26`; standard month codes `F`–`Z`; two-digit year to avoid decade ambiguity in permanent IDs). Bare roots (`APEX:FUT:ES`) identify the contract family for registry metadata and continuous market-data series; orders targeting a root are rejected. Expired contracts become `"status": "inactive"` and are never recycled.
- **Position `profile_data`** — `root`, `category`, `exchange` (ISO 10383 MIC), `contract_month`, `expiration_date`, `first_notice_date`, `days_to_expiration`, `settlement_type` (cash|physical), `contract_size`, `contract_unit`, `tick_size`, `tick_value`, `point_value`/`point_value_currency`, `initial_margin`, `maintenance_margin`, `day_trading_margin`, `prior_settlement_price`. Monetary fields are string-decimals per RFC-0001; **`contract_size` is also string-decimal in this profile** (fractional micro contract sizes, e.g. 0.1 BTC — see RFC-0001's amendment note).
- **Instrument details `profile_data`** — `apex.market.details` returns the same contract specification pre-trade, plus a `sessions` structure (`eth`/`rth`/`maintenance` typing with overnight-span semantics) that the core `trading_hours` shape cannot express.
- **Order rules** — no mandatory order `profile_data`; the dated instrument ID carries contract identity. Normative core-field rules: whole-contract quantities (`quantity_unit: "contracts"`, integral only) and `ticks` protective offsets (core offset enums gain `ticks`; `pips` is rejected for futures). Positions are net per dated contract (no hedging mode).
- **Daily settlement in history** — variation-margin postings surface in `apex.account.history` as `event_type: "funding"` / `event_subtype: "variation_margin"` (core subtype enum expanded, compatible per stability §3.1).
- **Profile tools** — `apex.futures.contract_chain` (mandatory; resolve a root to dated contracts with expirations, volume/open-interest, front-month designation) and `apex.futures.margin_schedule` (recommended; per-contract exchange overnight and broker intraday margins with applicability hours).
- **Search filter** — `apex.market.search` `profile` enum becomes `fx|cfd|crypto|futures|fixed_income`; the placeholder `derivatives` value (no profile spec, no registered instruments) is replaced by `futures`.
- **Registry** — futures entry schema (canonical block with contract specs) and a seed registry of 16 major contract roots across equity index, energy, metals, rates, currency, and crypto categories, including micro contracts as distinct roots.
- **Conformance** — mandatory: Layer 1, futures `profile_data` on positions **and** `apex.market.details`, `contract_chain`, root-order rejection, whole-contract quantity enforcement, `ticks` protective-offset support, expired-contract exclusion from search defaults. Recommended: `margin_schedule`, intraday margin disclosure, `profile_data.sessions`, continuous root market data, first-notice protection.
- **Reference implementations** — all four bundled references (TypeScript, Go, Rust, Java) register both futures tools with aligned mock data (E-mini S&P 500 chain), smoke-verified by the conformance harness.

## Alternatives Considered

- **Populating the reserved `APEX:DERIV:FUT:` umbrella namespace.** Rejected (initially adopted, reversed before release): no market-data or trading standard uses a derivatives umbrella as a product classifier — ISO 10962 and FIX put futures and options at top level, and a derivatives parent added a segment to every permanent ID while breaking the 1:1 asset-class↔profile mapping. Since `DERIV` was never populated, retirement was free; it becomes prohibitively expensive the moment a partner integrates.
- **A single `derivatives` profile covering futures and options.** Rejected: options require strikes, exercise styles, and greeks that would bloat a shared profile; futures-only brokers should not carry undefined options surface. Options get their own profile when demand exists.
- **Encoding expiry in `profile_data` instead of the instrument ID.** Rejected: two contracts of different months are different instruments with different prices, margins, and lifecycles; giving them one ID would break quote/position identity throughout the core.
- **Single-digit year in dated IDs (`ESZ6`), matching some native symbologies.** Rejected: permanent identifiers cannot tolerate decade collision; broker mappings normalize native formats.

## Open Questions

None blocking. The following are explicitly deferred and documented in the profile's "Deferred Capabilities" section: expiration/roll push notifications (agents poll `contract_chain`/`days_to_expiration` in this version), holiday calendars and early closes (no profile models them yet), stop trigger method disclosure (last vs bid/ask — broker-specific today), and continuous-series construction for root IDs (back-adjustment method and roll timing are broker-defined; only the identity convention is normative). The two-digit-year century collision in dated IDs is acknowledged in the profile as out of scope for alpha.

## References

- [`spec/profiles/futures.md`](../../spec/profiles/futures.md) — the profile specification
- [`spec/registry/README.md`](../../spec/registry/README.md) — taxonomy, entry schema, seed registry
- [`docs/instrument-identity-design.md`](../../docs/instrument-identity-design.md) — namespace design rationale
- [`docs/profile-layering-design.md`](../../docs/profile-layering-design.md) — cross-profile differences matrix
- [`spec/core/stability.md`](../../spec/core/stability.md) — §3.1 profile-addition compatibility
- RFC-0001 — string-decimal wire encoding (applies to all monetary fields in this profile)
