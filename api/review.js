// Weak-spot queue with spaced review (1, 3, 7, then 14 days). Private per student: everything lives under weak:<uid>.
//  GET  /api/review?d=YYYY-MM-DD            -> today's due items + counts
//  POST {action:"save", d, items:[{topic,q,a}]}   save missed questions (a repeat miss resets that item to 1 day)
//  POST {action:"grade", d, id, r:"good"|"fair"|"poor"}  good = next interval, fair = repeat interval, poor = back to 1 day
// The AI rating itself is made through /api/chat (task mode), so it already counts toward the monthly token allowance.
const L = require("./_lib");

const INT = [1, 3, 7, 14], MAX_ITEMS = 300, MAX_LOG = 500;
const dstr = (d) => d.toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return dstr(d); };
const clip = (x, n) => String(x || "").replace(/\s+/g, " ").trim().slice(0, n);
// The student's own calendar day, accepted only if it is within a day of the server's UTC date.
const today = (s) => { const u = dstr(new Date()); s = String(s || ""); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Math.abs(Date.parse(s) - Date.parse(u)) <= 864e5 ? s : u; };

function view(st, t) {
  const live = st.items.filter((i) => !i.done), due = live.filter((i) => i.due <= t).sort((a, b) => (a.due < b.due ? -1 : 1));
  const next = live.filter((i) => i.due > t).map((i) => i.due).sort()[0] || null;
  return { due: due.slice(0, 50), dueCount: due.length, total: live.length, cleared: st.cleared || 0, next };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!L.configured()) return L.send(res, 500, { error: "The server isn't configured yet." });
  const uid = L.verify(L.bearer(req));
  if (!uid) return L.send(res, 401, { error: "Please log in again." });
  const key = "weak:" + uid;
  try {
    const [raw] = await L.redis([["GET", key]]);
    let st = { items: [], cleared: 0, log: [] };
    try { if (raw) st = { ...st, ...JSON.parse(raw) }; } catch (e) {}
    if (req.method === "GET") return L.send(res, 200, view(st, today((req.query || {}).d)));
    if (req.method !== "POST") return L.send(res, 405, { error: "GET or POST only." });

    const b = L.jbody(req) || {}, t = today(b.d);
    if (b.action === "save") {
      const list = Array.isArray(b.items) ? b.items.slice(0, 5) : [];
      const rk = "rl:wk:" + uid + ":" + dstr(new Date());
      const [n] = await L.redis([["INCR", rk], ["EXPIRE", rk, 172800]]);
      if (Number(n) > 60) return L.send(res, 429, { error: "Too many saved items today." });
      for (const it of list) {
        const q = clip(it && it.q, 300), a = clip(it && it.a, 500), topic = clip(it && it.topic, 60) || "General";
        if (q.length < 5 || a.length < 2) continue;
        const id = L.hashCode(q.toLowerCase()).slice(0, 12), old = st.items.find((x) => x.id === id);
        if (old) Object.assign(old, { topic, a, step: 0, due: addDays(t, 1), done: false });
        else st.items.push({ id, topic, q, a, at: Date.now(), step: 0, due: addDays(t, 1), n: 0, done: false });
      }
      if (st.items.length > MAX_ITEMS) { // keep the newest, dropping cleared items first
        st.items.sort((x, y) => (x.done === y.done ? y.at - x.at : x.done ? 1 : -1));
        st.items = st.items.slice(0, MAX_ITEMS);
      }
      await L.redis([["SET", key, JSON.stringify(st)]]);
      return L.send(res, 200, view(st, t));
    }
    if (b.action === "grade") {
      const it = st.items.find((x) => x.id === String(b.id || "") && !x.done), r = b.r;
      if (!it) return L.send(res, 404, { error: "That item is no longer in your queue." });
      if (r !== "good" && r !== "fair" && r !== "poor") return L.send(res, 400, { error: "Bad rating." });
      if (r === "good") {
        if (it.step >= INT.length - 1) { it.done = true; it.doneAt = t; st.cleared = (st.cleared || 0) + 1; }
        else { it.step++; it.due = addDays(t, INT[it.step]); }
      } else if (r === "fair") it.due = addDays(t, INT[it.step]);
      else { it.step = 0; it.due = addDays(t, 1); }
      it.n = (it.n || 0) + 1; it.last = t;
      st.log = (st.log || []).concat([{ t: Date.now(), d: t, topic: it.topic, r }]).slice(-MAX_LOG);
      await L.redis([["SET", key, JSON.stringify(st)]]);
      return L.send(res, 200, { ...view(st, t), item: { id: it.id, due: it.due, done: !!it.done, days: it.done ? 0 : INT[it.step] } });
    }
    return L.send(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("review failed", e.message);
    return L.send(res, 503, { error: "Temporarily unavailable." });
  }
};
