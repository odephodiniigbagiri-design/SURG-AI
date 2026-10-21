// Thumbs up / down on Surg's answers. Stores a short snippet of the question and answer so you can
// see where students struggle and improve Surg's instructions. No username is stored with it.
const L = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const b = L.jbody(req) || {};
  if (b.v !== "up" && b.v !== "down") return L.send(res, 400, { error: "Bad rating." });
  const clip = (x, n) => String(x || "").slice(0, n);
  const item = { t: Date.now(), v: b.v, why: clip(b.why, 30), mode: clip(b.mode, 20), q: clip(b.q, 300), a: clip(b.a, 600) };
  try {
    const dk = "fb:" + uid + ":" + new Date().toISOString().slice(0, 10);
    const [n] = await L.redis([["INCR", dk], ["EXPIRE", dk, 172800]]);
    if (Number(n) > 100) return L.send(res, 429, { error: "Too much feedback today." });
    await L.redis([["LPUSH", "fb", JSON.stringify(item)], ["LTRIM", "fb", 0, 1999]]);
    return L.send(res, 200, { ok: true });
  } catch (e) {
    console.error("feedback failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
