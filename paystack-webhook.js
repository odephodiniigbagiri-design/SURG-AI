// Paystack calls this after a payment. We never trust the request itself: we take the
// transaction reference and ask Paystack directly whether it succeeded, then check the
// currency, amount, plan and student before granting 30 days.
const L = require("./_lib");

const naira = (plan) => L.num("PRICE_NGN_" + plan.toUpperCase(), plan === "pro" ? 1700 : 9500);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured() || !process.env.PAYSTACK_SECRET_KEY) return L.send(res, 500, { error: "Not configured." });
  const b = L.jbody(req) || {};
  const ref = b && b.data && b.data.reference ? String(b.data.reference) : "";
  if (b.event !== "charge.success" || !ref) return L.send(res, 200, { ok: true, ignored: true });

  let claimed = false;
  try {
    const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(ref), {
      headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY },
    });
    const j = await r.json().catch(() => ({}));
    const d = j && j.data;
    if (!r.ok || !j.status || !d || d.status !== "success") return L.send(res, 200, { ok: true, ignored: "not successful" });

    const meta = d.metadata || {}, plan = String(meta.plan || ""), uid = String(meta.uid || "");
    if ((plan !== "pro" && plan !== "ultra") || !uid || !ref.startsWith("surg_" + uid + "_")) return L.send(res, 200, { ok: true, ignored: "bad metadata" });
    if (d.currency !== "NGN" || Number(d.amount) < Math.round(naira(plan) * 100)) {
      console.error("paystack amount mismatch", ref, d.currency, d.amount);
      return L.send(res, 200, { ok: true, ignored: "amount mismatch" });
    }

    // Each reference can grant only once (Paystack may send the same event several times).
    const [first] = await L.redis([["SET", "paid:" + ref, "1", "NX"]]);
    if (first !== "OK") return L.send(res, 200, { ok: true, duplicate: true });
    claimed = true;

    const [exists, subRaw] = await L.redis([["GET", "uname:" + uid], ["GET", "sub:" + uid]]);
    if (!exists) return L.send(res, 200, { ok: true, ignored: "unknown student" });
    let cur = null; try { cur = subRaw ? JSON.parse(subRaw) : null; } catch (e) {}
    const from = cur && cur.until > Date.now() && cur.plan === plan ? cur.until : Date.now(); // same plan extends, new plan starts now
    await L.redis([["SET", "sub:" + uid, JSON.stringify({ plan, until: from + 30 * 864e5 })]]);
    return L.send(res, 200, { ok: true });
  } catch (e) {
    console.error("paystack webhook failed", e.message);
    if (claimed) { try { await L.redis([["DEL", "paid:" + ref]]); } catch (x) {} }
    return L.send(res, 500, { error: "Retry." }); // Paystack will resend
  }
};
