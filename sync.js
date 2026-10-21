// Saves each student's progress (flashcards, study notes, weak areas, profile) under their account.
// Version check: if another device saved first, the write is refused with 409 and the newer data.
const L = require("./_lib");
const MAX = 500000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const key = "data:" + uid;
  try {
    const [raw] = await L.redis([["GET", key]]);
    const cur = raw ? JSON.parse(raw) : { v: 0, data: null };
    if (req.method === "GET") return L.send(res, 200, cur);
    if (req.method !== "PUT") return L.send(res, 405, { error: "GET or PUT only." });
    const b = L.jbody(req) || {};
    if (!b.data || typeof b.data !== "object" || JSON.stringify(b.data).length > MAX) return L.send(res, 413, { error: "Your saved data is too large or malformed." });
    if (Number(b.base || 0) !== cur.v) return L.send(res, 409, cur);
    const next = { v: cur.v + 1, at: Date.now(), data: b.data };
    await L.redis([["SET", key, JSON.stringify(next)]]);
    return L.send(res, 200, { v: next.v });
  } catch (e) {
    console.error("sync failed", e.message);
    return L.send(res, 503, { error: "Sync is temporarily unavailable." });
  }
};
