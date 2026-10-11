# PayPerScreen API

A sanctions and crypto-wallet screening API, paid per call over
[x402](https://x402.org): no account, no API key, no subscription. Each
request pays for itself in USDC on Base mainnet at the moment it's made.

This document is for anyone integrating programmatically, agent or human.
If you're a person using the web UI instead, see
[payperscreen.com/try](https://payperscreen.com/try). For a plain-English,
signal-by-signal breakdown of what each check actually does, including
what we don't check yet, see
[payperscreen.com/methodology](https://payperscreen.com/methodology).
Everything in that page is also reflected in the response shapes
documented below; neither should ever say more than the other.

## Who this is for

This API is built around the assumption that most real callers will be
**agents, not people clicking a button**: a backend process or an
autonomous agent that holds its own wallet and can sign a payment without
a human in the loop. That's the native use case x402 was designed for, and
it's the integration this document covers. See
[`examples/agent-client.mjs`](/examples/agent-client.mjs) for a working,
copy-pasteable reference client.

## Base URL

```
https://api.payperscreen.com
```

The API runs on its own subdomain of payperscreen.com. `GET /` on it is free
and returns a short index (operator, docs, receiving address, prices).

## How payment works

No API key, no signup. Authentication *is* payment: every request is
authorized by a signed payment, checked per-call.

1. You call an endpoint with no payment attached.
2. The server responds `402 Payment Required` with the exact payment it
   needs: scheme (`exact`), network (`eip155:8453`, Base mainnet), asset
   (USDC), amount, and the address to pay.
3. Your client signs an EIP-3009 `transferWithAuthorization`: a gasless,
   off-chain signature. You never pay gas; the facilitator that settles
   the payment does.
4. Your client retries the same request with the signed authorization
   attached in an `X-PAYMENT` header.
5. The server verifies and settles the payment, then returns your result.

If you're using an x402-aware HTTP client (the `@x402/fetch` package used
in the reference client, or any other x402 client library), steps 2–4
happen automatically. You just call the URL and the library pays for you.

**You only pay for answers.** Payment settles only when the response is a
success. Bad input (a missing name, an invalid email or IP address) gets a
`400`, and a field comparison with nothing to compare gets a `404`; in both
cases the payment is cancelled and nothing is charged.

**Wallet requirements:** real USDC on Base mainnet. No ETH needed: you
only sign, you never submit a transaction yourself.

## Endpoints

### `GET /screen`: $0.02

Fuzzy name match against the sanctions lists we currently carry: OFAC SDN,
UN, EU and UK where loaded (see "What we check" below; `listsChecked` in every
response names exactly what was checked).

**Query parameters**

| Param     | Required | Notes                                   |
|-----------|----------|------------------------------------------|
| `name`    | yes      | Full name to screen                      |
| `dob`     | no       | `YYYY-MM-DD` if known                    |
| `country` | no       | Nationality, free text                   |
| `type`    | no       | `Individual` or `Entity` (default: `Individual`) |

**Response**

```json
{
  "subject": { "name": "...", "dob": null, "country": null, "type": "Individual" },
  "listsChecked": ["OFAC SDN"],
  "screenedAt": "2026-10-03T12:40:00.000Z",
  "hitCount": 1,
  "hits": [{ "list": "OFAC SDN", "score": 0.87, "name": "..." }]
}
```

`hits` has at most one entry **per list**: the best match on that list above an
internal similarity threshold, strongest first. `hitCount` is the number of
lists with a hit. If it is above `0`, call `/context` for the field-by-field
comparison against the strongest match.

### `GET /context`: $0.05

Field-by-field comparison between what you submitted and the matched
listed party. Only meaningful right after a `/screen` call that returned
`hitCount: 1`, with the same query parameters and values.

**Response**

```json
{
  "fields": [
    { "field": "Name", "subject": "...", "listed": "...",
      "status": "match", "note": "matched on primary name" },
    { "field": "Date of birth", "subject": "...", "listed": "...",
      "status": "differs", "note": "differs" },
    { "field": "Nationality", "subject": "not provided", "listed": "...",
      "status": "unknown", "note": "insufficient data to compare" },
    { "field": "Entity type", "subject": "Individual", "listed": "Individual",
      "status": "match", "note": "exact match" }
  ],
  "meta": {
    "list": "OFAC SDN", "listVersion": "live", "program": "...",
    "uid": "...", "score": 0.87, "matchedOn": "primary name"
  }
}
```

`status` is one of four values. This is deliberate, not a boolean:

| `status`  | Meaning                                                  |
|-----------|-----------------------------------------------------------|
| `match`   | Fields agree                                               |
| `differs` | Fields disagree                                            |
| `partial` | Partial agreement (e.g. year-only DOB matches the year)    |
| `unknown` | Not enough data on one side to compare, **not** a match or a non-match |

Returns `404` with `{ "error": "No alert to contextualise" }` if there's
nothing to compare (no prior hit for these parameters). You aren't charged.

### `GET /screen-address`: $0.02

Exact-match lookup against three lists, each reported separately:

1. **OFAC's sanctioned digital-currency addresses** (`sanctioned`, `matches`).
2. **Stablecoin freezes** (`frozenByIssuer`): wallets Tether has frozen for
   USDT on Tron, read directly from the token contract's public on-chain
   events and refreshed daily. `frozenByIssuer.coverage` states exactly which
   tokens and chains were checked. USDT sent to a frozen wallet can't be
   moved. Not a sanctions designation.
3. **Known hack and exploit proceeds** (`hackFunds`): a curated list of
   addresses publicly identified as attacker-controlled or holding stolen
   funds, taken from law-enforcement notices (e.g. the FBI's Bybit notice)
   and the victims' or security firms' own incident write-ups. Every match
   includes the incident, date, attribution and a source link. A hit here
   is **not** a sanctions designation.

This is a **different kind of check** from `/screen`: exact
string match, not fuzzy. A sanctions match names the listed party
(`listedParty`) and its SDN number (`sdnUid`) as OFAC records them.

**Query parameters**

| Param     | Required | Notes                                      |
|-----------|----------|----------------------------------------------|
| `address` | yes      | Any supported chain's wallet address         |

**Response**

```json
{
  "address": "...",
  "screenedAt": "2026-10-03T12:40:00.000Z",
  "sanctioned": true,
  "matches": [{ "asset": "XBT", "source": "OFAC-SDN-CRYPTO", "listedParty": "EXAMPLE LISTED PARTY", "sdnUid": "12345" }],
  "source": "OFAC SDN digital currency addresses",
  "note": "Exact address match only. A sanctions match names the listed party (listedParty, sdnUid) as OFAC records it. \"Not sanctioned\" reflects this list only, not a guarantee the address is clean.",
  "frozenByIssuer": {
    "listed": false,
    "matches": [],
    "source": "Tether freeze list, read from the token contracts on-chain",
    "coverage": "USDT on Tron",
    "note": "The stablecoin issuer has frozen this address ... Covers USDT on Tron only; a frozen wallet on another chain won't show here."
  },
  "hackFunds": {
    "listed": true,
    "matches": [{
      "incident": "Bybit", "date": "2025-02-21",
      "attribution": "North Korea (TraderTraitor / Lazarus), per the FBI",
      "role": "holds or held stolen funds (FBI)", "chain": "ethereum",
      "source": "https://www.ic3.gov/psa/2025/psa250226"
    }],
    "source": "Known hack and exploit proceeds (curated, updated 2026-10-11)",
    "note": "Addresses publicly identified ... Not a sanctions designation. Covers direct links to these wallets only, not funds already moved on through other wallets or mixers."
  }
}
```

The hack list covers direct links only: it flags the wallets named in
the sources, not funds that have since moved on through other wallets,
bridges or mixers. Tracing those needs a commercial blockchain-analytics
provider.

Supported assets: `XBT` (Bitcoin), `ETH`, `USDT`, `USDC`, `TRX`, `SOL`,
`LTC`, `BCH`, `ARB`, `BSC`, `ETC`, `DASH`, `XMR`, `ZEC`, `XVG`, `BTG`,
`BSV`, `XRP`.

### `GET /screen-email`: $0.02

A deterministic "fan-out and score" composite, not a list match. Ten signals, all zero-key: syntax/MX validity, disposable-domain check,
free-mail classification, domain age, certificate transparency, an SMTP
mailbox probe (best-effort: some mail servers block it or accept every
address), DNSBL (Spamhaus), MX provider fingerprinting, typo-squat
detection, and role-account detection.

**Query parameters**

| Param   | Required | Notes                  |
|---------|----------|--------------------------|
| `email` | yes      | Email address to check  |

**Response**

```json
{
  "ok": true,
  "email": "someone@example.com",
  "riskLevel": "low",
  "redFlag": false,
  "redFlagSignals": [],
  "flagCount": 0,
  "unknownCount": 0,
  "signalsChecked": 10,
  "signals": [ { "id": "disposable_domain", "label": "Disposable email provider", "severity": "critical", "status": "pass", "detail": "..." } ],
  "note": "..."
}
```

`riskLevel` is `low`, `medium`, or `high`. A flagged **critical** signal
(disposable provider, no mail server, look-alike domain, etc.) sets
`redFlag: true` and `riskLevel: "high"` on its own, regardless of how many
minor signals also flagged. See `redFlagSignals` for which ones fired.
Signals that couldn't be evaluated are `unknown`, never counted as a pass.

### `GET /screen-ip`: $0.01 (beta)

Checks a public IPv4 address against two known-high-risk-IP lists, both
free and keyless: the Spamhaus ZEN blocklist (spam sources, botnets,
hijacked netblocks) and the Tor Project's own exit-node list. A third
signal (network allocation, via RDAP) is informational only: plenty of
legitimate traffic comes from datacenter IPs, so it's not scored.

**Query parameters**

| Param | Required | Notes                       |
|-------|----------|-------------------------------|
| `ip`  | yes      | A public IPv4 address to check |

**Response** shape matches `/screen-email` (`riskLevel`, `redFlag`,
`redFlagSignals`, `signals`), with `ip` in place of `email`. Private/
reserved addresses (RFC 1918, loopback, etc.) and anything that isn't a
valid IPv4 address return `400` with `{ "ok": false, "error": "..." }` (not
charged) instead, because no
reputation exists to check for a non-routable address. IPv6 isn't
supported yet. VPN/hosting classification and community abuse reports
(AbuseIPDB) aren't live yet because they need a paid key.

## Free endpoints

- `GET /lists-meta`: every loaded list with its record count, version and
  last refresh time (powers [/lists](https://payperscreen.com/lists)).
- `GET /refresh-status`: the last refresh attempt per list, with any error,
  plus stablecoin freeze counts per chain. If a list looks stale, this says why.

## What we check (current, honest state)

- **Name screening**: OFAC SDN, UN Security Council Consolidated List, EU
  Consolidated Financial Sanctions List and UK Sanctions List (FCDO). A list
  counts only once it is loaded: `listsChecked` in every response, and
  [/lists](https://payperscreen.com/lists), tell you exactly what was checked,
  so don't assume broader coverage than they state.
- **Crypto address screening**: every digital-currency address on OFAC's
  SDN list, parsed daily from OFAC's own `sdn_advanced.xml` (all asset types
  OFAC uses). A hit names the listed party and SDN number. If Treasury's
  download fails, that day's refresh falls back to the 0xB10C extraction of
  the same file, which has no party names.
- **Stablecoin freezes** (part of `/screen-address`): the current Tether USDT
  freeze list on Tron, rebuilt from the contract's own events (freezes and
  unfreezes) and refreshed daily. USDT on Ethereum and Circle's USDC freezes
  aren't covered yet.
- **Known hack proceeds** (part of `/screen-address`): a curated, hand-reviewed
  list from public primary sources: FBI notices naming wallets used in North
  Korean thefts (Bybit; Atomic Wallet, Alphapo and CoinsPaid; Stake.com) and
  the attacker wallets published for the Kelp DAO, Drift, Truebit, Resolv and
  Step Finance hacks. Ethereum, BNB Chain, Polygon, Solana and Bitcoin. Direct matches only; see `/lists` for the current count.
- All are snapshots, re-downloaded automatically once a day (a failed
  download keeps the previous copy; `/lists` shows each list's real
  last-refreshed date). If
  you need a guarantee of same-day freshness, verify against OFAC's own
  published list directly for anything high-stakes.

This is deliberate: we'd rather you know the real boundaries of what's
checked than have the response imply more confidence than the data
supports. If this changes (more lists, scheduled refresh), this document
and the API's own response fields will reflect it.

## This is a data service, not a compliance service

A result from this API is a match (or non-match) and a field comparison,
nothing more. What you do with it (clear it, escalate it, hold a
payment, file a report) is entirely your own process and your own
regulatory responsibility. We don't make a disposition decision for you.

## Quickstart

```bash
git clone https://github.com/TonytheTiger22/payperscreen
cd x402
npm install
PRIVATE_KEY=0xYourKey node examples/agent-client.mjs screen "Jane Doe"
PRIVATE_KEY=0xYourKey node examples/agent-client.mjs address 123WBUDmSJv4GctdVEz6Qq6z8nXSKrJ4KX
```
