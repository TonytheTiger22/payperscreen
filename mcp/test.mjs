// End-to-end test: starts server.mjs over stdio with a real MCP client and
// calls every tool. Point PAYPERSCREEN_API_URL at a test API (for paid
// tools, one wired to a stub facilitator) and set PAYPERSCREEN_PRIVATE_KEY.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";

const env = { ...process.env };
async function connect(extraEnv) {
  const transport = new StdioClientTransport({ command: "node", args: [new URL("./server.mjs", import.meta.url).pathname],
    env: { ...env, ...extraEnv }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}
const text = (r) => r.content?.[0]?.text ?? "";
const json = (r) => JSON.parse(text(r));

// 1. With a wallet and a 5c cap.
const c = await connect({ PAYPERSCREEN_MAX_SPEND: "0.05" });
const tools = (await c.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
assert.deepEqual(tools, ["check_email", "check_ip", "lists_coverage", "sample_name_screen", "sample_wallet_screen", "screen_name", "screen_wallet", "spending_status"]);

const cov = json(await c.callTool({ name: "lists_coverage", arguments: {} }));
console.log("lists_coverage:", cov.lists.map((l) => `${l.source}=${l.records}`).join(" "));

const sample = json(await c.callTool({ name: "sample_name_screen", arguments: {} }));
console.log("sample_name_screen:", sample.sample, sample.response.hitCount, "hits");

const s = await c.callTool({ name: "screen_name", arguments: { name: "Vladimir Putin", dob: "1952-10-07", country: "Russia" } });
assert.ok(!s.isError, text(s));
const sb = json(s);
console.log("screen_name:", sb.hitCount, "hits; first:", sb.hits[0].list, sb.hits[0].comparison.map((x) => `${x.field}=${x.status}`).join(", "), "| receipt", JSON.stringify(sb.receipt));

const w = json(await c.callTool({ name: "screen_wallet", arguments: { address: "0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C" } }));
console.log("screen_wallet: sanctioned", w.sanctioned, "| spent", w.receipt.sessionSpentUsd);

const bad = await c.callTool({ name: "check_ip", arguments: { ip: "10.0.0.1" } });
console.log("check_ip private address -> error:", bad.isError, "|", text(bad).slice(0, 90));

const st = json(await c.callTool({ name: "spending_status", arguments: {} }));
console.log("spending_status:", st.spentUsd, "of", st.capUsd, "on", st.network);
assert.equal(st.spentUsd, 0.04);

const capped = await c.callTool({ name: "screen_name", arguments: { name: "Someone Else" } });
console.log("over the cap -> error:", capped.isError, "|", text(capped).slice(0, 80));
assert.ok(capped.isError && /cap/i.test(text(capped)));
await c.close();

// 2. No wallet: free tools work, paid tools explain.
const n = await connect({ PAYPERSCREEN_PRIVATE_KEY: "", PRIVATE_KEY: "" });
const nk = await n.callTool({ name: "screen_name", arguments: { name: "Vladimir Putin" } });
console.log("no wallet -> error:", nk.isError, "|", text(nk).slice(0, 80));
assert.ok(nk.isError && /No wallet configured/.test(text(nk)));
assert.ok(!(await n.callTool({ name: "sample_wallet_screen", arguments: {} })).isError);
await n.close();
console.log("MCP tests OK");
