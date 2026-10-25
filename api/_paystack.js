// Shared by paystack-webhook.js and pay-verify.js: confirm a payment with Paystack itself, then activate the plan once.
const L = require("./_lib");
const PRICE = (plan) => L.num("PRICE_NGN_" + plan.toUpperCase(), plan === "pro" ? 1700 : 9500); // must match checkout.js

// Never trusts what the caller says: it asks Paystack for the transaction by reference.
// A reference can only activate a plan once (pay:<hash> is claimed with NX), so retries and double calls are safe.
async function verifyAndActivate(reference, onlyUid) {
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status || !j.data) return { ok: false, code: "lookup", msg: "Paystack could not find that payment." };
  const d = j.data, m = d.metadata || {}, uid = String(m.uid || ""), plan = String(m.plan || "");
  if (d.status !== "success") return { ok: false, code: "notpaid", msg: "That payment is not confirmed yet (status: " + d.status + ")." };
  if (!uid || (plan !== "pro" && plan !== "ultra")) return { ok: false, code: "meta", msg: "That payment is not linked to a Surg plan." };
  if (onlyUid && uid !== onlyUid) return { ok: false, code: "owner", msg: "That payment belongs to a different account." };
  if (String(d.currency || "NGN") !== "NGN" || Number(d.amount) < PRICE(plan) * 100) return { ok: false, code: "amount", msg: "The amount paid does not match the plan price." };
  const claim = "pay:" + L.hashCode(reference);
  const [got] = await L.redis([["SET", claim, JSON.stringify({ uid, plan, at: Date.now() }), "NX"]]);
  if (!got) return { ok: true, already: true, plan };
  try {
    const [sub] = await L.redis([["GET", "sub:" + uid]]);
    let cur = null; try { cur = sub ? JSON.parse(sub) : null; } catch (e) {}
    const from = cur && cur.until > Date.now() && cur.plan === plan ? cur.until : Date.now(); // renewing extends, changing plan starts now
    const until = from + 30 * 864e5;
    await L.redis([["SET", "sub:" + uid, JSON.stringify({ plan, until })]]);
    return { ok: true, plan, until };
  } catch (e) { await L.redis([["DEL", claim]]).catch(() => {}); throw e; } // let a retry try again
}
module.exports = { verifyAndActivate };
