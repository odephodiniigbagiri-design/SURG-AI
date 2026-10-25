// The app calls this when a student comes back from Paystack (or logs in again after paying), so their plan
// activates even if the webhook was late. Safe to call twice: a payment only ever activates once.
const L = require("./_lib");
const P = require("./_paystack");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured() || !process.env.PAYSTACK_SECRET_KEY) return L.send(res, 500, { error: "Payments are not configured." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const ref = String((L.jbody(req) || {}).reference || "");
  if (!/^[\w.=-]{5,100}$/.test(ref)) return L.send(res, 400, { error: "Bad payment reference." });
  try {
    const out = await P.verifyAndActivate(ref, uid);
    if (!out.ok) return L.send(res, out.code === "notpaid" ? 402 : 400, { error: out.msg });
    return L.send(res, 200, { ok: true, plan: out.plan, already: !!out.already });
  } catch (e) {
    console.error("pay-verify failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable. Try again shortly." });
  }
};
