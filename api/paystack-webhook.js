// Paystack calls this after a successful payment. Set the URL in Paystack: Settings > API Keys & Webhooks >
//   Webhook URL = https://YOUR-SITE/api/paystack-webhook   (live and test modes each have their own URL box)
// Needs PAYSTACK_SECRET_KEY. The signature is checked when the raw body is available, and the payment is always
// confirmed again with Paystack before anything is activated.
const crypto = require("crypto");
const L = require("./_lib");
const P = require("./_paystack");

const readRaw = (req) => new Promise((resolve) => {
  if (req.readableEnded || req.readable === false) return resolve(null);
  const parts = []; let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
  req.on("data", (c) => parts.push(Buffer.from(c))); req.on("end", () => fin(Buffer.concat(parts))); req.on("error", () => fin(null));
  setTimeout(() => fin(null), 5000);
});
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured() || !process.env.PAYSTACK_SECRET_KEY) return L.send(res, 500, { error: "Payments are not configured." });
  try {
    const raw = await readRaw(req);
    let event;
    if (raw && raw.length) {
      const mine = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
      if (!same(req.headers["x-paystack-signature"] || "", mine)) return L.send(res, 401, { error: "Bad signature." });
      try { event = JSON.parse(raw.toString("utf8")); } catch (e) { return L.send(res, 400, { error: "Bad body." }); }
    } else { event = L.jbody(req) || {}; console.warn("paystack-webhook: raw body unavailable, relying on API verification"); }
    if (event.event !== "charge.success") return L.send(res, 200, { ok: true, ignored: true });
    const ref = String((event.data && event.data.reference) || "");
    if (!/^[\w.=-]{5,100}$/.test(ref)) return L.send(res, 200, { ok: true, ignored: true });
    const out = await P.verifyAndActivate(ref, null);
    if (!out.ok) console.error("paystack-webhook: not activated", ref, out.code);
    return L.send(res, 200, { ok: out.ok, code: out.code || (out.already ? "already" : "activated") });
  } catch (e) {
    console.error("paystack-webhook failed", e.message);
    return L.send(res, 500, { error: "Try again." }); // Paystack retries on a non-200
  }
};
module.exports.config = { api: { bodyParser: false } };
