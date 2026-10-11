// Data retention, as stated on /privacy. Runs once at startup and then daily.
//   - check records (audit trail): 5 years after the check
//   - prepaid ledger, nonces, expired sessions/tokens: ledger 7 years
//     (Dutch tax record-keeping), expired sign-in material straight away
//   - visit statistics: 13 months
import { db } from "./db.js";

const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString(); };
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString(); };

const run = (sql, ...args) => { try { return db.prepare(sql).run(...args).changes; } catch { return 0; } };

export function purgeExpired() {
  const now = new Date().toISOString();
  const n = {
    checks: run("DELETE FROM checks WHERE performed_at < ?", yearsAgo(5)),
    ledger: run("DELETE FROM credit_ledger WHERE created_at < ?", yearsAgo(7)),
    visits: run("DELETE FROM visits WHERE ts < ?", monthsAgo(13)),
    sessions: run("DELETE FROM sessions WHERE expires_at < ?", now)
      + run("DELETE FROM admin_sessions WHERE expires_at < ?", now)
      + run("DELETE FROM credit_sessions WHERE expires_at < ?", now),
    tokens: run("DELETE FROM login_tokens WHERE expires_at < ?", now)
      + run("DELETE FROM credit_nonces WHERE expires_at < ?", now),
  };
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  if (total) console.log("Retention purge:", JSON.stringify(n));
  return n;
}

export function scheduleRetention() {
  setTimeout(purgeExpired, 30_000);
  setInterval(purgeExpired, 24 * 3600_000).unref?.();
}
