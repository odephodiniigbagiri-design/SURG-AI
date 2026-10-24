// Shared helpers: Redis (Upstash REST), signed login tokens, password hashing.
const crypto = require("crypto");

const send = (res, status, obj) => res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(obj));
const jbody = (req) => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } } return b; };

async function redis(cmds) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error("redis " + x.error); return x.result; });
}

const b64 = (s) => Buffer.from(s).toString("base64url");
const mac = (p) => crypto.createHmac("sha256", process.env.AUTH_SECRET).update(p).digest("base64url");
const sign = (uid) => { const p = b64(JSON.stringify({ u: uid, e: Date.now() + 30 * 864e5 })); return p + "." + mac(p); };
function verify(t) {
  if (!t || typeof t !== "string" || !process.env.AUTH_SECRET) return null;
  const [p, sig] = t.split(".");
  if (!p || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.e > Date.now() ? o.u : null; } catch (e) { return null; }
}
const bearer = (req) => String((req.headers && req.headers.authorization) || "").replace(/^Bearer /, "");
const hashCode = (c) => crypto.createHash("sha256").update(c).digest("hex").slice(0, 24);
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));
const configured = () => !!(process.env.AUTH_SECRET && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== "" && process.env[k] !== undefined ? v : d; };
const TRIAL_DAYS = () => num("TRIAL_DAYS", 3);
// What each plan includes. Trial = Pro for a few days. "none" = trial over and nothing paid: AI locked.
function limits(plan) {
  const pro = { monthlyTokens: num("MONTHLY_TOKENS_PER_USER", 900000), voice: false, libraryChars: 12000000 };
  if (plan === "ultra") return { monthlyTokens: num("ULTRA_TOKENS_PER_USER", 1800000), voice: true, libraryChars: 24000000 };
  if (plan === "none") return { ...pro, monthlyTokens: 0 };
  // Free trial: a one-off pool of tokens (monthlyTokens here = the whole trial) with a daily share, no voice, smaller library.
  if (plan === "trial") return { monthlyTokens: num("TRIAL_TOKENS", 45000), dailyTokens: num("TRIAL_DAILY_TOKENS", 15000), voice: false, libraryChars: 3000000, trial: true };
  return pro;
}
function planOf(subRaw, trialRaw) {
  const now = Date.now(); let sub = null;
  try { sub = subRaw ? JSON.parse(subRaw) : null; } catch (e) {}
  if (sub && sub.until > now && (sub.plan === "pro" || sub.plan === "ultra")) return { plan: sub.plan, until: sub.until, trialEnds: 0 };
  const te = Number(trialRaw || 0);
  return te > now ? { plan: "trial", until: 0, trialEnds: te } : { plan: "none", until: 0, trialEnds: te };
}
module.exports = { num, TRIAL_DAYS, limits, planOf, send, jbody, redis, sign, verify, bearer, hashCode, scrypt, configured };
