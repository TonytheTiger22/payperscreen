// Date-of-birth comparison tests (no network, no DB). Run under any TZ.
import assert from "node:assert/strict";
import { parseLooseDate as p, compareDob as c } from "./dob.js";

assert.deepEqual(p("1965-01-22"), { y: 1965, m: 1, d: 22 });
assert.deepEqual(p("22 Jan 1965"), { y: 1965, m: 1, d: 22 });
assert.deepEqual(p("22 January 1965"), { y: 1965, m: 1, d: 22 });
assert.deepEqual(p("Jan 1965"), { y: 1965, m: 1, d: null });
assert.deepEqual(p("1965"), { y: 1965, m: null, d: null });
assert.deepEqual(p("circa 1965"), { y: 1965, m: null, d: null });
assert.deepEqual(p("1965 to 1967"), { y: 1965, y2: 1967, m: null, d: null });
assert.deepEqual(p("22/01/1965"), { y: 1965, m: 1, d: 22 });
assert.equal(p("sometime in the sixties"), null);

const s = (a, b) => c(a, b).status;
assert.equal(s("1965-01-22", "22 Jan 1965"), "match");      // the bug: was "differs" east of UTC
assert.equal(s("1965-01-22", "1965-01-22"), "match");
assert.equal(s("1965-01-23", "22 Jan 1965"), "differs");
assert.equal(s("1965-02-22", "22 Jan 1965"), "differs");
assert.equal(s("1966-01-22", "22 Jan 1965"), "differs");
assert.equal(s("1965-01-22", "1965"), "partial");
assert.equal(s("1965-01-22", "circa 1965"), "partial");
assert.equal(s("1965-01-22", "Jan 1965"), "partial");
assert.equal(s("1966-05-01", "1965 to 1967"), "partial");
assert.equal(s("1968-05-01", "1965 to 1967"), "differs");
assert.equal(s("", "1965"), "unknown");
assert.equal(s("1965-01-22", "unknown date"), "unknown");
console.log("dob tests OK");
