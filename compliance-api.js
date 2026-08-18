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
    "GET /context": priced("$0.05", "Alert context pack"),
  },
  new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme()),
));

const SUBJECTS = {
  clean: {
    name: "Maria Santos Oliveira", dob: "1981-04-12",
    country: "Portugal", type: "Individual",
    hits: [],
  },
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

app.get("/screen", (req, res) => {
  const s = SUBJECTS[req.query.id] || SUBJECTS.clean;
  res.json({
    subject: { name: s.name, dob: s.dob, country: s.country, type: s.type },
    listsChecked: ["OFAC SDN", "EU Consolidated", "UN 1267", "UK OFSI"],
    screenedAt: new Date().toISOString(),
    hitCount: s.hits.length,
    hits: s.hits.map(h => ({ list: h.list, score: h.score, name: h.listed.name })),
  });
});

app.get("/context", (req, res) => {
  const s = SUBJECTS[req.query.id];
  if (!s || !s.hits.length) return res.json({ error: "No alert to contextualise" });
  const h = s.hits[0];
  const fields = [
    { field: "Name",        subject: s.name,    listed: h.listed.name,    agree: true  },
    { field: "Date of birth", subject: s.dob,   listed: h.listed.dob,     agree: false },
    { field: "Nationality", subject: s.country, listed: h.listed.country, agree: false },
    { field: "Entity type", subject: s.type,    listed: h.listed.type,    agree: true  },
  ];
  res.json({
    fields,
    meta: { list: h.list, listVersion: h.listVersion, program: h.listed.program,
            uid: h.listed.uid, score: h.score, matchedOn: h.matchedOn },
    narrative:
      "The alert was raised on an exact match of both name tokens. The subject's "
      + "recorded date of birth differs from the listed party's by 13 years. Recorded "
      + "nationality differs. Entity type agrees. The listed party is designated under "
      + h.listed.program + ". No secondary identifiers (passport, national ID, address) "
      + "are present on either record to corroborate or exclude the match.",
    completeness: [
      { check: "Name basis stated", ok: true },
      { check: "Date of birth compared", ok: true },
      { check: "Nationality compared", ok: true },
      { check: "Entity type compared", ok: true },
      { check: "Secondary identifiers available", ok: false },
      { check: "Ownership / control assessed", ok: false },
    ],
  });
});

app.listen(4025, () => console.log("Compliance API on 4025"));
