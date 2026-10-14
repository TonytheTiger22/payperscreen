# PayPerScreen MCP server

Give your AI agent compliance checks. Claude, Cursor or any MCP client can screen people, companies, crypto wallets, emails and IP addresses with [PayPerScreen](https://payperscreen.com), paying 1 to 2 cents per check in USDC over [x402](https://x402.org). No account, no API key, no subscription.

| Tool | What it does | Price |
|---|---|---|
| `screen_name` | Person or company against OFAC SDN, UN, EU and UK sanctions lists (refreshed daily). Each hit: listed name, score, record ID, programmes, aliases, and a date of birth / nationality / type comparison against what you pass | $0.02 |
| `screen_wallet` | Wallet against every OFAC-sanctioned address (names the party), Tether's USDT freeze list on Tron, and FBI-identified hack wallets | $0.02 |
| `check_email` | Ten deterministic fraud signals (disposable domain, domain age, blocklists, typo-squats…) | $0.02 |
| `check_ip` | Spamhaus ZEN and Tor exit node check (beta) | $0.01 |
| `lists_coverage` | Which lists are checked, record counts, publication dates | free |
| `sample_name_screen`, `sample_wallet_screen` | Real results for fixed examples, to see the format | free |
| `spending_status` | What this session has spent against its cap | free |

Results are possible matches for review, not legal determinations. Bad input is never charged.

## Set up

You need Node.js 20+ and, for the paid tools, a wallet with a few dollars of USDC on Base (or Polygon or Arbitrum). Use a dedicated wallet for this, not your main one: the key sits in your MCP client's config.

**Claude Code**

```bash
claude mcp add payperscreen -e PAYPERSCREEN_PRIVATE_KEY=0xYOUR_KEY -- npx -y payperscreen-mcp
```

**Claude Desktop** (Settings → Developer → Edit config), **Cursor** (`~/.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "payperscreen": {
      "command": "npx",
      "args": ["-y", "payperscreen-mcp"],
      "env": {
        "PAYPERSCREEN_PRIVATE_KEY": "0xYOUR_KEY",
        "PAYPERSCREEN_MAX_SPEND": "1.00"
      }
    }
  }
}
```

Leave out the key to use only the free tools.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PAYPERSCREEN_PRIVATE_KEY` | none | Wallet that pays. Without it, paid tools explain how to add one |
| `PAYPERSCREEN_MAX_SPEND` | `1.00` | Spending cap in USD per session; checked before any payment is signed |
| `PAYPERSCREEN_NETWORK` | `base` | `base`, `polygon` or `arbitrum`: where your wallet holds USDC |
| `PAYPERSCREEN_API_URL` | `https://api.payperscreen.com` | API to call |

No ETH or gas needed: you only sign a USDC authorization, and Coinbase's facilitator settles it.

## How it works

Each paid tool calls the PayPerScreen API. The API answers `402 Payment Required` with the price; the server signs a USDC payment from your wallet and retries; the result comes back with a receipt (amount, transaction, session total). See the [API docs](https://payperscreen.com/docs) and [methodology](https://payperscreen.com/methodology).

## Develop

```bash
npm install
PAYPERSCREEN_API_URL=http://localhost:4025 PAYPERSCREEN_PRIVATE_KEY=0x... npm run test:e2e
```

MIT licence.
