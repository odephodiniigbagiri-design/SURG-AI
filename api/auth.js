// Sign up (needs a one-time invite code) and log in. Passwords are stored as salted scrypt hashes.
const crypto = require("crypto");
const L = require("./_lib");

const CODES = new Set((process.env.INVITE_CODES || "").split(",").map((s) => s.trim()).filter(Boolean));

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
      const code = String(b.code || "").trim(), made = code.toUpperCase();
      const fromAdmin = CODES.has(code) ? null : (await L.redis([["GET", "inv:" + L.hashCode(made)]]))[0];
      if (!CODES.has(code) && !fromAdmin) return L.send(res, 403, { error: "That invite code is not valid." });
      const ck = "code:" + L.hashCode(CODES.has(code) ? code : made);
      const [claimed] = await L.redis([["SET", ck, name, "NX"]]);
      if (!claimed) return L.send(res, 409, { error: "That invite code has already been used." });
      const salt = crypto.randomBytes(16).toString("hex"), uid = crypto.randomBytes(8).toString("hex");
      const hash = (await L.scrypt(pw, salt)).toString("hex");
      const [ok] = await L.redis([["SET", "acct:" + name, JSON.stringify({ uid, salt, hash, at: Date.now() }), "NX"]]);
      if (!ok) { await L.redis([["DEL", ck]]); return L.send(res, 409, { error: "That username is taken. Pick another." }); }
      await L.redis([["SET", "trial:" + uid, String(Date.now() + L.TRIAL_DAYS() * 864e5)], ["SET", "uname:" + uid, name]]);
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
