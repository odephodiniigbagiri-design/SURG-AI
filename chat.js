// SURG AI backend: one endpoint that guards your Anthropic API key.
// Guards: logged-in accounts (see auth.js), per-user daily + per-minute limits, history/input trimming,
// output cap, and a daily + monthly spend cap measured from real token usage.
// Fails closed: if the counter store is unreachable, no request reaches Anthropic.

const crypto = require("crypto");
const { SYSTEM, SYSTEM_TASK } = require("./_system");
const L = require("./_lib");

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d; };

const CFG = {
  model: env("MODEL", "claude-haiku-5-5"),
  effort: env("EFFORT", "low"),                       // thinking is on by default for Haiku 5.5 and billed as output
  maxOutputTokens: num("MAX_OUTPUT_TOKENS", 1500),    // thinking tokens count inside this
  maxHistory: num("MAX_HISTORY_MESSAGES", 8),
  maxInputChars: num("MAX_INPUT_CHARS", 24000),
  monthlyTokensPerUser: num("MONTHLY_TOKENS_PER_USER", 900000),   // input + output (+thinking) tokens
  perUserMinute: num("MAX_MSGS_PER_USER_MINUTE", 6),
  dailyTokensPerUser: num("DAILY_TOKENS_PER_USER", 0),             // 0 = monthly allowance / 30
  dailyBudget: num("DAILY_BUDGET_USD", 3),
  monthlyBudget: num("MONTHLY_BUDGET_USD", 30),
  priceIn: num("PRICE_IN_PER_MTOK", 0.10),            // USD per million tokens (Haiku 5.5, prompts up to 100K)
  priceOut: num("PRICE_OUT_PER_MTOK", 0.50),
};

if (!CFG.dailyTokensPerUser) CFG.dailyTokensPerUser = Math.round(CFG.monthlyTokensPerUser / 30);


// AI provider: Claude through Amazon Bedrock (set BEDROCK_* keys) or through Anthropic's own API (ANTHROPIC_API_KEY).
const BEDROCK = !!process.env.BEDROCK_ACCESS_KEY_ID;
let brClient;
function bedrockClient() {
  if (!brClient) {
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    brClient = new BedrockRuntimeClient({
      region: env("BEDROCK_REGION", "us-east-1"),
      credentials: { accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID, secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY, ...(process.env.BEDROCK_SESSION_TOKEN ? { sessionToken: process.env.BEDROCK_SESSION_TOKEN } : {}) },
    });
  }
  return brClient;
}
async function askBedrock(system, messages, signal) {
  const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
  const out = await bedrockClient().send(new ConverseCommand({
    modelId: env("BEDROCK_MODEL_ID", "global.anthropic.claude-haiku-5-5"),
    system: [{ text: system }],
    messages: messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
    inferenceConfig: { maxTokens: CFG.maxOutputTokens },
    additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: CFG.effort } },
  }), { abortSignal: signal });
  const u = out.usage || {}, blocks = (out.output && out.output.message && out.output.message.content) || [];
  return {
    usage: { input_tokens: (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheWriteInputTokens || 0), output_tokens: u.outputTokens || 0 },
    content: blocks.filter((b) => typeof b.text === "string").map((b) => ({ type: "text", text: b.text })),
    stop_reason: out.stopReason,
  };
}

function send(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(obj));
}

async function redis(cmds) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error("redis " + x.error); return x.result; });
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  let msgs = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    if (m.content.length > CFG.maxInputChars) return null; // reject, never silently cut a question
    if (m.content.trim()) msgs.push({ role: m.role, content: m.content });
  }
  msgs = msgs.slice(-CFG.maxHistory);
  const total = () => msgs.reduce((a, m) => a + m.content.length, 0);
  while (msgs.length > 1 && (total() > CFG.maxInputChars || msgs[0].role !== "user")) msgs.shift();
  if (!msgs.length || msgs[0].role !== "user" || msgs[msgs.length - 1].role !== "user") return null;
  if (total() > CFG.maxInputChars) return null;
  return msgs;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return send(res, 405, { error: "POST only." });
  if ((!process.env.ANTHROPIC_API_KEY && !BEDROCK) || !process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN || !process.env.AUTH_SECRET)
    return send(res, 500, { error: "The server isn't configured yet." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const uid = L.verify(L.bearer(req));
  if (!uid) return send(res, 401, { error: "Please log in again." });
  body = body || {};

  const messages = cleanMessages(body.messages);
  if (!messages) return send(res, 400, { error: "That message is too long or malformed. Shorten it and try again." });

  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const minute = Math.floor(Date.now() / 60000);
  const kDay = "spend:day:" + day, kMonth = "spend:month:" + month;
  const tDay = "tok:" + uid + ":d:" + day, tMonth = "tok:" + uid + ":m:" + month, uMin = "u:" + uid + ":min:" + minute;

  let pre;
  try {
    pre = await redis([["GET", kDay], ["GET", kMonth], ["GET", tDay], ["GET", tMonth], ["INCR", uMin], ["EXPIRE", uMin, 120], ["GET", "sub:" + uid], ["GET", "trial:" + uid]]);
  } catch (e) {
    console.error("counter store failed", e.message);
    return send(res, 503, { error: "Surg is temporarily unavailable. Try again shortly." });
  }
  const spentDay = Number(pre[0] || 0) / 1e6, spentMonth = Number(pre[1] || 0) / 1e6;
  const pl = L.planOf(pre[6], pre[7]), monthlyCap = L.limits(pl.plan).monthlyTokens, dailyCap = Math.round(monthlyCap / 30);
  const tokDay = Number(pre[2] || 0), tokMonth = Number(pre[3] || 0), countMin = Number(pre[4]);

  if (spentMonth >= CFG.monthlyBudget) return send(res, 503, { error: "Surg has reached its monthly budget. It resets next month." });
  if (spentDay >= CFG.dailyBudget) return send(res, 503, { error: "Surg has reached today's budget. Try again tomorrow." });
  if (pl.plan === "none") return send(res, 402, { error: "Your free trial has ended. Choose a plan to keep using Surg.", plan: "none" });
  if (countMin > CFG.perUserMinute) return send(res, 429, { error: "Slow down a little. Try again in a minute." });
  if (tokMonth >= monthlyCap) return send(res, 429, { error: "You've used your Surg allowance for this month. It resets on the 1st (UTC)." });
  if (tokDay >= dailyCap) return send(res, 429, { error: "You've used today's share of your allowance. It resets at midnight UTC." });

  const undo = () => redis([["DECR", uMin]]).catch(() => {});

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  let data;
  try {
    if (BEDROCK) data = await askBedrock(body.task ? SYSTEM_TASK : SYSTEM, messages, ctl.signal);
    else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: CFG.model,
        max_tokens: CFG.maxOutputTokens,
        system: body.task ? SYSTEM_TASK : SYSTEM,
        output_config: { effort: CFG.effort },
        messages,
      }),
    });
    data = await r.json();
    if (!r.ok) {
      console.error("anthropic error", r.status, JSON.stringify(data).slice(0, 300));
      await undo();
      return send(res, 502, { error: "Surg couldn't answer just now. Try again." });
    }
    }
  } catch (e) {
    console.error("ai call failed", e.name, e.message);
    await undo();
    return send(res, 502, { error: "Surg couldn't answer just now. Try again." });
  } finally { clearTimeout(timer); }

  const u = data.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const micro = Math.ceil(inTok * CFG.priceIn + outTok * CFG.priceOut); // $/Mtok x tokens = micro-dollars
  try {
    await redis([["INCRBY", kDay, micro], ["EXPIRE", kDay, 259200], ["INCRBY", kMonth, micro], ["EXPIRE", kMonth, 3456000],
      ["INCRBY", tDay, inTok + outTok], ["EXPIRE", tDay, 259200], ["INCRBY", tMonth, inTok + outTok], ["EXPIRE", tMonth, 3456000]]);
  } catch (e) { console.error("could not record spend", e.message); }
  console.log(JSON.stringify({ u: uid, in: inTok, out: outTok, usd: micro / 1e6, stop: data.stop_reason }));

  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return send(res, 502, { error: "Surg's answer was cut off. Ask again, or shorten the question." });
  const used = inTok + outTok;
  send(res, 200, { text, plan: pl.plan, left: { today: Math.max(0, dailyCap - tokDay - used), month: Math.max(0, monthlyCap - tokMonth - used) } });
};
