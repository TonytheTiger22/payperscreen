# PayPerScreen

Pay-per-check compliance screening over [x402](https://x402.org). Sanctions names, crypto wallets, emails and IP addresses, paid per request in USDC on Base. No account, no API key, no contract.

- **Hosted version:** [payperscreen.com](https://payperscreen.com) (try it by hand at [/try](https://payperscreen.com/try))
- **API:** `https://api.payperscreen.com` ([docs](https://payperscreen.com/docs), [OpenAPI](https://api.payperscreen.com/openapi.json))
- **Source:** [github.com/TonytheTiger22/payperscreen](https://github.com/TonytheTiger22/payperscreen) (MIT)
- **How every check works, and what it doesn't cover:** [methodology](https://payperscreen.com/methodology)

This repo is the whole thing: the paid API, the website, the case queue and the list ingest. Use the hosted version, or run your own.

## What it checks

| Endpoint | Price | What it does |
|---|---|---|
| `GET /screen?name=` | $0.02 | Fuzzy name match against OFAC SDN, UN Consolidated, EU Consolidated and UK Sanctions lists, refreshed daily |
| `GET /context?name=` | $0.05 | Compares date of birth, nationality and type against the best-matching listed record |
| `GET /screen-address?address=` | $0.02 | Exact match against OFAC sanctioned addresses (with the listed party), Tether/Circle stablecoin freezes, and known hack proceeds. Each source is reported separately |
| `GET /screen-email?email=` | $0.02 | Ten deterministic signals: MX, disposable domain, domain age, certificate history, DNSBL, typo-squat, role account, mailbox probe and more |
| `GET /screen-ip?ip=` | $0.01 | Spamhaus ZEN and Tor exit node check (beta) |

No LLM anywhere in the scoring. Every result says which sources it checked.

## Calling it

Any x402 client works. The reference client is a single file:

```bash
PRIVATE_KEY=0x... node examples/agent-client.mjs screen "Jane Doe"
```

An unpaid request returns `402 Payment Required` with the price; the client signs a USDC payment and retries.

## Running your own

Two Node services from one repo, plus Postgres:

| Service | Entry | Port | What it is |
|---|---|---|---|
| API | `compliance-api.js` | 4025 | The paid x402 endpoints and list refresh |
| Site | `payment-agent.js` (`npm start`) | 4030 | Website, wallet payments, prepaid balance, case queue, admin |

```bash
npm install
psql "$DATABASE_URL" -f schema.sql
node compliance-api.js        # API
npm start                     # website
```

**API settings**

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres with the `pg_trgm` extension |
| `SELLER_ADDRESS` | yes | Wallet that receives payments |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | yes | Coinbase CDP facilitator (settles payments) |
| `AUTO_REFRESH_LISTS=1` | recommended | Refresh every list daily, starting 60 s after start |
| `TRONGRID_API_KEY` | optional | Faster USDT-on-Tron freeze sync |
| `PUBLIC_API_URL` | optional | Public URL reported to x402 directories |
| `TOPUP_MIN_USD` | optional | Minimum prepaid top-up (default 1.25) |

**Site settings**

| Variable | Needed | Purpose |
|---|---|---|
| `COMPLIANCE_API_URL` | yes | Where the API runs |
| `BUYER_KEY` | yes | Wallet the site pays the API from in prepaid mode |
| `ADMIN_CODE` | yes | Code for `/admin` |
| `DB_PATH` | yes in production | SQLite file for accounts, cases, balances (put it on a persistent volume) |
| `CONTACT_EMAIL`, `CONTACT_X`, `CONTACT_FACEBOOK` | optional | Footer contact details |
| `ANALYTICS_SALT` | optional | Salt for privacy-preserving visitor counts |
| `BASE_RPC_URL` | optional | Verifies smart-contract wallet sign-ins |

## Data sources

| Source | Licence |
|---|---|
| OFAC SDN and `sdn_advanced.xml` (US Treasury) | Public domain |
| UN Security Council Consolidated List | Public |
| EU Consolidated Financial Sanctions List | Public |
| UK Sanctions List (FCDO) | Open Government Licence |
| Stablecoin freezes | Read from the Tether and Circle token contracts' public on-chain events |
| Known hack proceeds (`data/hack-addresses.json`) | Curated here from FBI notices (public domain) and published incident reports; each incident lists its sources |
| Crypto address fallback | [0xB10C/ofac-sanctioned-digital-currency-addresses](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses), MIT |

## Not legal advice

A screening result is a lookup against the listed sources, not a compliance decision. "No match" means no match on those lists only. See the [methodology](https://payperscreen.com/methodology) for exactly what each check does and doesn't cover.

## Contributing

Issues and pull requests are welcome. Most useful right now: new public data sources (each kept as its own labelled result, never folded into "sanctioned"), and corrections to the hack list with a source link.

`server.js`, `shop.js` and `check.js` are early x402 experiments (a demo weather API), kept for reference; they aren't part of PayPerScreen.

## Licence

MIT, see [LICENSE](LICENSE).
