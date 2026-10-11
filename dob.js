// Date-of-birth parsing and comparison for /context (pure, no I/O).
// Dates arrive in several shapes: ISO "1965-01-22", OFAC's "22 Jan 1965",
// "Jan 1965", a bare year, "circa 1965" or a range "1965 to 1967". Parsed into
// plain numbers (never a Date object, whose timezone handling shifted
// "22 Jan 1965" to the 21st on servers east of UTC).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function parseLooseDate(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/^(circa|approximately|approx\.?|c\.)\s*/, "");
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/)) && MONTHS[m[2]]) return { y: +m[3], m: MONTHS[m[2]], d: +m[1] };
  if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/)) && MONTHS[m[1]]) return { y: +m[2], m: MONTHS[m[1]], d: null };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { y: +m[3], m: +m[2], d: +m[1] };   // dd/mm/yyyy
  if ((m = s.match(/^(\d{4})\s*(?:to|-|–)\s*(\d{4})$/))) return { y: +m[1], y2: +m[2], m: null, d: null };
  if ((m = s.match(/^(\d{4})$/))) return { y: +m[1], m: null, d: null };
  return null;
}

export function compareDob(subjectDob, listedDob) {
  if (!subjectDob || !listedDob)
    return { status: "unknown", note: "insufficient data to compare" };
  const a = parseLooseDate(subjectDob), b = parseLooseDate(listedDob);
  if (!a || !b) return { status: "unknown", note: "unparseable date format" };
  const lo = b.y, hi = b.y2 ?? b.y;
  if (a.y < lo || a.y > hi) return { status: "differs", note: b.y2 ? "year outside the listed range" : "differs" };
  if (b.y2) return { status: "partial", note: "year within the listed range" };
  if (b.m == null || a.m == null) return { status: "partial", note: "year matches; listed record has year only" };
  if (a.m !== b.m) return { status: "differs", note: "month differs" };
  if (b.d == null || a.d == null) return { status: "partial", note: "year and month match; listed record has no day" };
  return a.d === b.d ? { status: "match", note: "exact match" } : { status: "differs", note: "day differs" };
}
