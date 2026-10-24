// Sign up (open to anyone, with per-network and per-day limits; starts a small free trial) and log in. Passwords are stored as salted scrypt hashes.
const crypto = require("crypto");
const L = require("./_lib");


module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const b = L.jbody(req) || {};
  const name = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
  if (!/^[a-z0-9_.-]{3,24}$/.test(name)) return L.send(res, 400, { error: "Username: 3 to 24 letters, numbers, dots, dashes or underscores." });
  if (pw.length < 8 || pw.length > 100) return L.send(res, 400, { error: "Password must be 8 to 100 characters." });
  try {
    if (b.action === "signup") {
      const sk = "rl:signup:" + Math.floor(Date.now() / 6e4);
      const [tries] = await L.redis([["INCR", sk], ["EXPIRE", sk, 120]]);
      if (Number(tries) > 30) return L.send(res, 429, { error: "Too many attempts. Try again in a minute." });
      // Abuse limits: accounts per network per day, and accounts overall per day (each new account gets a small free trial).
      const day = new Date().toISOString().slice(0, 10), xf = String((req.headers && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"])) || "").split(",")[0].trim() || "unknown";
      const ipk = "rl:signup:ip:" + L.hashCode(xf) + ":" + day, dk = "rl:signup:day:" + day;
      const [ipn, dn] = await L.redis([["GET", ipk], ["GET", dk]]);
      if (Number(ipn || 0) >= L.num("SIGNUPS_PER_IP_DAY", 8)) return L.send(res, 429, { error: "Too many accounts were created from this network today. Try again tomorrow." });
      if (Number(dn || 0) >= L.num("MAX_SIGNUPS_PER_DAY", 300)) return L.send(res, 429, { error: "Sign-ups are full for today. Please try again tomorrow." });
      const salt = crypto.randomBytes(16).toString("hex"), uid = crypto.randomBytes(8).toString("hex");
      const hash = (await L.scrypt(pw, salt)).toString("hex");
      const [ok] = await L.redis([["SET", "acct:" + name, JSON.stringify({ uid, salt, hash, at: Date.now() }), "NX"]]);
      if (!ok) return L.send(res, 409, { error: "That username is taken. Pick another." });
      await L.redis([["SET", "trial:" + uid, String(Date.now() + L.TRIAL_DAYS() * 864e5)], ["SET", "uname:" + uid, name], ["INCR", ipk], ["EXPIRE", ipk, 90000], ["INCR", dk], ["EXPIRE", dk, 90000]]);
      return L.send(res, 200, { token: L.sign(uid), username: name });
    }
    if (b.action === "login") {
      const rk = "rl:login:" + name + ":" + Math.floor(Date.now() / 6e5);
      const [n] = await L.redis([["INCR", rk], ["EXPIRE", rk, 900]]);
      if (Number(n) > 8) return L.send(res, 429, { error: "Too many attempts. Try again in a few minutes." });
      const [raw] = await L.redis([["GET", "acct:" + name]]);
      const a = raw ? JSON.parse(raw) : null;
      const h = await L.scrypt(pw, a ? a.salt : "x");
      if (!a || !crypto.timingSafeEqual(h, Buffer.from(a.hash, "hex"))) return L.send(res, 401, { error: "Wrong username or password." });
      return L.send(res, 200, { token: L.sign(a.uid), username: name });
    }
    return L.send(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("auth failed", e.message);
    return L.send(res, 503, { error: "Sign-in is temporarily unavailable. Try again shortly." });
  }
};
