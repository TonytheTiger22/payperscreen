// Stablecoin freeze lists: wallets Tether (USDT) or Circle (USDC) have
// blacklisted, usually at law enforcement's request. USDT/USDC sent to such
// a wallet is stuck, so it's a strong signal for anyone about to pay one.
//
// Source: the token contracts' own public events, read directly from each
// chain (no third-party dataset, no licence question):
//   USDT  Tron, Ethereum   AddedBlackList(address) / RemovedBlackList(address)
//   USDC  Ethereum, Base,  Blacklisted(address indexed) / UnBlacklisted(address indexed)
//         Arbitrum, Optimism
//
// Sync is incremental and resumable: a cursor per (token, chain) is saved
// after every chunk, so a restart or deploy just continues where it left off.
// Unfreezes are applied in order, so the table holds the *current* state.

import { createHash } from "crypto";
import { keccak256, toHex } from "viem";

const topic = (sig) => keccak256(toHex(sig));
const T = {
  addedBlackList: topic("AddedBlackList(address)"),
  removedBlackList: topic("RemovedBlackList(address)"),
  blacklisted: topic("Blacklisted(address)"),
  unBlacklisted: topic("UnBlacklisted(address)"),
};

// startBlock: at or before the contract's deployment (earlier only costs a
// few empty queries). maxRange: the largest block span we try per request.
export const EVM_FEEDS = [
  { token: "USDT", issuer: "Tether", chain: "ethereum", rpcEnv: "ETH_RPC_URL",
    rpc: "https://ethereum-rpc.publicnode.com", contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    add: T.addedBlackList, remove: T.removedBlackList, indexed: false, startBlock: 4634748, maxRange: 2_000_000 },
  { token: "USDC", issuer: "Circle", chain: "ethereum", rpcEnv: "ETH_RPC_URL",
    rpc: "https://ethereum-rpc.publicnode.com", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    add: T.blacklisted, remove: T.unBlacklisted, indexed: true, startBlock: 6082465, maxRange: 2_000_000 },
  { token: "USDC", issuer: "Circle", chain: "base", rpcEnv: "BASE_RPC_URL",
    rpc: "https://base-rpc.publicnode.com", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    add: T.blacklisted, remove: T.unBlacklisted, indexed: true, startBlock: 2_000_000, maxRange: 10_000_000 },
  { token: "USDC", issuer: "Circle", chain: "arbitrum", rpcEnv: "ARB_RPC_URL",
    rpc: "https://arbitrum-one-rpc.publicnode.com", contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    add: T.blacklisted, remove: T.unBlacklisted, indexed: true, startBlock: 90_000_000, maxRange: 20_000_000 },
  { token: "USDC", issuer: "Circle", chain: "optimism", rpcEnv: "OP_RPC_URL",
    rpc: "https://optimism-rpc.publicnode.com", contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    add: T.blacklisted, remove: T.unBlacklisted, indexed: true, startBlock: 100_000_000, maxRange: 10_000_000 },
];
export const TRON_FEED = { token: "USDT", issuer: "Tether", chain: "tron",
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", api: "https://api.trongrid.io" };

const SOURCE = "STABLECOIN-FREEZE";
const CONFIRMATIONS = 64;            // stay a little behind the chain head
const MAX_REQUESTS_PER_RUN = 1500;   // per feed; a slow RPC resumes next run

export async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS stablecoin_freezes (
      token TEXT NOT NULL, chain TEXT NOT NULL, issuer TEXT NOT NULL,
      address TEXT NOT NULL, address_normalized TEXT NOT NULL,
      frozen_at_block BIGINT,
      PRIMARY KEY (token, chain, address_normalized));
    CREATE INDEX IF NOT EXISTS idx_stablecoin_freezes_addr ON stablecoin_freezes (address_normalized);
    CREATE TABLE IF NOT EXISTS sync_cursors (
      key TEXT PRIMARY KEY, position BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

// ---------- Tron address helpers (base58check, 0x41 prefix) ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256 = (b) => createHash("sha256").update(b).digest();
function b58encode(buf) {
  let n = BigInt("0x" + buf.toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte === 0) s = "1" + s; else break; }
  return s;
}
export function tronHexToBase58(hex) {
  let h = String(hex).toLowerCase().replace(/^0x/, "");
  if (h.length === 40) h = "41" + h;
  if (!/^41[0-9a-f]{40}$/.test(h)) return null;
  const payload = Buffer.from(h, "hex");
  return b58encode(Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]));
}
export function normalizeTron(v) {
  if (typeof v !== "string") return null;
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) return v;
  return tronHexToBase58(v);
}

// ---------- state changes ----------
// events: [{kind: "add"|"remove", address, block}], applied in block order.
async function applyEvents(db, feed, events, cursorKey, newPosition) {
  events.sort((a, b) => a.block - b.block);
  await db.query("BEGIN");
  try {
    for (const e of events) {
      const norm = feed.chain === "tron" ? e.address : e.address.toLowerCase();
      if (e.kind === "add") {
        await db.query(`INSERT INTO stablecoin_freezes (token, chain, issuer, address, address_normalized, frozen_at_block)
                        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (token, chain, address_normalized) DO NOTHING`,
          [feed.token, feed.chain, feed.issuer, e.address, norm, e.block]);
      } else {
        await db.query(`DELETE FROM stablecoin_freezes WHERE token=$1 AND chain=$2 AND address_normalized=$3`,
          [feed.token, feed.chain, norm]);
      }
    }
    await db.query(`INSERT INTO sync_cursors (key, position, updated_at) VALUES ($1,$2,now())
                    ON CONFLICT (key) DO UPDATE SET position=$2, updated_at=now()`, [cursorKey, newPosition]);
    await db.query("COMMIT");
  } catch (err) { await db.query("ROLLBACK"); throw err; }
}

async function getCursor(db, key) {
  const { rows } = await db.query("SELECT position FROM sync_cursors WHERE key=$1", [key]);
  return rows[0] ? Number(rows[0].position) : null;
}

// ---------- EVM ----------
async function rpc(url, method, params, fetchImpl) {
  const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error((j && j.error && j.error.message) || `HTTP ${r.status}`);
  return j.result;
}

export function parseEvmLog(feed, log) {
  const t0 = log.topics?.[0];
  const kind = t0 === feed.add ? "add" : t0 === feed.remove ? "remove" : null;
  if (!kind) return null;
  const word = feed.indexed ? log.topics[1] : (log.data || "").slice(0, 66);
  if (!word || word.length < 66) return null;
  return { kind, address: "0x" + word.slice(-40), block: parseInt(log.blockNumber, 16) };
}

export async function syncEvmFeed(db, feed, { fetchImpl = fetch, log = console.log } = {}) {
  const url = process.env[feed.rpcEnv] || feed.rpc;
  const key = `freeze:${feed.token}:${feed.chain}`;
  let from = (await getCursor(db, key)) ?? feed.startBlock - 1;
  const head = parseInt(await rpc(url, "eth_blockNumber", [], fetchImpl), 16) - CONFIRMATIONS;
  let range = Math.min(feed.maxRange, 100_000), requests = 0, seen = 0;
  while (from < head && requests < MAX_REQUESTS_PER_RUN) {
    const to = Math.min(from + range, head);
    requests++;
    let logs;
    try {
      logs = await rpc(url, "eth_getLogs", [{ address: feed.contract, topics: [[feed.add, feed.remove]],
        fromBlock: toHex(from + 1), toBlock: toHex(to) }], fetchImpl);
    } catch (err) {
      if (range <= 1000) throw err;               // RPC is failing even on tiny ranges
      range = Math.max(1000, Math.floor(range / 4)); // too wide or too many results: shrink
      continue;
    }
    const events = logs.map((l) => parseEvmLog(feed, l)).filter(Boolean);
    await applyEvents(db, feed, events, key, to);
    seen += events.length; from = to;
    if (logs.length < 2000) range = Math.min(feed.maxRange, range * 2);
  }
  const done = from >= head;
  log(`[${SOURCE}] ${feed.token}/${feed.chain}: ${seen} events, ${requests} requests, ` +
      (done ? "up to date" : `paused at block ${from} of ${head} (resumes next run; set ${feed.rpcEnv} to a faster RPC if this persists)`));
  return { done, seen };
}

// ---------- Tron (TronGrid events API) ----------
async function tronEvents(feed, eventName, minTs, fetchImpl) {
  const headers = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  let url = `${feed.api}/v1/contracts/${feed.contract}/events?event_name=${eventName}` +
            `&only_confirmed=true&order_by=block_timestamp,asc&limit=200&min_block_timestamp=${minTs}`;
  const out = []; let pages = 0;
  while (url && pages < MAX_REQUESTS_PER_RUN) {
    pages++;
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); continue; }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.success === false) throw new Error(`TronGrid ${eventName}: HTTP ${r.status}`);
    out.push(...(j.data || []));
    url = j.meta?.links?.next || null;
    await new Promise((s) => setTimeout(s, 120));
  }
  return out;
}

export function parseTronEvent(ev, kind) {
  const raw = ev.result?._user ?? ev.result?.["0"] ?? ev.result?.user;
  const address = normalizeTron(raw);
  if (!address) return null;
  return { kind, address, block: Number(ev.block_number), ts: Number(ev.block_timestamp) };
}

export async function syncTron(db, feed = TRON_FEED, { fetchImpl = fetch, log = console.log } = {}) {
  const key = `freeze:${feed.token}:${feed.chain}`;
  const since = (await getCursor(db, key)) ?? 0;         // block timestamp (ms)
  const [adds, removes] = await Promise.all([
    tronEvents(feed, "AddedBlackList", since + 1, fetchImpl),
    tronEvents(feed, "RemovedBlackList", since + 1, fetchImpl),
  ]);
  const events = [...adds.map((e) => parseTronEvent(e, "add")), ...removes.map((e) => parseTronEvent(e, "remove"))]
    .filter(Boolean);
  const newest = events.reduce((m, e) => Math.max(m, e.ts), since);
  await applyEvents(db, feed, events, key, newest);
  log(`[${SOURCE}] ${feed.token}/tron: ${events.length} events (${adds.length} freezes, ${removes.length} unfreezes)`);
  return { done: true, seen: events.length };
}

// ---------- run everything ----------
export async function refreshStablecoinFreezes(db, opts = {}) {
  const log = opts.log || console.log;
  await ensureTables(db);
  const results = {};
  for (const feed of [TRON_FEED, ...EVM_FEEDS]) {
    try {
      results[`${feed.token}/${feed.chain}`] = feed.chain === "tron" ? await syncTron(db, feed, opts) : await syncEvmFeed(db, feed, opts);
    } catch (err) {
      const msg = String(err.message || err) + (err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "");
      results[`${feed.token}/${feed.chain}`] = { error: msg };
      log(`[${SOURCE}] ${feed.token}/${feed.chain} failed: ${msg} (previous data kept)`);
    }
  }
  const { rows: [c] } = await db.query("SELECT count(DISTINCT address_normalized)::int AS n FROM stablecoin_freezes");
  // Only stamp "refreshed" if at least one chain actually synced; otherwise
  // /lists would show a fresh time for data that didn't update.
  if (Object.values(results).some((r) => !r.error))
    await db.query(`INSERT INTO list_metadata (source, list_version, refreshed_at) VALUES ($1,$2,now())
                    ON CONFLICT (source) DO UPDATE SET list_version=$2, refreshed_at=now()`,
      [SOURCE, new Date().toISOString().slice(0, 10)]);
  log(`[${SOURCE}] ${c.n} frozen addresses in total`);
  return results;
}

export async function lookupFreezes(db, rawAddress) {
  const a = String(rawAddress || "").trim();
  const norm = /^0x/i.test(a) ? a.toLowerCase() : a;
  try {
    const { rows } = await db.query(
      "SELECT token, issuer, chain FROM stablecoin_freezes WHERE address_normalized = $1 ORDER BY issuer, chain", [norm]);
    return rows;
  } catch { return []; }   // table not created yet (first sync pending)
}
