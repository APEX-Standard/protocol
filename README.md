# APEX Protocol

**Agent Protocol for EXchange**

The open MCP-based specification for how AI agents communicate with financial brokers, dealers, and market makers.

APEX defines a canonical tool vocabulary, a universal instrument identifier, and a unified order model — enabling any alpha-compatible agent to connect to any alpha-compatible broker without bespoke integrations.

---

## Repository Structure

```
protocol/
├── spec/                        # THE SPECIFICATION
│   ├── core/                    # Layer 1 — mandatory baseline (all brokers)
│   ├── profiles/                # Layer 2 — asset class extensions
│   │   ├── fx.md                #   Spot FX, CFD FX, rollovers
│   │   ├── cfd.md               #   Equities, indices, commodities
│   │   ├── crypto.md            #   Spot, perpetuals, funding rates
│   │   └── futures.md           #   Listed futures, contract chains, margin schedules
│   └── registry/                # Instrument taxonomy and ID format
├── reference-implementation/    # Reference MCP servers (illustrative handlers)
│   ├── typescript/              #   Node.js 18+, MCP SDK, Zod
│   ├── rust/                    #   rmcp crate
│   ├── go/                      #   mcp-go SDK
│   └── java/                    #   Direct JSON-RPC 2.0, Jackson
├── conformance/                 # Test suite for spec compliance
├── governance/                  # TAC charter, RFC process, contributing
└── docs/                        # Design library and implementation guides
```

---

## Specification Layers

| Layer | Scope | Status |
|-------|-------|--------|
| Layer 1 — Core | Session, account, orders, market data, risk | `v0.2-alpha` |
| Layer 2 — FX | Spot FX, CFD FX, rollovers, currency exposure | `v0.2-alpha` |
| Layer 2 — CFD | Equities, indices, corporate actions | `v0.2-alpha` |
| Layer 2 — Crypto | Spot, perpetuals, funding rates, margin modes | `v0.2-alpha` |
| Layer 2 — Futures | Listed futures, contract chains, expiration, margin schedules | `v0.3-alpha` (unreleased) |
| Layer 2 — Options | Listed options, greeks | `planned` |
| Layer 2 — Fixed Income | Bonds, yield, duration | `planned` |

---

## Quick Start

### For Agent Developers

1. Read [`docs/agent-quickstart.md`](docs/agent-quickstart.md)
2. Use canonical instrument IDs from [`spec/registry/`](spec/registry/)
3. Connect directly to any APEX alpha-compatible broker's MCP endpoint

### For Brokers

1. Read [`spec/core/README.md`](spec/core/README.md) — the mandatory baseline
2. Choose your [`spec/profiles/`](spec/profiles/) for your asset classes
3. Start from a [`reference-implementation/`](reference-implementation/)
4. Run the [`conformance/`](conformance/) test suite against your implementation

### Design Library

The [`docs/`](docs/) directory contains a **24-document design library** covering every aspect of the protocol — the *why* behind each mechanism, concrete scenarios, and parallels to established systems like FIX, Kafka, and HTTP.

Start with the [Protocol Overview](docs/protocol-overview-design.md), then see the [full index](docs/README.md) to find the topic you need.

---

## Tool Vocabulary

Five domains. Consistent naming. Every tool annotated with MCP metadata.

| Domain | Prefix | Purpose |
|--------|--------|---------|
| Session | `apex.session.*` | Authentication, capabilities, heartbeat |
| Account | `apex.account.*` | Balances, positions, orders, history |
| Orders | `apex.order.*` | Place, modify, cancel, status |
| Market Data | `apex.market.*` | Quotes, snapshots, search, instrument details |
| Risk | `apex.risk.*` | Pre-trade checks, account limits |

---

## Instrument ID Format

```
APEX:{ASSET_CLASS}:{SUB_CLASS?}:{SYMBOL}
```

Examples: `APEX:FX:EURUSD`, `APEX:CFD:IDX:SPX500`, `APEX:CRYPTO:SPOT:BTCUSDT`, `APEX:FUT:ESZ26`

---

## Versioning

APEX Protocol uses semantic versioning: `MAJOR.MINOR.PATCH`

Current version: **`0.2.0-alpha`**

---

## Contributing

See [`governance/CONTRIBUTING.md`](governance/CONTRIBUTING.md) for the RFC process.

---

## License

Specification: [Creative Commons Attribution 4.0](LICENSE)
Reference Implementations: [Apache License 2.0](LICENSE-CODE)
