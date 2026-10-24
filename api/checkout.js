// Starts a Paystack payment in naira (NGN). The student pays on Paystack's hosted page;
// Paystack then calls api/paystack-webhook.js, which activates the plan.
// Falls back to the old manual instructions if PAYSTACK_SECRET_KEY is not set.
const crypto = require("crypto");
const L = require("./_lib");

const USD = { pro: "$1.10", ultra: "$6" };
const naira = (plan) => L.num("PRICE_NGN_" + plan.toUpperCase(), plan === "pro" ? 1700 : 9500);
const fmt = (n) => "\u20A6" + n.toLocaleString("en-NG");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const plan = String((L.jbody(req) || {}).plan || "");
  if (!USD[plan]) return L.send(res, 400, { error: "Unknown plan." });
  try {
    const [name] = await L.redis([["GET", "uname:" + uid]]);
    const label = "Surg " + plan[0].toUpperCase() + plan.slice(1);

    if (!process.env.PAYSTACK_SECRET_KEY) {
      const fill = (t) => String(t).replace(/\{user\}/g, name || "").replace(/\{plan\}/g, label).replace(/\{price\}/g, USD[plan]);
      const url = process.env["CHECKOUT_URL_" + plan.toUpperCase()] || "";
      const base = process.env.PAY_INSTRUCTIONS || "Payments are not open yet. Message the Surg team to subscribe to {plan} ({price} a month) and quote your username: {user}.";
      return L.send(res, 200, { url, message: fill(base) });
    }

    const amount = naira(plan);
    const reference = "surg_" + uid + "_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const domain = process.env.PAYSTACK_EMAIL_DOMAIN || "example.com"; // students have no email; Paystack needs one
    const origin = process.env.SITE_URL || "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const r = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: uid + "@" + domain,
        amount: Math.round(amount * 100), // kobo
        currency: "NGN",
        reference,
        callback_url: origin + "/",
        metadata: { uid, plan, username: name || "" },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status || !j.data || !j.data.authorization_url) {
      console.error("paystack init failed", r.status, j && j.message);
      return L.send(res, 502, { error: "Could not start the payment. Try again in a moment." });
    }
    return L.send(res, 200, {
      url: j.data.authorization_url,
      message: label + ": " + fmt(amount) + " (" + USD[plan] + ") for 30 days. Tap Open payment page, pay, then come back here. Your plan activates automatically within a minute.",
    });
  } catch (e) {
    console.error("checkout failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
