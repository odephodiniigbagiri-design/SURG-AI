// Owner tools, protected by ADMIN_KEY (send it in the x-admin-key header).
//  {action:"grant", username, plan:"pro"|"ultra", days:30}  activate or extend a paid plan
//  {action:"revoke", username}                                end a paid plan now
//  {action:"lookup", username}                                see a student's plan
//  {action:"newcodes", count:10, note:"Year 3"}               create single-use invite codes (shown once)
//  {action:"feedback", limit:100}                             latest thumbs, newest first, with counts
const crypto = require("crypto");
const L = require("./_lib");

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured() || !process.env.ADMIN_KEY) return L.send(res, 500, { error: "Admin is not configured." });
  const b = L.jbody(req) || {};
  try {
    const rk = "rl:admin:" + Math.floor(Date.now() / 6e4);
    const [tries] = await L.redis([["INCR", rk], ["EXPIRE", rk, 120]]);
    if (Number(tries) > 20) return L.send(res, 429, { error: "Too many attempts. Wait a minute." });
    if (!same((req.headers && req.headers["x-admin-key"]) || "", process.env.ADMIN_KEY)) return L.send(res, 401, { error: "Wrong admin key." });
    if (b.action === "newcodes") {
      const n = Math.min(Math.max(Number(b.count) || 1, 1), 50), note = String(b.note || "").slice(0, 60), letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const pick = () => Array.from(crypto.randomBytes(8), (x) => letters[x % letters.length]).join("");
      const codes = Array.from({ length: n }, () => { const c = pick(); return "SURG-" + c.slice(0, 4) + "-" + c.slice(4); });
      await L.redis(codes.map((c) => ["SET", "inv:" + L.hashCode(c), JSON.stringify({ note, at: Date.now() })]));
      return L.send(res, 200, { codes });
    }
    if (b.action === "feedback") {
      const rows = (await L.redis([["LRANGE", "fb", 0, Math.min(Number(b.limit) || 100, 500) - 1]]))[0] || [];
      const items = rows.map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
      return L.send(res, 200, { up: items.filter((x) => x.v === "up").length, down: items.filter((x) => x.v === "down").length, items });
    }
    const name = String(b.username || "").trim().toLowerCase();
    const [raw] = await L.redis([["GET", "acct:" + name]]);
    if (!raw) return L.send(res, 404, { error: "No such student." });
    const uid = JSON.parse(raw).uid, key = "sub:" + uid;
    const [sub, trial] = await L.redis([["GET", key], ["GET", "trial:" + uid]]);
    if (b.action === "lookup") return L.send(res, 200, { username: name, ...L.planOf(sub, trial) });
    if (b.action === "revoke") { await L.redis([["DEL", key]]); return L.send(res, 200, { username: name, ...L.planOf(null, trial) }); }
    if (b.action === "grant") {
      if (b.plan !== "pro" && b.plan !== "ultra") return L.send(res, 400, { error: "plan must be pro or ultra." });
      const days = Math.min(Math.max(Number(b.days) || 30, 1), 366);
      let cur = null; try { cur = sub ? JSON.parse(sub) : null; } catch (e) {}
      const from = cur && cur.until > Date.now() && cur.plan === b.plan ? cur.until : Date.now(); // renewing extends, changing plan starts now
      await L.redis([["SET", key, JSON.stringify({ plan: b.plan, until: from + days * 864e5 })]]);
      return L.send(res, 200, { username: name, ...L.planOf(JSON.stringify({ plan: b.plan, until: from + days * 864e5 }), trial) });
    }
    return L.send(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("admin failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
