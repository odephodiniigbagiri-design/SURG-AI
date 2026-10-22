// Starts a payment. Works with any provider that gives you hosted payment links, or with manual payment.
// Set CHECKOUT_URL_PRO / CHECKOUT_URL_ULTRA to your provider's payment links, and PAY_INSTRUCTIONS to tell
// students how to pay and how to reach you. {user}, {plan} and {price} are filled in. After you see the
// payment, activate the plan with api/admin.js (a provider webhook can call the same function later).
const L = require("./_lib");
const PRICES = { pro: "$1.10", ultra: "$6" };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only." });
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const plan = String((L.jbody(req) || {}).plan || "");
  if (!PRICES[plan]) return L.send(res, 400, { error: "Unknown plan." });
  try {
    const [name] = await L.redis([["GET", "uname:" + uid]]);
    const fill = (t) => String(t).replace(/\{user\}/g, name || "").replace(/\{plan\}/g, "Surg " + plan[0].toUpperCase() + plan.slice(1)).replace(/\{price\}/g, PRICES[plan]);
    const url = process.env["CHECKOUT_URL_" + plan.toUpperCase()] || "";
    const base = process.env.PAY_INSTRUCTIONS || "Payments are not open yet. Message the Surg team to subscribe to {plan} ({price} a month) and quote your username: {user}.";
    return L.send(res, 200, { url, message: fill(base) });
  } catch (e) {
    console.error("checkout failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
