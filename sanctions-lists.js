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

// ---- Publication dates ------------------------------------------------------
// Each publisher stamps its file with the date it was generated. That date,
// not the day we downloaded it, is the list version an audit record should
// cite. Returns YYYY-MM-DD, or null if the stamp isn't found (the caller then
// falls back to the download date).
const ymd = (y, m, d) => (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31)
  ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
export const versionOf = {
  OFAC: (xml) => { const m = xml.match(/<Publish_Date>\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*<\/Publish_Date>/);   // MM/DD/YYYY
                   return m ? ymd(m[3], m[1], m[2]) : null; },
  UN:   (xml) => { const m = xml.slice(0, 5000).match(/\bdateGenerated="(\d{4})-(\d{2})-(\d{2})/);
                   return m ? ymd(m[1], m[2], m[3]) : null; },
  EU:   (xml) => { const m = xml.slice(0, 5000).match(/\bgenerationDate="(\d{4})-(\d{2})-(\d{2})/);
                   return m ? ymd(m[1], m[2], m[3]) : null; },
  UK:   (xml) => { const m = xml.slice(0, 5000).match(/<DateGenerated>\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // DD/MM/YYYY
                   return m ? ymd(m[3], m[2], m[1]) : null; },
};

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
export async function storeRecords(client, source, records, version = null) {
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
      [source, version || new Date().toISOString().slice(0, 10)]);
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
  const version = versionOf[source]?.(xml) ?? null;
  const n = await storeRecords(client, source, records, version);
  log(`[${source}] loaded ${n} records, ` + (version ? `published ${version}` : "no publication date found in the file; using today's date"));
  return n;
}

// ---- OFAC sanctioned crypto addresses --------------------------------------
// Primary source: OFAC's own sdn_advanced.xml, the only place the addresses
// exist as structured data. Parsed here so we pick up every asset OFAC uses
// ("Digital Currency Address - <ASSET>"), not a fixed list, and so each
// address keeps the name and UID of the listed party it belongs to.
// Fallback: the per-asset files from 0xB10C/ofac-sanctioned-digital-currency-
// addresses (a nightly parse of the same XML, fixed asset list, no names), used
// only if Treasury's download or the parse fails.
const OFAC_ADVANCED_URL = "https://sanctionslistservice.ofac.treas.gov/api/download/sdn_advanced.xml";
const CRYPTO_RAW = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
const CRYPTO_ASSETS = ["XBT", "ETH", "USDT", "USDC", "TRX", "SOL", "LTC", "BCH",
  "ARB", "BSC", "ETC", "DASH", "XMR", "ZEC", "XVG", "BTG", "BSV", "XRP"];
const isEvm = (address) => /^0x[0-9a-fA-F]{40}$/.test(address);
// EVM (0x hex) addresses are case-insensitive; everything else (Base58,
// bech32 with mixed case not allowed, Monero...) is compared exactly.
export const normalizeAddress = (address) => (isEvm(address) ? address.toLowerCase() : address);

const xmlText = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

// Pure: sdn_advanced.xml string in, { version, addresses: [{asset, address,
// name, uid}] } out. Regex over the raw text rather than a DOM: the file is
// ~100 MB and only a few hundred parties carry addresses.
export function parseOFACCrypto(xml) {
  const types = new Map();   // FeatureTypeID -> asset code
  for (const m of xml.matchAll(/<FeatureType\b[^>]*\bID="(\d+)"[^>]*>\s*Digital Currency Address - ([^<]+?)\s*<\/FeatureType>/g))
    types.set(m[1], m[2].trim().toUpperCase());
  if (!types.size) return { version: null, addresses: [] };

  const d = xml.slice(0, 20000).match(/<(?:\w+:)?DateOfIssue\b[^>]*>[\s\S]{0,200}?<(?:\w+:)?Year\b[^>]*>(\d{4})<[\s\S]{0,100}?<(?:\w+:)?Month\b[^>]*>(\d{1,2})<[\s\S]{0,100}?<(?:\w+:)?Day\b[^>]*>(\d{1,2})</);
  const version = d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : null;

  const out = [];
  const seen = new Set();
  for (const pm of xml.matchAll(/<DistinctParty\b([^>]*)>([\s\S]*?)<\/DistinctParty>/g)) {
    const body = pm[2];
    if (!body.includes("FeatureTypeID")) continue;
    let name = null;
    const uid = (pm[1].match(/\bFixedRef="(\d+)"/) || [])[1] || null;
    for (const fm of body.matchAll(/<Feature\b[^>]*\bFeatureTypeID="(\d+)"[^>]*>([\s\S]*?)<\/Feature>/g)) {
      const asset = types.get(fm[1]);
      if (!asset) continue;
      if (name === null) {
        const alias = body.match(/<Alias\b[^>]*\bPrimary="true"[^>]*>([\s\S]*?)<\/Alias>/);
        const parts = alias ? [...alias[1].matchAll(/<NamePartValue\b[^>]*>([^<]*)<\/NamePartValue>/g)].map((x) => xmlText(x[1])) : [];
        name = parts.filter(Boolean).join(" ") || "";
      }
      for (const vm of fm[2].matchAll(/<VersionDetail\b[^>]*>([^<]+)<\/VersionDetail>/g)) {
        const address = xmlText(vm[1]);
        const key = asset + "|" + normalizeAddress(address);
        if (!address || seen.has(key)) continue;
        seen.add(key);
        out.push({ asset, address, name: name || null, uid });
      }
    }
  }
  return { version, addresses: out };
}

async function fetchCryptoFromOFAC(log) {
  const res = await fetch(OFAC_ADVANCED_URL, { redirect: "follow", signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`sdn_advanced.xml download failed, HTTP ${res.status}`);
  const { version, addresses } = parseOFACCrypto(await res.text());
  log(`[OFAC-SDN-CRYPTO] parsed ${addresses.length} addresses from sdn_advanced.xml (${version ?? "no date"})`);
  return { version, addresses, origin: "ofac" };
}

async function fetchCryptoFromMirror() {
  const addresses = [];
  for (const asset of CRYPTO_ASSETS) {
    const res = await fetch(`${CRYPTO_RAW}/sanctioned_addresses_${asset}.txt`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${asset} download failed, HTTP ${res.status}`);
    for (const line of (await res.text()).split("\n")) {
      const address = line.trim();
      if (address) addresses.push({ asset, address, name: null, uid: null });
    }
  }
  return { version: null, addresses, origin: "mirror" };
}

export async function refreshCryptoAddresses(client, log = console.log) {
  const SOURCE = "OFAC-SDN-CRYPTO";
  const MIN = 500;
  let data;
  try {
    data = await fetchCryptoFromOFAC(log);
    if (data.addresses.length < MIN) throw new Error(`only ${data.addresses.length} addresses parsed`);
  } catch (err) {
    log(`[${SOURCE}] OFAC direct parse failed (${String(err.message || err)}); using the 0xB10C mirror`);
    data = await fetchCryptoFromMirror();
  }
  const rows = data.addresses;
  if (rows.length < MIN)
    throw new Error(`${SOURCE}: only ${rows.length} addresses downloaded; previous data left untouched`);
  try {
    await client.query("BEGIN");
    // Migration-safe: older databases have the table without these columns.
    await client.query("ALTER TABLE sanctioned_addresses ADD COLUMN IF NOT EXISTS entity_name TEXT");
    await client.query("ALTER TABLE sanctioned_addresses ADD COLUMN IF NOT EXISTS entity_uid TEXT");
    await client.query("DELETE FROM sanctioned_addresses WHERE source = $1", [SOURCE]);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO sanctioned_addresses (source, asset, address, address_normalized, entity_name, entity_uid)
         SELECT $1, a, b, c, n, u FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(a, b, c, n, u)
         ON CONFLICT (source, asset, address_normalized) DO NOTHING`,
        [SOURCE, part.map((r) => r.asset), part.map((r) => r.address), part.map((r) => normalizeAddress(r.address)),
         part.map((r) => r.name), part.map((r) => r.uid)]);
    }
    const version = data.origin === "ofac" ? (data.version || new Date().toISOString().slice(0, 10))
                                           : new Date().toISOString().slice(0, 10) + " (mirror)";
    await client.query(
      `INSERT INTO list_metadata (source, list_version, refreshed_at) VALUES ($1,$2,now())
       ON CONFLICT (source) DO UPDATE SET list_version=$2, refreshed_at=now()`,
      [SOURCE, version]);
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  log(`[${SOURCE}] loaded ${rows.length} addresses (${data.origin})`);
  return rows.length;
}
