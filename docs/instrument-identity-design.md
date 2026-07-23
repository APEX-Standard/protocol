# APEX Protocol — Instrument Identity and Registry Design

**Version:** `0.3.0-alpha`

---

## Overview

APEX assigns every tradeable instrument a canonical identifier that is permanent, hierarchical, and machine-parseable. The identifier follows a fixed namespace format — `APEX:{ASSET_CLASS}:{SUB_CLASS?}:{SYMBOL}` — and resolves unambiguously to one instrument regardless of which broker is quoting it. A separate Instrument Registry maps these canonical IDs to broker-native symbols, contract specifications, and asset class metadata. The registry plays a role analogous to ISIN for securities or LEI for legal entities: a stable identity layer that eliminates the symbol fragmentation plaguing broker API integrations today.

---

## The Problem

An agent wants to trade Euro/Dollar. It connects to five brokers. Here is what each broker calls the same instrument:

| Broker | Native Symbol |
|--------|--------------|
| Broker A | `EUR/USD` |
| Broker B | `EURUSD` |
| Broker C | `eurusd` |
| Broker D | `FX:EURUSD` |
| Broker E | `EUR_USD` |

Five brokers, five symbols, one instrument. The agent needs a translation table mapping every broker symbol to every other broker symbol for every instrument it wants to trade. This is not a hypothetical annoyance — it is the actual state of retail and institutional broker APIs.

Now multiply. An agent that trades 500 instruments across 10 brokers needs 5,000 symbol mappings maintained by hand. Every time a broker renames a symbol, adds a suffix, or changes casing, every mapping involving that broker breaks. Every time a new broker is onboarded, every instrument needs a new mapping entry. The mapping table grows as the product of instruments and brokers, not the sum.

This is the same fragmentation problem that ISIN solved for equities, that LEI solved for counterparty identification, and that DNS solved for host naming. The solution is always the same: assign a canonical identifier once, in a central registry, and let every participant map to and from that identifier independently.

APEX solves it with `APEX:FX:EURUSD`. One identifier. Every broker maps their native symbol to it. The agent never thinks about `EUR/USD` vs `EURUSD` vs `eurusd` — it thinks about `APEX:FX:EURUSD` and the protocol handles resolution.

---

## The Hierarchical Namespace

All APEX instrument IDs follow a four-part hierarchical format:

```
APEX:{ASSET_CLASS}:{SUB_CLASS?}:{SYMBOL}
```

The prefix `APEX:` is always present. The asset class is always present. The sub-class is present when the asset class has multiple instrument categories (CFDs have equity, index, and commodity sub-types; crypto has spot and perpetual sub-types). The symbol is always the final segment.

### Full Taxonomy

```
APEX:FX:{BASE}{QUOTE}              Spot FX and CFD FX
APEX:CFD:EQ:{TICKER}.{MIC}         Equity CFDs
APEX:CFD:IDX:{INDEX}               Index CFDs
APEX:CFD:COM:{COMMODITY}           Commodity CFDs
APEX:CRYPTO:SPOT:{BASE}{QUOTE}     Crypto spot
APEX:CRYPTO:PERP:{BASE}{QUOTE}     Crypto perpetual futures
APEX:FUT:{ROOT}{MC}{YY}?           Listed futures (root, or dated with month code + 2-digit year)
APEX:OPT:{...}                     Listed options (reserved, not yet populated)
APEX:FI:{ISIN}                     Fixed income (uses ISIN directly)
```

Walk through the tree with concrete examples:

**`APEX:FX:EURUSD`** — Euro/Dollar spot FX. No sub-class. The symbol is the ISO 4217 currency pair concatenated without separator: base `EUR`, quote `USD`. Precious metals use their ISO 4217 codes: `APEX:FX:XAUUSD` for gold, `APEX:FX:XAGUSD` for silver.

**`APEX:CFD:EQ:AAPL.XNAS`** — Apple equity CFD. Sub-class `EQ` for equities. The symbol is the ticker followed by a dot and the ISO 10383 MIC code of the primary listing venue. `XNAS` is NASDAQ. More on MIC codes in the next section.

**`APEX:CFD:IDX:SPX500`** — S&P 500 index CFD. Sub-class `IDX`. The symbol is a standardized index code defined in the APEX registry. Not a ticker, not a broker name — a canonical code that every broker maps to.

**`APEX:CFD:COM:WTIUSD`** — WTI crude oil commodity CFD. Sub-class `COM`. The symbol is a standardized commodity code. The `USD` suffix indicates the quote currency for commodities that could theoretically be quoted in multiple currencies.

**`APEX:CRYPTO:SPOT:BTCUSDT`** — Bitcoin/Tether spot. Sub-class `SPOT`. The symbol follows the same base/quote concatenation as FX. The quote currency `USDT` (Tether) tells you the settlement asset. More on crypto conventions below.

**`APEX:CRYPTO:PERP:BTCUSDT`** — Bitcoin/Tether perpetual future. Sub-class `PERP`. Same symbol as spot, different sub-class. The sub-class is what disambiguates: `APEX:CRYPTO:SPOT:BTCUSDT` and `APEX:CRYPTO:PERP:BTCUSDT` are two different instruments with the same underlying pair but fundamentally different mechanics (spot settlement vs margined perpetual with funding rates).

**`APEX:FUT:ESZ26`** — E-mini S&P 500 futures, December 2026 contract. Futures are a top-level asset class with no sub-class, mirroring ISO 10962 (CFI category `F`) and FIX `SecurityType` `FUT`. The symbol is the exchange contract root (`ES`) plus the standard month code (`Z` = December) and a two-digit year — two digits, not the single digit some platforms use, because permanent IDs cannot tolerate decade ambiguity. The bare root (`APEX:FUT:ES`) identifies the contract family for registry metadata and continuous market-data series; orders must target a dated contract. The `APEX:OPT:` namespace is reserved for listed options (CFI category `O`), not yet populated. See the [Futures Profile](../spec/profiles/futures.md).

**`APEX:FI:{ISIN}`** — Fixed income instruments use the existing ISIN standard directly as the symbol segment. No reason to invent a new identifier when ISIN already provides unambiguous global identification for bonds and notes.

The hierarchy is parseable by splitting on `:`. An agent can determine the asset class, sub-class, and symbol programmatically. A routing layer can dispatch to the correct profile handler (`fx`, `cfd`, `crypto`, `futures`) by inspecting the second segment. A search index can filter by asset class without parsing the symbol itself.

---

## Why MIC Codes for Equities

Equity CFDs reference an underlying listed security. That security trades on an exchange. The question is how to encode the exchange in the instrument ID.

The common convention in retail broker APIs is a country suffix: `AAPL.US`, `HSBA.UK`, `SAP.DE`. This is ambiguous. `.US` could mean NYSE, NASDAQ, BATS, IEX, or any of the other dozen US equity venues. When Apple trades on NASDAQ and Goldman Sachs trades on NYSE, `.US` tells you the country but not the venue. For most retail purposes this ambiguity is tolerable. For a protocol that aspires to be a canonical identity standard, it is not.

APEX uses ISO 10383 Market Identifier Codes (MIC codes). A MIC code is a four-character alphanumeric code assigned to every regulated trading venue in the world. There is no ambiguity.

### MIC Reference Table

| Exchange | MIC | APEX Example |
|----------|-----|-------------|
| NASDAQ | `XNAS` | `APEX:CFD:EQ:AAPL.XNAS` |
| NYSE | `XNYS` | `APEX:CFD:EQ:GS.XNYS` |
| London Stock Exchange | `XLON` | `APEX:CFD:EQ:HSBA.XLON` |
| XETRA (Deutsche Borse) | `XETR` | `APEX:CFD:EQ:SAP.XETR` |
| Euronext Paris | `XPAR` | `APEX:CFD:EQ:AIR.XPAR` |
| ASX (Australia) | `XASX` | `APEX:CFD:EQ:CBA.XASX` |

The format is `{TICKER}.{MIC}`. The dot separator is unambiguous because MIC codes are always exactly four uppercase letters starting with `X` for operating MICs. No ticker contains a dot in its canonical form.

This is the same approach used by Bloomberg's Open Symbology (FIGI) and by SWIFT messaging standards. Country suffixes are a convenient shorthand for humans; MIC codes are the correct identifier for machines.

---

## Crypto Conventions

Crypto instrument symbols follow the same base/quote concatenation as FX: `BTCUSDT` is base `BTC`, quote `USDT`. But in crypto, the quote currency carries operational meaning beyond just "what currency is the price in."

**Linear (stablecoin-margined) contracts:** Quote currency is a stablecoin — `USDT` (Tether) or `USDC` (USD Coin). Margin is posted in the stablecoin. P&L is settled in the stablecoin. A 1 BTC long position on `BTCUSDT` at $50,000 requires ~$5,000 USDT margin (at 10x leverage) and pays out profit/loss in USDT. This is the standard contract type on Binance, Bybit, OKX, and most major exchanges.

**Inverse (coin-margined) contracts:** Quote currency is `USD`. Margin is posted in the base asset (BTC, ETH). P&L is settled in the base asset. A 1 BTC long position on `BTCUSD` is margined in BTC and pays out profit/loss in BTC. These contracts are popular with holders who want to maintain exposure to the base asset while trading.

The APEX ID makes this distinction visible:

| Instrument ID | Contract Type | Margin Asset |
|--------------|--------------|-------------|
| `APEX:CRYPTO:PERP:BTCUSDT` | Linear | USDT |
| `APEX:CRYPTO:PERP:BTCUSDC` | Linear | USDC |
| `APEX:CRYPTO:PERP:BTCUSD` | Inverse | BTC |
| `APEX:CRYPTO:SPOT:BTCUSDT` | Spot | USDT |
| `APEX:CRYPTO:SPOT:BTCUSD` | Spot | USD (fiat) |

The sub-class (`SPOT` vs `PERP`) tells you the instrument mechanics. The quote currency tells you the margin and settlement asset. An agent parsing `APEX:CRYPTO:PERP:BTCUSDT` knows immediately: this is a perpetual future, margined in USDT, with funding rate mechanics. No ambiguity, no broker-specific naming conventions to decode.

The same pair — BTC/USDT — can exist in both the spot and perpetual namespaces simultaneously. `APEX:CRYPTO:SPOT:BTCUSDT` and `APEX:CRYPTO:PERP:BTCUSDT` are distinct instruments with the same underlying pair, different mechanics, and different risk profiles.

---

## The Registry

The APEX Instrument Registry is the canonical source of truth for instrument identity. It maps APEX instrument IDs to broker-native symbols, contract specifications, and reference data.

### Registry Entry Schema

Each instrument in the registry has the following structure:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "display_name": "Euro / US Dollar",
  "asset_class": "fx",
  "sub_class": null,
  "profile": "fx",
  "status": "active",
  "introduced_version": "0.1.0-alpha",
  "deprecated_version": null,

  "canonical": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "pip_size": "0.0001",
    "pip_digits": 4,
    "standard_lot_size": 100000,
    "lot_size_currency": "EUR"
  },

  "broker_mappings": [
    {
      "broker_id": "fxcm",
      "broker_symbol": "EUR/USD",
      "broker_display_name": "EUR/USD",
      "min_quantity": "1000",
      "quantity_step": "1000",
      "canonical_quantity_unit": "base_units",
      "broker_quantity_unit": "units",
      "margin_rate_pct": "0.5",
      "as_of": "2026-01-01"
    },
    {
      "broker_id": "ig",
      "broker_symbol": "EURUSD",
      "broker_display_name": "EUR/USD",
      "min_quantity": "0.01",
      "quantity_step": "0.01",
      "canonical_quantity_unit": "base_units",
      "broker_quantity_unit": "lots",
      "margin_rate_pct": "0.5",
      "as_of": "2026-01-01"
    }
  ],

  "reference_data": {
    "iso_currency_base": "EUR",
    "iso_currency_quote": "USD",
    "central_bank_base": "ECB",
    "central_bank_quote": "Federal Reserve",
    "trading_sessions": ["sydney", "tokyo", "london", "new_york"],
    "is_24h": true
  }
}
```

Three layers of data in one entry. The top-level fields are identity — what the instrument is, what profile governs it, and whether it is active. The `canonical` block is the authoritative contract specification — pip size, lot size, the facts that do not vary between brokers. The `broker_mappings` array is the translation layer — each broker's native symbol, quantity conventions, and margin requirements. The `reference_data` block carries supplementary information useful for display and analysis but not required for trading.

Note the `broker_quantity_unit` field. One broker measures quantity in `units` (1000 = 1000 units of EUR). Another measures in `lots` (0.01 = one micro lot = 1000 units of EUR). Same position size, different numbers. The registry encodes both the canonical unit and the broker unit so that the protocol can translate between them.

### Broker Manifest Resolution Flow

When a new broker joins the APEX Protocol network:

1. **Broker submits symbol manifest** — a mapping of their native symbols to APEX instrument IDs, or flags for instruments requiring new registration
2. **Registry team reviews** — validates symbols against canonical definitions, resolves conflicts
3. **New instruments registered** — genuinely novel instruments receive new APEX IDs
4. **Broker manifest published** — the mapping goes live in the registry
5. **Conformance harness updated** — any fixtures or test inputs that reference the broker are updated

Brokers re-submit their manifest whenever they add new instruments. The registry is append-only for instrument IDs (new IDs are assigned, existing IDs are never recycled) and mutable for broker mappings (a broker can change their native symbol at any time; the canonical APEX ID remains stable).

---

## Permanence

Once assigned, an APEX instrument ID is never recycled or reassigned. This is a hard rule with no exceptions.

If an instrument is delisted, discontinued, or otherwise ceases to be tradeable, it is marked `"status": "deprecated"` in the registry. The `deprecated_version` field records when deprecation occurred. The ID itself remains reserved permanently.

Why this matters:

**Historical data integrity.** An agent backtesting a strategy needs to know that `APEX:CFD:EQ:AAPL.XNAS` in January 2026 refers to the same instrument as `APEX:CFD:EQ:AAPL.XNAS` in January 2028. If IDs could be recycled, a strategy that references historical fills by instrument ID could conflate two unrelated instruments that happened to share the same recycled ID.

**Audit trails.** Compliance records reference instrument IDs. If a regulator asks "show me all trades in instrument X over the last three years," the ID must resolve to exactly one instrument across the entire time range. Recycled IDs would make audit queries ambiguous.

**Backtesting.** Strategy development relies on replaying historical data. If instrument IDs are not permanent, a backtest engine would need to carry timestamp-qualified instrument identifiers to distinguish "APEX:FX:EURUSD as of 2026" from "APEX:FX:EURUSD as of 2028." Permanence eliminates this entirely — the ID is the ID, forever.

This is the same design principle that governs ISIN (an ISIN is never reassigned once allocated), DOI (a DOI permanently identifies an academic paper regardless of URL changes), and ISBN (an ISBN is never reissued to a different book). The cost is an ever-growing registry. The benefit is that every reference to an APEX ID is unambiguous for all time.

---

## Broker Symbol Resolution

The registry supports three API operations that together cover every lookup pattern an agent or broker integration needs.

### Lookup by APEX Instrument ID

Direct fetch. The agent knows the canonical ID and wants the full registry entry including broker mappings and contract specification.

```
GET /registry/v1/instruments/APEX:FX:EURUSD
```

Returns the complete registry entry — canonical data, all broker mappings, reference data. This is the primary operation for agents that already know what they want to trade.

### Search by Keyword

Discovery. The agent knows a human-readable name or partial string and wants to find matching instruments.

```
GET /registry/v1/instruments?query=EUR&profile=fx&status=active&limit=20
```

Returns a list of matching instruments with their IDs, display names, and profiles. The `profile` filter restricts results to a single asset class. The `status` filter excludes deprecated instruments by default.

This maps directly to the `apex.market.search` tool in the core specification:

```json
{
  "query": "EUR",
  "profile": "fx",
  "limit": 20
}
```

### Resolve Broker-Native Symbol to APEX ID

Reverse lookup. A broker or integration layer has a broker-native symbol and needs the canonical APEX ID.

```
GET /registry/v1/resolve?broker_id=fxcm&broker_symbol=EUR/USD
```

Response:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_id": "fxcm",
  "broker_symbol": "EUR/USD",
  "confidence": "exact",
  "alternatives": []
}
```

The `confidence` field indicates whether the match is `exact` (the broker symbol is in the registry) or `fuzzy` (the registry inferred a match based on heuristics). The `alternatives` array carries additional candidate matches when the resolution is ambiguous.

### Concrete Resolution Flow

Walk through a complete resolution cycle. An agent connects to FXCM and sees the native symbol `EUR/USD` in a position list. It needs to normalize this to an APEX ID for cross-broker portfolio aggregation.

1. Agent calls: `GET /registry/v1/resolve?broker_id=fxcm&broker_symbol=EUR/USD`
2. Registry looks up the `fxcm` broker manifest, finds the entry where `broker_symbol` equals `EUR/USD`
3. Registry returns `{ "instrument_id": "APEX:FX:EURUSD", "confidence": "exact" }`
4. Agent now holds `APEX:FX:EURUSD` and can match it against positions at IG (where the same instrument is `EURUSD`), at Broker C (where it is `eurusd`), and at every other connected broker
5. Cross-broker aggregation, risk netting, and portfolio display all use the canonical ID as the join key

The agent never builds a broker-to-broker translation table. It builds two one-directional maps — broker symbol to APEX ID, and APEX ID to broker symbol — both of which the registry provides.

### Broker Symbol Manifest

For bulk operations, the registry provides a complete manifest download for any broker:

```
GET /registry/v1/brokers/{broker_id}/manifest
```

This returns every instrument the broker offers, mapped to its APEX ID. Agents can cache this manifest locally and resolve symbols without per-instrument API calls. The manifest is versioned with an `as_of` timestamp so agents know when to refresh.

---

## Parallels

The instrument identity problem is not new. Every industry that needs to reference things unambiguously across organizational boundaries has solved it the same way: assign a canonical identifier in a central registry.

| Standard | Domain | Parallel to APEX |
|----------|--------|-----------------|
| **ISIN** (ISO 6166) | Securities — stocks, bonds, funds | Globally unique 12-character code for any security. Once assigned, never recycled. APEX applies the same permanence principle. For fixed income, APEX uses ISIN directly as the symbol segment (`APEX:FI:{ISIN}`). |
| **LEI** (ISO 17442) | Legal entities — counterparties, issuers | 20-character code identifying any legal entity in a financial transaction. Solves "who is this counterparty?" the way APEX solves "what is this instrument?" |
| **SEDOL** | London Stock Exchange securities | 7-character code used primarily in UK and Ireland. Exchange-specific rather than global, but demonstrates the same principle: one code, one security, forever. |
| **Bloomberg FIGI** | Financial instruments globally | Open standard for identifying instruments. Uses a similar hierarchical approach with venue-level granularity. APEX's use of MIC codes for equity CFDs mirrors FIGI's venue-aware identification. |
| **DNS** | Internet hostnames | Hierarchical namespace (`www.example.com`) that resolves to an IP address. The hierarchy is the key parallel: just as DNS encodes `host.domain.tld`, APEX encodes `APEX:CLASS:SUBCLASS:SYMBOL`. Parsing is mechanical. Routing is hierarchical. |
| **ISO 4217** | Currencies | Three-letter currency codes (EUR, USD, GBP). APEX uses these directly in FX instrument IDs. The base and quote currencies in `APEX:FX:EURUSD` are ISO 4217 codes concatenated. Precious metals use their ISO 4217 assignments: XAU for gold, XAG for silver. |
| **ISBN** (ISO 2108) | Books | 13-digit code identifying a specific edition of a book. Never recycled. The permanence principle is identical: an ISBN assigned to a book in 1970 still refers to that book today. |
| **DOI** | Academic papers, datasets | A DOI is a permanent identifier for a digital object. URLs change; DOIs do not. APEX instrument IDs have the same property — broker symbols change, APEX IDs do not. |

The pattern across all of these is the same: an industry starts with ad hoc naming (every broker has its own symbol), suffers from fragmentation (mapping tables grow quadratically), and eventually converges on a central registry with permanent canonical identifiers. APEX is applying this pattern to the specific domain of multi-broker trading instrument identity, with the added structure of a hierarchical namespace that encodes asset class and sub-type information directly in the identifier.

---

## Related Design Documents

- [Profile Layering Design](profile-layering-design.md) — how the asset class encoded in the instrument ID (`FX`, `CFD`, `CRYPTO`, `FUT`) maps to the profile that governs domain-specific tools and `profile_data` fields
- [Quantity Design](quantity-design.md) — how the instrument registry carries per-broker quantity conventions (`canonical_quantity_unit`, `broker_quantity_unit`, `min_quantity`, `quantity_step`) that enable quantity normalization
- [Market Data Design](market-data-design.md) — how instrument IDs are used in resource URIs (`apex://market/quote/{instrument_id}`) and tool calls (`apex.market.details`)
