// Who am I, which plan am I on, and how much is left. The app uses this to unlock or lock features.
const L = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  try {
    const now = new Date(), day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
    const [sub, trial, name, tm, td, tt] = await L.redis([["GET", "sub:" + uid], ["GET", "trial:" + uid], ["GET", "uname:" + uid], ["GET", "tok:" + uid + ":m:" + month], ["GET", "tok:" + uid + ":d:" + day], ["GET", "tok:" + uid + ":trial"]]);
    const p = L.planOf(sub, trial);
    return L.send(res, 200, { username: name, plan: p.plan, until: p.until, trialEnds: p.trialEnds, limits: L.limits(p.plan), usage: { month: Number(p.plan === "trial" ? tt || 0 : tm || 0), day: Number(td || 0) } }); // on the trial, "month" means the whole trial
  } catch (e) {
    console.error("me failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
