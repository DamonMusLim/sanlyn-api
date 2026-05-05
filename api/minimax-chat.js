// /api/minimax-chat.js — MiniMax 文本对话代理（Task Workspace V1.5）
//
// POST { task_id: string, role_hint: string, prompt: string, max_tokens?: number }
//   → { ok, reply, model, tokens_in, tokens_out, cost_estimate_cny }
//
// Hard contract:
// - API key 永远在后端 env (process.env.MINIMAX_API_KEY)，前端从不接触
// - 单次 max_tokens 上限硬编码 800（防 prompt 注入烧钱）
// - prompt 长度上限 4000 字（防意外 dump 大文档）
// - rate-limit 同 task_id + 同 role 30 秒内只允许一次（防双击）
// - daily 总调用上限 100 次/全局（包月套餐还是要兜底）
// - 不写 DB；调用产生的 token / cost 仅 echo 给前端（前端自己累计到 task）
// - 不接 Wave 4 / approve / dispatch / queue 写入

const MINIMAX_URL = "https://api.minimax.chat/v1/text/chatcompletion_v2";

const ALLOWED = [
  "https://sanlyn-os.vercel.app",
  "https://ai.sanlynos.com",
  "https://ai.sanlyn.cn",
  "https://dashboard.sanlyn.cn",
  "http://localhost:5173",
  "http://localhost:5188",
  "http://localhost:3000",
];

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

// Rate-limit: in-memory only (per pm2 process). Resets on restart.
const RECENT = new Map();      // key = `${task_id}|${role_hint}` → ts
const COOLDOWN_MS = 30_000;
const DAILY_KEY = () => new Date().toISOString().slice(0, 10);
const DAILY = new Map();       // dateStr → count
const DAILY_CAP = 100;

const PROMPT_MAX_CHARS = 4000;
const MAX_TOKENS_HARD = 800;

// MiniMax abab6.5s pricing (CNY): rough average 0.01 / 1k tokens. Safe estimate.
function estimateCost(tokensIn, tokensOut) {
  return (tokensIn + tokensOut) / 1000 * 0.01;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  // Audit trail: log when running under dev bypass (never in prod path).
  if (req.user && req.user.sub === "dev-bypass") {
    console.log(`[minimax-chat] DEV-BYPASS request from ${req.ip || "?"} (NODE_ENV=${process.env.NODE_ENV || "unset"})`);
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: "minimax_api_key_not_configured",
      hint: "set MINIMAX_API_KEY in pm2 env on api.sanlyn.cn",
    });
  }

  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(req.body || "{}"); } catch { body = {}; }
  }
  const { task_id, role_hint, prompt } = body;
  const maxTokens = Math.min(Number(body.max_tokens) || 400, MAX_TOKENS_HARD);

  if (typeof task_id !== "string" || !task_id) return res.status(400).json({ ok: false, error: "task_id_required" });
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ ok: false, error: "prompt_required" });
  if (prompt.length > PROMPT_MAX_CHARS) {
    return res.status(400).json({ ok: false, error: "prompt_too_long", limit: PROMPT_MAX_CHARS });
  }

  // Rate-limit: per-task + per-role cooldown.
  const rlKey = `${task_id}|${role_hint || "default"}`;
  const last = RECENT.get(rlKey) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: "cooldown_active",
      retry_in_ms: COOLDOWN_MS - (now - last),
    });
  }

  // Daily cap.
  const dateKey = DAILY_KEY();
  const used = DAILY.get(dateKey) || 0;
  if (used >= DAILY_CAP) {
    return res.status(429).json({ ok: false, error: "daily_cap_reached", cap: DAILY_CAP, used });
  }

  // Build MiniMax request — tight, single-turn for V1.5.
  const systemPrompt = `你是 ${role_hint || "MiniMax"}，正在协助 Damon 处理任务 ${task_id}。简洁回答，3 条以内 bullet。如果不确定就说不确定，不要编。`;
  const payload = {
    model: "abab6.5s-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: prompt.slice(0, PROMPT_MAX_CHARS) },
    ],
    max_tokens: maxTokens,
    temperature: 0.4,
  };

  let upstream;
  try {
    upstream = await fetch(MINIMAX_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "minimax_unreachable", detail: String(e) });
  }

  let data;
  try { data = await upstream.json(); }
  catch { return res.status(502).json({ ok: false, error: "minimax_invalid_json" }); }

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      ok: false,
      error: "minimax_error",
      status: upstream.status,
      detail: data,
    });
  }

  // Stamp success → bump rate-limit.
  RECENT.set(rlKey, now);
  DAILY.set(dateKey, used + 1);
  // Garbage collect old daily keys (keep 7 days).
  if (DAILY.size > 14) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k] of DAILY) {
      if (Date.parse(k) < cutoff) DAILY.delete(k);
    }
  }

  const reply = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage || {};
  const tokensIn  = Number(usage.prompt_tokens     || usage.total_tokens || 0);
  const tokensOut = Number(usage.completion_tokens || 0);
  const cost = estimateCost(tokensIn, tokensOut);

  return res.status(200).json({
    ok: true,
    reply,
    model: data?.model || payload.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_cny: Number(cost.toFixed(4)),
    daily_used: used + 1,
    daily_cap: DAILY_CAP,
    cooldown_ms: COOLDOWN_MS,
  });
}
