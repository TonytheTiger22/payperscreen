import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const SELLER = process.env.SELLER_ADDRESS;
const app = express();
const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

const priced = (price, description) => ({
  accepts: [{ scheme: "exact", price, network: "eip155:84532", payTo: SELLER }],
  description, mimeType: "application/json",
});

app.use(paymentMiddleware(
  {
    "GET /screen":  priced("$0.02", "Sanctions screening"),
    "GET /context": priced("$0.05", "Field comparison"),
  },
  new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme()),
));

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

const WATCHLIST = [
  { name: "Viktor Petrov", dob: "1965-01-22", country: "Russian Federation",
    type: "Individual", list: "OFAC SDN", listVersion: "2026-08-17",
    program: "UKRAINE-EO14024", uid: "SDN-41287" },
  { name: "Elena Volkova", dob: "1972-11-03", country: "Belarus",
    type: "Individual", list: "EU Consolidated", listVersion: "2026-07-30",
    program: "BY-SANCTIONS", uid: "EU-88213" },
  { name: "Grand Horizon Trading LLC", dob: null, country: "Iran",
    type: "Entity", list: "OFAC SDN", listVersion: "2026-08-17",
    program: "IRAN-EO13902", uid: "SDN-55012" },
  { name: "Dmitri Sokolov", dob: "1980-05-14", country: "Russian Federation",
    type: "Individual", list: "UK OFSI", listVersion: "2026-08-01",
    program: "RUSSIA", uid: "OFSI-2201" },
  { name: "Wei Chen", dob: "1975-09-09", country: "North Korea",
    type: "Individual", list: "UN 1267", listVersion: "2026-06-15",
    program: "DPRK", uid: "UN-3391" },
];
const LISTS_CHECKED = ["OFAC SDN", "EU Consolidated", "UN 1267", "UK OFSI"];
const HIT_THRESHOLD = 0.55;

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function nameScore(input, candidate) {
  const a = normalize(input), b = normalize(candidate);
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const charSim = 1 - dist / Math.max(a.length, b.length);
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  const tokenSim = overlap / Math.max(ta.size, tb.size, 1);
  return Math.round(Math.max(charSim, tokenSim) * 100) / 100;
}

function bestMatch(name) {
  return WATCHLIST
    .map((w) => ({ ...w, score: nameScore(name, w.name) }))
    .sort((a, b) => b.score - a.score)[0];
}

app.get("/screen", (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id] || SUBJECTS.clean;
    return res.json({
      subject: { name: s.name, dob: s.dob, country: s.country, type: s.type },
      listsChecked: LISTS_CHECKED,
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
  const top = subject.name ? bestMatch(subject.name) : null;
  const hitCount = top && top.score >= HIT_THRESHOLD ? 1 : 0;
  res.json({
    subject,
    listsChecked: LISTS_CHECKED,
    screenedAt: new Date().toISOString(),
    hitCount,
    hits: hitCount ? [{ list: top.list, score: top.score, name: top.name }] : [],
  });
});

app.get("/context", (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id];
    if (!s || !s.hits.length) return res.json({ error: "No alert to contextualise" });
    const h = s.hits[0];
    return res.json({
      fields: [
        { field: "Name",          subject: s.name,    listed: h.listed.name,    agree: true  },
        { field: "Date of birth", subject: s.dob,      listed: h.listed.dob,     agree: false },
        { field: "Nationality",   subject: s.country,  listed: h.listed.country, agree: false },
        { field: "Entity type",   subject: s.type,     listed: h.listed.type,    agree: true  },
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
  const top = subject.name ? bestMatch(subject.name) : null;
  if (!top || top.score < HIT_THRESHOLD) return res.json({ error: "No alert to contextualise" });

  res.json({
    fields: [
      { field: "Name", subject: subject.name, listed: top.name, agree: true },
      { field: "Date of birth",
        subject: subject.dob || "not provided", listed: top.dob || "not listed",
        agree: !!subject.dob && subject.dob === top.dob },
      { field: "Nationality",
        subject: subject.country || "not provided", listed: top.country,
        agree: !!subject.country && subject.country.toLowerCase() === top.country.toLowerCase() },
      { field: "Entity type",
        subject: subject.type, listed: top.type,
        agree: subject.type === top.type },
    ],
    meta: { list: top.list, listVersion: top.listVersion, program: top.program,
            uid: top.uid, score: top.score, matchedOn: "Fuzzy name match" },
  });
});

app.listen(4025, () => console.log("Compliance API on 4025"));
