// OFAC SDN, UN, EU and UK sanctions lists -> the shared `entities` / `entity_aliases`
// tables (the same ones OFAC lives in; see ingest-ofac-full.mjs).
//
// Each parser is a pure function: XML string in, array of normalised records
// out, so it can be tested against a fixture without a network or database.
// refreshSource() downloads, parses, sanity-checks and swaps the data in a
// single transaction, so a bad download can never leave a list half-loaded or
// empty — the previous data stays live.
import { XMLParser } from "fast-xml-parser";

const arr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const txt = (x) => (x == null ? "" : typeof x === "object" ? txt(x["#text"]) : String(x).trim());
const join = (...parts) => parts.map(txt).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

// Every node called `key`, anywhere in the document. Used instead of a fixed
// path so a wrapper element being added or renamed doesn't silently produce
// zero records (the min-count guard below catches the rest).
function findAll(node, key, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, key, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) arr(v).forEach((x) => out.push(x));
    else findAll(v, key, out);
  }
  return out;
}

const uniq = (list) => [...new Set(list.filter(Boolean))];

// ---- UN Security Council consolidated list --------------------------------
export function parseUN(xml) {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const out = [];
  const one = (n, type) => {
    const name = join(n.FIRST_NAME, n.SECOND_NAME, n.THIRD_NAME, n.FOURTH_NAME);
    const uid = txt(n.REFERENCE_NUMBER) || txt(n.DATAID);
    if (!name || !uid) return;
    const dobs = arr(n.INDIVIDUAL_DATE_OF_BIRTH);
    const dobNode = dobs.find((d) => txt(d.DATE)) || dobs.find((d) => txt(d.YEAR)) || null;
    const dob = dobNode ? txt(dobNode.DATE) || txt(dobNode.YEAR) : null;
    const nat = arr(n.NATIONALITY).flatMap((x) => arr(x.VALUE)).map(txt).find(Boolean) || null;
    const aliases = [...arr(n.INDIVIDUAL_ALIAS), ...arr(n.ENTITY_ALIAS)].map((a) => txt(a.ALIAS_NAME));
    out.push({ uid, name, type, dob: dob ? dob.slice(0, 10) : null, nationality: nat,
               program: txt(n.UN_LIST_TYPE) || null, aliases: uniq(aliases) });
  };
  findAll(doc, "INDIVIDUAL").forEach((n) => one(n, "Individual"));
  findAll(doc, "ENTITY").forEach((n) => one(n, "Entity"));
  return out;
}

// ---- EU consolidated financial sanctions list (FSF) ------------------------
export function parseEU(xml) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_",
                              parseAttributeValue: false, parseTagValue: false }).parse(xml);
  const out = [];
  for (const e of findAll(doc, "sanctionEntity")) {
    const names = arr(e.nameAlias)
      .map((a) => txt(a["@_wholeName"]) || join(a["@_firstName"], a["@_middleName"], a["@_lastName"]))
      .filter(Boolean);
    const uid = txt(e["@_euReferenceNumber"]) || txt(e["@_logicalId"]);
    if (!names.length || !uid) continue;
    const code = txt(arr(e.subjectType)[0]?.["@_code"]).toLowerCase();
    const births = arr(e.birthdate);
    const b = births.find((x) => txt(x["@_birthdate"])) || births.find((x) => txt(x["@_year"]));
    const dob = b ? txt(b["@_birthdate"]) || txt(b["@_year"]) : null;
    const nat = arr(e.citizen).map((c) => txt(c["@_countryDescription"])).find(Boolean) || null;
    const program = uniq(arr(e.regulation).map((r) => txt(r["@_programme"]))).join(",") || null;
    out.push({ uid, name: names[0], type: code === "person" ? "Individual" : "Entity",
               dob: dob ? dob.slice(0, 10) : null, nationality: nat, program,
               aliases: uniq(names.slice(1)) });
  }
  return out;
}

// ---- UK Sanctions List (FCDO; replaced the OFSI consolidated list) ---------
// NOTE: written from the published schema description, not yet run against the
// live file — see the min-count guard and the verification step in the notes.
export function parseUK(xml) {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const out = [];
  for (const d of findAll(doc, "Designation")) {
    const names = findAll(d.Names ?? d, "Name").map((n) => ({
      full: txt(n.Name6) && !txt(n.Name1) ? txt(n.Name6)
            : join(n.Name1, n.Name2, n.Name3, n.Name4, n.Name5, n.Name6),
      primary: /primary/i.test(txt(n.NameType)),
    })).filter((n) => n.full);
    const uid = txt(d.UniqueID) || txt(d.OFSIGroupID);
    if (!names.length || !uid) continue;
    const main = names.find((n) => n.primary) || names[0];
    const kind = txt(d.IndividualEntityShip).toLowerCase();
    const rawDob = findAll(d, "DOB").map(txt).find(Boolean) || null;
    const m = rawDob && rawDob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);     // dd/mm/yyyy -> ISO
    const dob = m ? `${m[3]}-${m[2]}-${m[1]}` : rawDob;
    const nat = findAll(d, "Nationality").map(txt).find(Boolean) || null;
    out.push({ uid, name: main.full, type: kind.startsWith("individual") ? "Individual" : "Entity",
               dob: dob ? dob.slice(0, 10) : null, nationality: nat,
               program: txt(d.RegimeName) || null,
               aliases: uniq(names.filter((n) => n !== main).map((n) => n.full)) });
  }
  return out;
}

// ---- OFAC SDN (US Treasury) -----------------------------------------------
// Same field mapping as the original one-off ingest-ofac-full.mjs.
export function parseOFAC(xml) {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const fullName = (e) => join(e?.firstName, e?.lastName);
  const out = [];
  for (const e of findAll(doc, "sdnEntry")) {
    const name = fullName(e) || txt(e.lastName);
    const uid = txt(e.uid);
    if (!name || !uid) continue;
    const dob = txt(arr(e.dateOfBirthList?.dateOfBirthItem)[0]?.dateOfBirth) || null;
    const nationality = txt(arr(e.nationalityList?.nationality)[0]?.country)
                     || txt(arr(e.citizenshipList?.citizenship)[0]?.country) || null;
    out.push({ uid, name, type: txt(e.sdnType) || "Individual", dob, nationality,
               program: uniq(arr(e.programList?.program).map(txt)).join(",") || null,
               aliases: uniq(arr(e.akaList?.aka).map((a) => fullName(a) || txt(a.lastName))) });
  }
  return out;
}

export const SOURCES = {
  OFAC: {
    label: "OFAC Specially Designated Nationals (SDN) list",
    url: "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml",
    parse: parseOFAC, minRecords: 5000,
  },
  UN: {
    label: "UN Security Council Consolidated List",
    url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    parse: parseUN, minRecords: 300,
  },
  EU: {
    label: "EU Consolidated Financial Sanctions List",
    url: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
    parse: parseEU, minRecords: 1000,
  },
  UK: {
    label: "UK Sanctions List (FCDO)",
    url: "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml",
    parse: parseUK, minRecords: 1000,
  },
};

// Replace one source's rows with `records`, atomically. `client` is a pg Client.
// Bulk inserts (a few thousand rows per statement via unnest) instead of one
// query per row: OFAC alone is ~19k entities plus aliases, and row-by-row it
// ran long enough to be killed by the next deploy before it could commit.
const CHUNK = 2000;
export async function storeRecords(client, source, records) {
  const seen = new Set();
  const rows = records.filter((r) => !seen.has(r.uid) && seen.add(r.uid));   // (source, uid) is unique
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM entities WHERE source = $1", [source]);   // aliases cascade
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const col = (f) => part.map((r) => r[f] ?? null);
      const { rows: ids } = await client.query(
        `INSERT INTO entities (source, uid, canonical_name, entity_type, dob, nationality, program)
         SELECT $1, u, n, t, d, c, p
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS x(u, n, t, d, c, p)
         RETURNING id, uid`,
        [source, col("uid"), col("name"), col("type"), col("dob"), col("nationality"), col("program")]);
      const idByUid = new Map(ids.map((x) => [x.uid, x.id]));
      const aliasIds = [], aliasNames = [];
      for (const r of part)
        for (const a of r.aliases) if (a && a !== r.name) { aliasIds.push(idByUid.get(r.uid)); aliasNames.push(a); }
      for (let j = 0; j < aliasIds.length; j += CHUNK * 2)
        await client.query(
          `INSERT INTO entity_aliases (entity_id, alias_name) SELECT * FROM unnest($1::int[], $2::text[])`,
          [aliasIds.slice(j, j + CHUNK * 2), aliasNames.slice(j, j + CHUNK * 2)]);
    }
    await client.query(
      `INSERT INTO list_metadata (source, list_version, refreshed_at) VALUES ($1,$2,now())
       ON CONFLICT (source) DO UPDATE SET list_version=$2, refreshed_at=now()`,
      [source, new Date().toISOString().slice(0, 10)]);
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function refreshSource(client, source, log = console.log) {
  const s = SOURCES[source];
  if (!s) throw new Error(`Unknown source ${source}`);
  log(`[${source}] downloading ${s.label}...`);
  const res = await fetch(s.url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${source}: download failed, HTTP ${res.status}`);
  const xml = await res.text();
  const records = s.parse(xml);
  if (records.length < s.minRecords)
    throw new Error(`${source}: only ${records.length} records parsed (expected at least ` +
                    `${s.minRecords}) — the file format may have changed; previous data left untouched`);
  const n = await storeRecords(client, source, records);
  log(`[${source}] loaded ${n} records`);
  return n;
}

// ---- OFAC sanctioned crypto addresses --------------------------------------
// Re-pulls the per-asset files that ingest-crypto-addresses.mjs loads (see
// that file for provenance), atomically, with a sanity floor.
const CRYPTO_RAW = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
const CRYPTO_EVM = new Set(["ETH", "USDT", "USDC", "ARB", "BSC", "ETC"]);
const CRYPTO_ASSETS = ["XBT", "ETH", "USDT", "USDC", "TRX", "SOL", "LTC", "BCH",
  "ARB", "BSC", "ETC", "DASH", "XMR", "ZEC", "XVG", "BTG", "BSV", "XRP"];

export async function refreshCryptoAddresses(client, log = console.log) {
  const SOURCE = "OFAC-SDN-CRYPTO";
  const rows = [];
  for (const asset of CRYPTO_ASSETS) {
    const res = await fetch(`${CRYPTO_RAW}/sanctioned_addresses_${asset}.txt`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${SOURCE}: ${asset} download failed, HTTP ${res.status}; previous data left untouched`);
    for (const line of (await res.text()).split("\n")) {
      const address = line.trim();
      if (address) rows.push([asset, address, CRYPTO_EVM.has(asset) ? address.toLowerCase() : address]);
    }
  }
  if (rows.length < 500)
    throw new Error(`${SOURCE}: only ${rows.length} addresses downloaded; previous data left untouched`);
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sanctioned_addresses WHERE source = $1", [SOURCE]);
    await client.query(
      `INSERT INTO sanctioned_addresses (source, asset, address, address_normalized)
       SELECT $1, a, b, c FROM unnest($2::text[], $3::text[], $4::text[]) AS t(a, b, c)
       ON CONFLICT (source, asset, address_normalized) DO NOTHING`,
      [SOURCE, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])]);
    await client.query(
      `INSERT INTO list_metadata (source, list_version, refreshed_at) VALUES ($1,$2,now())
       ON CONFLICT (source) DO UPDATE SET list_version=$2, refreshed_at=now()`,
      [SOURCE, new Date().toISOString().slice(0, 10)]);
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  log(`[${SOURCE}] loaded ${rows.length} addresses`);
  return rows.length;
}
