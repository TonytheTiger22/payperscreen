import express from "express";
import pg from "pg";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { runEmailChecks } from "./checks/email-trust.js";
import { runIpChecks } from "./checks/ip-trust.js";
import { lookupFreezes, coverage as freezeCoverage, issuers as freezeIssuers } from "./stablecoin-freezes.js";
import { compareDob } from "./dob.js";

// Base mainnet (CAIP-2). Was "eip155:84532" (Base Sepolia testnet).
const NETWORK = "eip155:8453";

const SELLER = process.env.SELLER_ADDRESS;
const app = express();
// Railway terminates TLS at its proxy. Without this, req.protocol is "http"
// and the x402 middleware advertises http:// resource URLs, which the CDP
// Bazaar won't index.
app.set("trust proxy", true);
const PUBLIC_API = process.env.PUBLIC_API_URL || "https://api.payperscreen.com";

// Real CDP facilitator — reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from env.
// Was the free testnet facilitator at https://x402.org/facilitator.
const facilitator = createCdpFacilitatorClient();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Top-up amounts in USDC. The minimum (default 1.25 USDC) is set to cover
// about €1 with room for exchange-rate moves; override with TOPUP_MIN_USD.
// The price and the credited amount both come from this one function, so
// what the payer authorises is exactly what gets credited.
const TOPUP_MIN = Number(process.env.TOPUP_MIN_USD || 1.25);
const TOPUP_MAX = 250;
function topupAmount(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < TOPUP_MIN) return TOPUP_MIN;
  return Math.min(n, TOPUP_MAX);
}

const priced = (price, description, extras = {}) => ({
  accepts: [{ scheme: "exact", price, network: NETWORK, payTo: SELLER }],
  description, mimeType: "application/json",
  serviceName: "PayPerScreen",
  tags: ["compliance", "sanctions", "ofac", "crypto", "kyc", "aml"],
  ...extras,
});

// Bazaar discovery metadata — lets x402 facilitators that support the
// extension (CDP's does) catalog these routes so agents can find them
// without already knowing the URL. Purely additive: has no effect on the
// payment flow itself, only on whether the route shows up in a discovery
// listing.
// ---- Bazaar listing status -------------------------------------------------
// After each settled payment the CDP facilitator says whether it catalogued
// the route in its Bazaar discovery index ("success", "processing" or
// "rejected", with a reason). The x402 library only logs that, so it's
// recorded here per route and shown on /refresh-status and /admin.
await pool.query(`CREATE TABLE IF NOT EXISTS x402_settlements (
    resource TEXT PRIMARY KEY, settled INT NOT NULL DEFAULT 0, last_at TIMESTAMPTZ, last_tx TEXT,
    bazaar_status TEXT, bazaar_detail JSONB, bazaar_at TIMESTAMPTZ)`)
  .catch((e) => console.error("x402_settlements table:", String(e.message || e)));

async function recordSettlement(ctx) {
  const r = ctx?.result || {};
  if (r.success === false) return;
  const resource = String(ctx?.paymentPayload?.resource?.url || ctx?.requirements?.resource || "unknown").split("?")[0];
  const bazaar = r.extensionResponses?.bazaar ?? null;
  await pool.query(
    `INSERT INTO x402_settlements (resource, settled, last_at, last_tx, bazaar_status, bazaar_detail, bazaar_at)
     VALUES ($1, 1, now(), $2, $3, $4, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (resource) DO UPDATE SET settled = x402_settlements.settled + 1, last_at = now(), last_tx = $2,
       bazaar_status = COALESCE($3, x402_settlements.bazaar_status),
       bazaar_detail = COALESCE($4, x402_settlements.bazaar_detail),
       bazaar_at = CASE WHEN $3::text IS NULL THEN x402_settlements.bazaar_at ELSE now() END`,
    [resource, r.transaction || null, bazaar?.status ?? (bazaar ? "unknown" : null),
     bazaar ? JSON.stringify(bazaar).slice(0, 2000) : null]);
}

// Each paid route reports its public URL as the x402 `resource`, so a
// payment settles for api.payperscreen.com even when payperscreen.com calls
// the API over Railway's generated or internal hostname. Bazaar indexes by
// this URL. Payment matching uses `accepts`, not `resource`.
app.use(paymentMiddleware(
  {
    "GET /screen": priced("$0.02", "Sanctions screening", {
      resource: PUBLIC_API + "/screen",
      extensions: declareDiscoveryExtension({
        method: "GET",
        input: { name: "Jane Doe", dob: "", country: "", type: "Individual" },
        inputSchema: {
          properties: {
            name: { type: "string", description: "Full name to screen" },
            dob: { type: "string", description: "YYYY-MM-DD, optional" },
            country: { type: "string", description: "Nationality, optional" },
            type: { type: "string", enum: ["Individual", "Entity"] },
          },
          required: ["name"],
        },
        output: {
          example: { subject: { name: "Jane Doe" }, listsChecked: ["OFAC SDN"], hitCount: 0, hits: [] },
        },
      }),
    }),
    "GET /context": priced("$0.05", "Field comparison", {
      resource: PUBLIC_API + "/context",
      extensions: declareDiscoveryExtension({
        method: "GET",
        input: { name: "Jane Doe" },
        inputSchema: {
          properties: { name: { type: "string", description: "Same query as a prior /screen hit" } },
          required: ["name"],
        },
        output: { example: { fields: [], meta: {} } },
      }),
    }),
    "GET /screen-address": priced("$0.02", "Crypto address screening: OFAC sanctions, stablecoin freezes and known hack proceeds", {
      resource: PUBLIC_API + "/screen-address",
      extensions: declareDiscoveryExtension({
        method: "GET",
        input: { address: "0x0000000000000000000000000000000000dEaD" },
        inputSchema: {
          properties: { address: { type: "string", description: "Wallet address on any supported chain" } },
          required: ["address"],
        },
        output: {
          example: { address: "0x...", sanctioned: false, matches: [], frozenByIssuer: { listed: false, matches: [] }, hackFunds: { listed: false, matches: [] } },
        },
      }),
    }),
    "GET /screen-email": priced("$0.02", "Email trust check", {
      resource: PUBLIC_API + "/screen-email",
      extensions: declareDiscoveryExtension({
        method: "GET",
        input: { email: "someone@example.com" },
        inputSchema: {
          properties: { email: { type: "string", description: "Email address to check" } },
          required: ["email"],
        },
        output: {
          example: { email: "someone@example.com", riskLevel: "low", redFlag: false, flagCount: 0, signals: [] },
        },
      }),
    }),
    "GET /screen-ip": priced("$0.01", "IP risk check (beta)", {
      resource: PUBLIC_API + "/screen-ip",
      extensions: declareDiscoveryExtension({
        method: "GET",
        input: { ip: "1.2.3.4" },
        inputSchema: {
          properties: { ip: { type: "string", description: "A public IPv4 address to check" } },
          required: ["ip"],
        },
        output: {
          example: { ip: "1.2.3.4", riskLevel: "low", redFlag: false, flagCount: 0, signals: [] },
        },
      }),
    }),
    // Prepaid balance top-up. Not listed in Bazaar discovery: paying it is
    // only meaningful through payperscreen.com, which credits the payer's
    // balance after settlement (see /api/topup in payment-agent.js).
    "GET /topup": {
      accepts: [{ scheme: "exact", network: NETWORK, payTo: SELLER,
                  price: (ctx) => "$" + topupAmount(ctx.adapter.getQueryParam?.("amount")
                                        ?? ctx.adapter.getQueryParams?.()?.amount).toFixed(2) }],
      description: "Prepaid balance top-up (payperscreen.com)", mimeType: "application/json",
    },
  },
  new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension)
    .onAfterSettle((ctx) => recordSettlement(ctx).catch((e) => console.error("recordSettlement:", String(e.message || e)))),
));

// Crawlers and agent fetchers check robots.txt first; without one some of
// them refuse the host outright. The paid routes are still paywalled by x402.
app.get("/robots.txt", (_, res) => res.type("text/plain").send("User-agent: *\nAllow: /\n"));

// Free index for whoever lands on the bare API host (often an agent that
// found it in our docs): says who runs it and where the docs are, so the
// host isn't an anonymous endpoint asking to be paid.
app.get("/", (_, res) => res.json({
  service: "PayPerScreen API",
  operator: "https://payperscreen.com",
  docs: "https://payperscreen.com/docs",
  llms: "https://payperscreen.com/llms.txt",
  agentCard: "https://payperscreen.com/.well-known/agent-card.json",
  lists: "https://payperscreen.com/lists",
  openapi: PUBLIC_API + "/openapi.json",
  x402Discovery: PUBLIC_API + "/.well-known/x402",
  payment: { protocol: "x402", network: NETWORK, asset: "USDC", payTo: SELLER },
  endpoints: {
    "GET /screen": "$0.02", "GET /context": "$0.05", "GET /screen-address": "$0.02",
    "GET /screen-email": "$0.02", "GET /screen-ip": "$0.01",
  },
}));

// Discovery documents for x402 indexers (x402scan and others). Free to read.
const DISCOVERY = [
  { path: "/screen", price: "0.02", summary: "Sanctions screening (OFAC, UN, EU, UK)",
    params: [["name", "Full name to screen", true], ["dob", "Date of birth, YYYY-MM-DD", false],
             ["country", "Nationality", false], ["type", "Individual or Entity", false]] },
  { path: "/context", price: "0.05", summary: "Field comparison for a /screen hit",
    params: [["name", "Same query as the prior /screen hit", true]] },
  { path: "/screen-address", price: "0.02", summary: "Crypto address screening: OFAC sanctions, stablecoin freezes, known hack proceeds",
    params: [["address", "Wallet address on any supported chain", true]] },
  { path: "/screen-email", price: "0.02", summary: "Email trust check",
    params: [["email", "Email address to check", true]] },
  { path: "/screen-ip", price: "0.01", summary: "IP risk check (beta)",
    params: [["ip", "Public IPv4 address", true]] },
];

app.get("/.well-known/x402", (_, res) => res.json({
  version: 1,
  resources: DISCOVERY.map(d => PUBLIC_API + d.path),
}));

app.get("/openapi.json", (_, res) => res.json({
  openapi: "3.1.0",
  info: {
    title: "PayPerScreen API", version: "1.0.0",
    description: "Pay-per-call compliance screening for agents and fintech teams: sanctions names, crypto wallets, emails and IPs. Paid per request in USDC on Base via x402. No account or API key.",
    contact: { name: "PayPerScreen", url: "https://payperscreen.com", email: process.env.CONTACT_EMAIL || "hello@albatrossletter.com" },
  },
  servers: [{ url: PUBLIC_API }],
  externalDocs: { url: "https://payperscreen.com/docs" },
  paths: Object.fromEntries(DISCOVERY.map(d => [d.path, { get: {
    operationId: d.path.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase()),
    summary: d.summary,
    tags: ["compliance"],
    parameters: d.params.map(([name, description, required]) =>
      ({ name, in: "query", required, description, schema: { type: "string" } })),
    "x-payment-info": {
      protocols: ["x402"], pricingMode: "fixed", price: d.price, currency: "USD",
      asset: "USDC", network: NETWORK, payTo: SELLER,
    },
    responses: {
      200: { description: "Screening result", content: { "application/json": { schema: { type: "object" } } } },
      402: { description: "Payment required (x402)" },
    },
  } }])),
}));

app.get("/topup", (req, res) => {
  res.json({ ok: true, credited: topupAmount(req.query.amount), currency: "USDC" });
});
app.get("/topup-limits", (_, res) => res.json({ min: TOPUP_MIN, max: TOPUP_MAX }));

const SUBJECTS = {
  clean: { name: "Maria Santos Oliveira", dob: "1981-04-12",
           country: "Portugal", type: "Individual", hits: [] },
  hit: {
    name: "Viktor Petrov", dob: "1978-09-03",
    country: "Bulgaria", type: "Individual",
    hits: [{
      list: "OFAC SDN", listVersion: "2026-08-17", score: 0.87,
      matchedOn: "Primary name, exact token match",
      listed: { name: "Viktor PETROV", dob: "1965-01-22",
                country: "Russian Federation", type: "Individual",
                program: "UKRAINE-EO14024", uid: "SDN-41287" },
    }],
  },
};

const LIST_LABELS = { OFAC: "OFAC SDN", UN: "UN Consolidated", EU: "EU Consolidated", UK: "UK Sanctions List" };
const NAME_SOURCES = Object.keys(LIST_LABELS);

// Only lists that are actually loaded are reported as checked, so
// `listsChecked` can never claim coverage the database doesn't have.
let loadedCache = { at: 0, sources: ["OFAC"], meta: {} };
async function loadedSources() {
  if (Date.now() - loadedCache.at < 60_000) return loadedCache.sources;
  try {
    const { rows } = await pool.query(
      `SELECT m.source, m.list_version, m.refreshed_at FROM list_metadata m
       WHERE m.source = ANY($1) AND EXISTS (SELECT 1 FROM entities e WHERE e.source = m.source)`,
      [NAME_SOURCES]);
    const have = new Set(rows.map((r) => r.source));
    loadedCache = { at: Date.now(), sources: NAME_SOURCES.filter((x) => have.has(x)),
                    meta: Object.fromEntries(rows.map((r) => [r.source, r])) };
  } catch { loadedCache.at = Date.now() - 50_000; }   // keep last good value, retry soon
  return loadedCache.sources;
}

// Which version of each list a result was checked against: the publisher's
// own publication date (falls back to the download date if the file had none)
// and when we last downloaded it. Recorded in audit trails, so it must be real.
const versionsFor = (sources) => sources.map((x) => ({
  list: LIST_LABELS[x],
  version: loadedCache.meta[x]?.list_version ?? null,
  refreshedAt: loadedCache.meta[x]?.refreshed_at ?? null,
}));
async function addressListVersions() {
  const { rows } = await pool.query(
    "SELECT source, list_version, refreshed_at FROM list_metadata WHERE source = ANY($1)",
    [["OFAC-SDN-CRYPTO", "STABLECOIN-FREEZE"]]).catch(() => ({ rows: [] }));
  const m = Object.fromEntries(rows.map((r) => [r.source, r]));
  return [
    { list: "OFAC SDN digital currency addresses", version: m["OFAC-SDN-CRYPTO"]?.list_version ?? null,
      refreshedAt: m["OFAC-SDN-CRYPTO"]?.refreshed_at ?? null },
    { list: "Stablecoin freezes", version: m["STABLECOIN-FREEZE"]?.list_version ?? null,
      refreshedAt: m["STABLECOIN-FREEZE"]?.refreshed_at ?? null },
    { list: "Known hack and exploit proceeds", version: HACKS.updated, refreshedAt: null },
  ];
}
const HIT_THRESHOLD = 0.4;

const listJoin = (xs) => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const titleCase = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

function compareField(subjectVal, listedVal) {
  if (!subjectVal || !listedVal)
    return { status: "unknown", note: "insufficient data to compare" };
  const same = String(subjectVal).trim().toLowerCase() === String(listedVal).trim().toLowerCase();
  return same
    ? { status: "match", note: "exact match" }
    : { status: "differs", note: "differs" };
}

// Best match per loaded list, strongest first.
async function matchesByList(name, sources) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT e.id, e.source, e.canonical_name AS name, e.entity_type, e.dob, e.nationality,
              e.program, e.uid, similarity(e.canonical_name, $1) AS score, 'primary name' AS basis
       FROM entities e
       WHERE e.source = ANY($2) AND e.canonical_name % $1
       UNION ALL
       SELECT e.id, e.source, e.canonical_name AS name, e.entity_type, e.dob, e.nationality,
              e.program, e.uid, similarity(a.alias_name, $1) AS score, 'alias match' AS basis
       FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
       WHERE e.source = ANY($2) AND a.alias_name % $1
     )
     SELECT DISTINCT ON (source) * FROM candidates ORDER BY source, score DESC`,
    [name, sources]
  );
  return rows.sort((a, b) => b.score - a.score);
}

async function bestMatch(name, sources) {
  return (await matchesByList(name, sources))[0] || null;
}

// Exact-match lookup for sanctioned crypto wallet addresses — a different
// data source and match type from bestMatch() above. See
// ingest-crypto-addresses.mjs for provenance and known limitations
// (no linked entity name/DOB; see the project's list-management roadmap).
const EVM_ASSETS = new Set(["ETH", "USDT", "USDC", "ARB", "BSC", "ETC"]);
const looksLikeEvm = (address) => address.toLowerCase().startsWith("0x");

// Curated list of addresses publicly identified as attacker-controlled or
// holding stolen funds in major hacks (data/hack-addresses.json). Separate
// from sanctions: a hit here is reported as hackFunds, never as sanctioned.
import { readFileSync as readHackFile } from "fs";
const HACKS = JSON.parse(readHackFile(new URL("./data/hack-addresses.json", import.meta.url), "utf8"));
const HACK_INDEX = new Map();
for (const inc of HACKS.incidents) for (const a of inc.addresses) {
  const key = looksLikeEvm(a.address) ? a.address.toLowerCase() : a.address;
  if (!HACK_INDEX.has(key)) HACK_INDEX.set(key, []);
  HACK_INDEX.get(key).push({ incident: inc.name, date: inc.date, attribution: inc.attribution,
    role: a.role, chain: a.chain, source: inc.sources[0] });
}
const HACK_COUNT = HACK_INDEX.size;
function lookupHack(rawAddress) {
  const address = rawAddress.trim();
  return HACK_INDEX.get(looksLikeEvm(address) ? address.toLowerCase() : address) || [];
}

async function lookupAddress(rawAddress) {
  const address = rawAddress.trim();
  const normalized = looksLikeEvm(address) ? address.toLowerCase() : address;

  const { rows } = await pool.query(
    `SELECT asset, address, source, entity_name, entity_uid FROM sanctioned_addresses
     WHERE address_normalized = $1`,
    [normalized]
  );
  return rows;
}

// The daily OFAC refresh adds these columns too; doing it at startup as well
// means lookups work on an older database before that first refresh runs.
await pool.query(`ALTER TABLE sanctioned_addresses ADD COLUMN IF NOT EXISTS entity_name TEXT;
                  ALTER TABLE sanctioned_addresses ADD COLUMN IF NOT EXISTS entity_uid TEXT`)
  .catch((e) => console.error("sanctioned_addresses migration failed:", String(e.message || e)));

// Free, unauthenticated — just counts and refresh timestamps, nothing
// that needs paying for. Powers the public "/lists" page on the site.
app.get("/lists-meta", async (req, res) => {
  const freezeCount = await pool.query("SELECT count(DISTINCT address_normalized)::int AS n FROM stablecoin_freezes")
    .then((r) => r.rows[0].n).catch(() => 0);
  const [{ rows: counts }, { rows: [addrCount] }, { rows: meta }] = await Promise.all([
    pool.query("SELECT source, count(*)::int AS n FROM entities WHERE source = ANY($1) GROUP BY source", [NAME_SOURCES]),
    pool.query("SELECT count(*)::int AS n FROM sanctioned_addresses WHERE source = 'OFAC-SDN-CRYPTO'"),
    pool.query("SELECT source, list_version, refreshed_at FROM list_metadata"),
  ]);
  const metaBySource = Object.fromEntries(meta.map((m) => [m.source, m]));
  const countBySource = Object.fromEntries(counts.map((c) => [c.source, c.n]));
  const LABELS = {
    OFAC: "OFAC Specially Designated Nationals (SDN) list",
    UN: "UN Security Council Consolidated List",
    EU: "EU Consolidated Financial Sanctions List",
    UK: "UK Sanctions List (FCDO)",
  };

  // A list appears here only once it has records loaded — never as a promise.
  const nameLists = NAME_SOURCES.filter((x) => countBySource[x] > 0).map((x) => ({
    source: x, label: LABELS[x], kind: "Names", matchType: "Fuzzy",
    records: countBySource[x],
    listVersion: metaBySource[x]?.list_version ?? null,
    refreshedAt: metaBySource[x]?.refreshed_at ?? null,
  }));

  res.json({
    lists: [
      ...nameLists,
      ...(freezeCount > 0 ? [{
        source: "STABLECOIN-FREEZE",
        label: `Stablecoin freezes (${freezeCoverage()}, read on-chain)`,
        kind: "Crypto addresses",
        matchType: "Exact",
        records: freezeCount,
        listVersion: metaBySource["STABLECOIN-FREEZE"]?.list_version ?? null,
        refreshedAt: metaBySource["STABLECOIN-FREEZE"]?.refreshed_at ?? null,
      }] : []),
      {
        source: "HACK-PROCEEDS",
        label: "Known hack and exploit proceeds (curated from FBI notices and incident reports)",
        kind: "Crypto addresses",
        matchType: "Exact",
        records: HACK_COUNT,
        listVersion: HACKS.updated,
        refreshedAt: new Date(HACKS.updated + "T00:00:00Z").toISOString(),
      },
      {
        source: "OFAC-SDN-CRYPTO",
        label: "OFAC sanctioned digital-currency addresses",
        kind: "Crypto addresses",
        matchType: "Exact",
        records: addrCount.n,
        listVersion: metaBySource["OFAC-SDN-CRYPTO"]?.list_version ?? null,
        refreshedAt: metaBySource["OFAC-SDN-CRYPTO"]?.refreshed_at ?? null,
      },
    ],
  });
});

app.get("/screen-address", async (req, res) => {
  const address = (req.query.address || "").trim();
  if (!address) return res.status(400).json({ error: "address is required" });

  const [matches, freezes, listVersions] = await Promise.all(
    [lookupAddress(address), lookupFreezes(pool, address), addressListVersions()]);
  const hacks = lookupHack(address);

  res.json({
    address,
    screenedAt: new Date().toISOString(),
    listVersions,
    sanctioned: matches.length > 0,
    matches: matches.map((m) => ({ asset: m.asset, source: m.source,
      ...(m.entity_name ? { listedParty: m.entity_name } : {}),
      ...(m.entity_uid ? { sdnUid: m.entity_uid } : {}) })),
    source: "OFAC SDN digital currency addresses",
    frozenByIssuer: {
      listed: freezes.length > 0,
      matches: freezes.map((f) => ({ token: f.token, issuer: f.issuer, chain: f.chain })),
      source: `${listJoin(freezeIssuers())} freeze list${freezeIssuers().length > 1 ? "s" : ""}, read from the token contracts on-chain`,
      coverage: freezeCoverage(),
      note: "The stablecoin issuer has frozen this address, usually at law enforcement's request. " +
            "Tokens sent to it can't be moved. Not a sanctions designation. Covers " + freezeCoverage() +
            " only; a frozen wallet on another chain won't show here.",
    },
    hackFunds: {
      listed: hacks.length > 0,
      matches: hacks,
      source: `${HACKS.name} (curated, updated ${HACKS.updated})`,
      note: "Addresses publicly identified, by law enforcement or the victim's own incident report, " +
            "as attacker-controlled or holding stolen funds. Not a sanctions designation. Covers " +
            "direct links to these wallets only, not funds already moved on through other wallets or mixers.",
    },
    note: "Exact address match only. A sanctions match names the listed party (listedParty, sdnUid) " +
          "as OFAC records it. \"Not sanctioned\" reflects this list only, not a guarantee the address is clean.",
  });
});

app.get("/screen-email", async (req, res) => {
  const email = (req.query.email || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    const result = await runEmailChecks(email);
    res.status(result.ok === false ? 400 : 200).json(result);
  } catch (err) {
    res.status(500).json({ error: "Email check failed", detail: String(err?.message || err) });
  }
});

app.get("/screen-ip", async (req, res) => {
  const ip = (req.query.ip || "").trim();
  if (!ip) return res.status(400).json({ error: "ip is required" });
  try {
    const result = await runIpChecks(ip);
    res.status(result.ok === false ? 400 : 200).json(result);
  } catch (err) {
    res.status(500).json({ error: "IP check failed", detail: String(err?.message || err) });
  }
});

app.get("/screen", async (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id] || SUBJECTS.clean;
    return res.json({
      subject: { name: s.name, dob: s.dob, country: s.country, type: s.type },
      listsChecked: ["OFAC SDN"],
      screenedAt: new Date().toISOString(),
      hitCount: s.hits.length,
      hits: s.hits.map((h) => ({ list: h.list, score: h.score, name: h.listed.name })),
    });
  }

  const subject = {
    name: (req.query.name || "").trim(),
    dob: req.query.dob || null,
    country: req.query.country || null,
    type: req.query.type || "Individual",
  };

  if (!subject.name) return res.status(400).json({ error: "name is required" });
  const sources = await loadedSources();
  const hits = (await matchesByList(subject.name, sources))
    .map((m) => ({ list: LIST_LABELS[m.source], score: Math.round(m.score * 100) / 100, name: m.name }))
    .filter((h) => h.score >= HIT_THRESHOLD);

  res.json({
    subject,
    listsChecked: sources.map((x) => LIST_LABELS[x]),
    listVersions: versionsFor(sources),
    screenedAt: new Date().toISOString(),
    hitCount: hits.length,
    hits,
  });
});

app.get("/context", async (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id];
    if (!s || !s.hits.length) return res.status(404).json({ error: "No alert to contextualise" });
    const h = s.hits[0];
    return res.json({
      fields: [
        { field: "Name",          subject: s.name,   listed: h.listed.name,
          status: "match",  note: "exact match" },
        { field: "Date of birth", subject: s.dob,     listed: h.listed.dob,
          status: "differs", note: "differs" },
        { field: "Nationality",   subject: s.country, listed: h.listed.country,
          status: "differs", note: "differs" },
        { field: "Entity type",   subject: s.type,    listed: h.listed.type,
          status: "match",  note: "exact match" },
      ],
      meta: { list: h.list, listVersion: h.listVersion, program: h.listed.program,
              uid: h.listed.uid, score: h.score, matchedOn: h.matchedOn },
    });
  }

  const subject = {
    name: (req.query.name || "").trim(),
    dob: req.query.dob || null,
    country: req.query.country || null,
    type: req.query.type || "Individual",
  };

  if (!subject.name) return res.status(400).json({ error: "name is required" });
  const top = await bestMatch(subject.name, await loadedSources());
  const score = top ? Math.round(top.score * 100) / 100 : 0;
  // 404, not 200: x402 only settles successful responses, so nobody pays 5¢ for "nothing to compare".
  if (!top || score < HIT_THRESHOLD) return res.status(404).json({ error: "No alert to contextualise" });

  const listedType = titleCase(top.entity_type);
  const dobCmp = compareDob(subject.dob, top.dob);
  const natCmp = compareField(subject.country, top.nationality);
  const typeCmp = compareField(subject.type, listedType);

  res.json({
    fields: [
      { field: "Name", subject: subject.name, listed: top.name,
        status: "match", note: "matched on " + top.basis },
      { field: "Date of birth",
        subject: subject.dob || "not provided",
        listed: top.dob || "not in source data",
        status: dobCmp.status, note: dobCmp.note },
      { field: "Nationality",
        subject: subject.country || "not provided",
        listed: top.nationality || "not in source data",
        status: natCmp.status, note: natCmp.note },
      { field: "Entity type",
        subject: subject.type, listed: listedType || "unknown",
        status: typeCmp.status, note: typeCmp.note },
    ],
    meta: {
      list: LIST_LABELS[top.source], listVersion: loadedCache.meta[top.source]?.list_version ?? null, program: top.program,
      uid: top.uid, score, matchedOn: top.basis,
    },
  });
});

// ---- List refresh, with a status record per list --------------------------
// Every refresh attempt is written to refresh_status (survives deploys), so a
// stale or failing list shows up on GET /refresh-status and on /admin instead
// of only in the Railway logs.
await pool.query(`CREATE TABLE IF NOT EXISTS refresh_status (
    source TEXT PRIMARY KEY, attempted_at TIMESTAMPTZ NOT NULL, ok BOOLEAN NOT NULL,
    records INT, error TEXT, detail JSONB)`)
  .catch((e) => console.error("refresh_status table:", String(e.message || e)));

async function recordStatus(source, ok, { records = null, error = null, detail = null } = {}) {
  await pool.query(
    `INSERT INTO refresh_status (source, attempted_at, ok, records, error, detail) VALUES ($1, now(), $2, $3, $4, $5)
     ON CONFLICT (source) DO UPDATE SET attempted_at=now(), ok=$2, records=$3, error=$4, detail=$5`,
    [source, ok, records, error, detail == null ? null : JSON.stringify(detail)]
  ).catch((e) => console.error("recordStatus:", String(e.message || e)));
}

// Runs one step, keeping its log lines so the status record says what happened.
async function step(source, fn) {
  const lines = [];
  const log = (m) => { console.log(m); lines.push(String(m).slice(0, 300)); };
  try {
    const out = await fn(log);
    const records = typeof out === "number" ? out : null;
    await recordStatus(source, true, { records, detail: { log: lines.slice(-12), ...(typeof out === "object" && out ? { result: out } : {}) } });
  } catch (e) {
    const cause = e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : "";
    const error = (String(e?.message || e) + cause).slice(0, 500);
    console.error(`[${source}] refresh failed: ${error}`);
    await recordStatus(source, false, { error, detail: { log: lines.slice(-12) } });
  }
}

const run = { running: false, startedAt: null, finishedAt: null };

app.get("/refresh-status", async (_, res) => {
  const [{ rows }, settlements, freezes] = await Promise.all([
    pool.query("SELECT source, attempted_at, ok, records, error, detail FROM refresh_status ORDER BY source")
      .catch(() => ({ rows: [] })),
    pool.query("SELECT resource, settled, last_at, bazaar_status, bazaar_detail, bazaar_at FROM x402_settlements ORDER BY resource")
      .then((r) => r.rows).catch(() => []),
    pool.query("SELECT token, chain, count(*)::int AS n FROM stablecoin_freezes GROUP BY token, chain ORDER BY token, chain")
      .then((r) => r.rows).catch(() => []),
  ]);
  res.json({
    autoRefresh: process.env.AUTO_REFRESH_LISTS === "1",
    run,
    lists: rows.map((r) => ({ source: r.source, attemptedAt: r.attempted_at, ok: r.ok, records: r.records,
                              error: r.error, detail: r.detail })),
    stablecoinFreezesByChain: freezes,
    // Paid routes without a row here have never had a settled payment, which
    // is the first thing Bazaar needs before it can list them.
    bazaar: DISCOVERY.map((d) => {
      const r = settlements.find((x) => x.resource === PUBLIC_API + d.path);
      return { resource: PUBLIC_API + d.path, settledPayments: r?.settled ?? 0, lastSettledAt: r?.last_at ?? null,
               status: r?.bazaar_status ?? null, detail: r?.bazaar_detail ?? null, statusAt: r?.bazaar_at ?? null };
    }),
    otherSettlements: settlements.filter((x) => !DISCOVERY.some((d) => x.resource === PUBLIC_API + d.path))
      .map((x) => ({ resource: x.resource, settledPayments: x.settled, lastSettledAt: x.last_at })),
  });
});

// Optional daily refresh of every list (OFAC SDN, UN, EU, UK, OFAC crypto
// addresses, stablecoin freezes), run inside this service (which has the
// network access the ingest needs). Off unless AUTO_REFRESH_LISTS=1.
if (process.env.AUTO_REFRESH_LISTS === "1") {
  const { SOURCES, refreshSource, refreshCryptoAddresses } = await import("./sanctions-lists.js");
  const { refreshStablecoinFreezes } = await import("./stablecoin-freezes.js");
  const refreshAll = async () => {
    if (run.running) { console.log("List refresh already running; skipped"); return; }
    run.running = true; run.startedAt = new Date().toISOString(); run.finishedAt = null;
    const client = await pool.connect();
    try {
      for (const src of Object.keys(SOURCES)) {
        await step(src, (log) => refreshSource(client, src, log));
        loadedCache.at = 0;
      }
      await step("OFAC-SDN-CRYPTO", (log) => refreshCryptoAddresses(client, log));
      await step("STABLECOIN-FREEZE", async (log) => {
        const results = await refreshStablecoinFreezes(client, { log });
        const failed = Object.entries(results).filter(([, r]) => r.error);
        if (failed.length === Object.keys(results).length)
          throw new Error("every chain failed: " + failed.map(([k, r]) => `${k}: ${r.error}`).join("; "));
        return results;
      });
    } finally { client.release(); run.running = false; run.finishedAt = new Date().toISOString(); }
  };
  setTimeout(refreshAll, 60_000);
  setInterval(refreshAll, 24 * 3600_000);
}

app.listen(4025, () => console.log("Compliance API on 4025 (live OFAC data, staged comparison)"));
