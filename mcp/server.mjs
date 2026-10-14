#!/usr/bin/env node
// PayPerScreen MCP server: lets an AI agent (Claude, Cursor, any MCP client)
// screen names, crypto wallets, emails and IP addresses with PayPerScreen.
// Paid tools pay per call in USDC over x402 from the wallet you configure;
// there is no account or API key. A spending cap is on by default.
//
// Settings (environment variables):
//   PAYPERSCREEN_PRIVATE_KEY  private key of a wallet holding USDC (needed for paid tools only)
//   PAYPERSCREEN_MAX_SPEND    max USD this server may spend per session (default 1.00)
//   PAYPERSCREEN_NETWORK      base (default), polygon or arbitrum
//   PAYPERSCREEN_API_URL      API base URL (default https://api.payperscreen.com)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const VERSION = "0.1.0";
const API = (process.env.PAYPERSCREEN_API_URL || "https://api.payperscreen.com").replace(/\/$/, "");
const MAX_SPEND = Number(process.env.PAYPERSCREEN_MAX_SPEND ?? 1);
const NETWORKS = { base: "eip155:8453", polygon: "eip155:137", arbitrum: "eip155:42161" };
const NETWORK = NETWORKS[(process.env.PAYPERSCREEN_NETWORK || "base").toLowerCase()] || NETWORKS.base;
const KEY = (process.env.PAYPERSCREEN_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

// Prices in USD, matching the API. Used for the spending cap, which is
// checked before any payment is signed.
const PRICES = { "/screen": 0.02, "/screen-address": 0.02, "/screen-email": 0.02, "/screen-ip": 0.01 };
let spent = 0;

// ---- payment client (only when a key is configured) --------------------------
let payFetch = null, httpClient = null, payer = null;
if (KEY) {
  const signer = privateKeyToAccount(KEY.startsWith("0x") ? KEY : "0x" + KEY);
  payer = signer.address;
  const client = new x402Client();
  client.register(NETWORK, new ExactEvmScheme(signer));
  payFetch = wrapFetchWithPayment(fetch, client);
  httpClient = new x402HTTPClient(client);
}

const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

async function getFree(path) {
  const r = await fetch(API + path, { signal: AbortSignal.timeout(30000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// Calls a paid endpoint: checks the cap, pays the 402 automatically, and
// returns the JSON body plus the payment receipt. Bad input comes back as a
// 4xx, which x402 never charges for.
async function callPaid(path, params) {
  if (!payFetch) throw new Error(
    "No wallet configured. Set PAYPERSCREEN_PRIVATE_KEY to the private key of a wallet holding USDC on " +
    `${Object.keys(NETWORKS).find((k) => NETWORKS[k] === NETWORK)} (a few dollars is plenty; checks cost 1 to 2 cents). ` +
    "The free tools (lists_coverage, sample_name_screen, sample_wallet_screen) work without one.");
  const price = PRICES[path];
  if (spent + price > MAX_SPEND + 1e-9) throw new Error(
    `Spending cap reached: this session has spent $${spent.toFixed(2)} of its $${MAX_SPEND.toFixed(2)} limit ` +
    "(PAYPERSCREEN_MAX_SPEND). Nothing was charged for this request.");
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""))).toString();
  const r = await payFetch(`${API}${path}?${qs}`, { method: "GET" });
  if (r.status >= 400 && r.status !== 402) {
    const body = await r.json().catch(() => ({}));
    throw new Error((body.error || `Request failed (HTTP ${r.status})`) + ". Nothing was charged.");
  }
  const out = await httpClient.processResponse(r);
  if (out.paymentStatus !== "settled") {
    const reason = out.header?.error || out.header?.errorReason || out.paymentStatus;
    throw new Error(`Payment not accepted (${reason}). Check the wallet holds USDC on the configured network. Nothing was charged.`);
  }
  spent = +(spent + price).toFixed(4);
  const tx = JSON.stringify(out.header ?? {}).match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;
  return { body: out.body, receipt: { paidUsd: price, transaction: tx, sessionSpentUsd: spent, sessionCapUsd: MAX_SPEND } };
}

const run = (fn) => async (args) => { try { return asText(await fn(args)); } catch (e) { return fail(String(e.message || e)); } };

// ---- server and tools ------------------------------------------------------
const server = new McpServer(
  { name: "payperscreen", version: VERSION },
  { instructions:
      "PayPerScreen screens people, companies, crypto wallets, emails and IP addresses for compliance risk. " +
      "Use screen_name before onboarding or paying a person or company; screen_wallet before sending or accepting crypto; " +
      "check_email and check_ip for signup or login fraud signals. Results are possible matches for human review, " +
      "not legal determinations. Paid tools cost 1 to 2 US cents each in USDC; lists_coverage and the sample tools are free." });

server.registerTool("screen_name", {
  title: "Sanctions screening (name)",
  description:
    "Screen a person or company against the OFAC SDN, UN Security Council, EU and UK sanctions lists (refreshed daily). " +
    "Fuzzy match including aliases and word order. Each hit returns the listed name, score, record ID, sanctions programmes, " +
    "aliases, and a comparison of the date of birth, nationality and type you pass against the listed record, which helps " +
    "rule out namesakes. Pass dob and country whenever you know them. Costs $0.02.",
  inputSchema: {
    name: z.string().min(1).describe("Full name of the person or company"),
    dob: z.string().optional().describe("Date of birth, YYYY-MM-DD"),
    country: z.string().optional().describe("Nationality or country"),
    type: z.enum(["Individual", "Entity"]).optional().describe("Individual (default) or Entity"),
    threshold: z.number().min(0.3).max(1).optional().describe("Minimum match score, default 0.4"),
    limit: z.number().int().min(1).max(10).optional().describe("Matches per list, default 1"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async (a) => {
  const { body, receipt } = await callPaid("/screen", a);
  return { ...body, receipt };
}));

server.registerTool("screen_wallet", {
  title: "Crypto wallet screening",
  description:
    "Check a crypto wallet address before sending or accepting funds: exact match against every OFAC-sanctioned address " +
    "(a hit names the sanctioned party and SDN number), Tether's USDT freeze list on Tron, and wallets the FBI and victims " +
    "tied to major hacks. Each source is reported separately. Costs $0.02.",
  inputSchema: { address: z.string().min(1).describe("Wallet address (Bitcoin, Ethereum/EVM, Tron, Solana and more)") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async (a) => {
  const { body, receipt } = await callPaid("/screen-address", a);
  return { ...body, receipt };
}));

server.registerTool("check_email", {
  title: "Email risk check",
  description:
    "Assess an email address for signup or payout fraud: ten deterministic signals (mail server, disposable domain, domain age, " +
    "certificate history, blocklists, typo-squats, role accounts, mailbox probe). Returns low, medium or high risk with each signal explained. Costs $0.02.",
  inputSchema: { email: z.string().min(3).describe("Email address") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async (a) => {
  const { body, receipt } = await callPaid("/screen-email", a);
  return { ...body, receipt };
}));

server.registerTool("check_ip", {
  title: "IP risk check (beta)",
  description: "Check a public IPv4 address against the Spamhaus ZEN blocklist and the Tor exit node list, with the network owner. Costs $0.01.",
  inputSchema: { ip: z.string().min(7).describe("Public IPv4 address") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async (a) => {
  const { body, receipt } = await callPaid("/screen-ip", a);
  return { ...body, receipt };
}));

server.registerTool("lists_coverage", {
  title: "Lists and freshness (free)",
  description: "Free. Which sanctions and wallet lists PayPerScreen checks, how many records each has, its publication date and when it was last refreshed.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async () => getFree("/lists-meta")));

server.registerTool("sample_name_screen", {
  title: "Sample name screening (free)",
  description: "Free. A real, live screen_name result for a fixed example (Vladimir Putin), to see the response format before paying.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async () => getFree("/sample/screen")));

server.registerTool("sample_wallet_screen", {
  title: "Sample wallet screening (free)",
  description: "Free. A real, live screen_wallet result for a fixed OFAC-sanctioned wallet, to see the response format before paying.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, run(async () => getFree("/sample/screen-address")));

server.registerTool("spending_status", {
  title: "Spending this session (free)",
  description: "Free. How much this session has spent, the cap, the paying wallet and network.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, run(async () => ({ walletConfigured: !!payFetch, payer, network: NETWORK, spentUsd: spent, capUsd: MAX_SPEND, prices: PRICES })));

await server.connect(new StdioServerTransport());
console.error(`payperscreen-mcp ${VERSION}: ${payFetch ? `paying from ${payer} on ${NETWORK}, cap $${MAX_SPEND}` : "no wallet set, free tools only"} (API ${API})`);
