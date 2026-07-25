// api/public/taskhub-chat.js — thread.html 聊天线程接真 Claude 端点
// 独立文件(遵守 CLAUDE.md「新功能拆独立文件」),不往 taskhub.js 里堆。
//
// 契约(已由 Opus 验通,别改):
//   POST /api/public/taskhub/chat  body {message}
//   → 转发 mini 上已建好的 claude-chat-endpoint: http://100.87.134.113:3999/chat
//     header x-chat-token: sanlyn-chat-2026, body {message}
//   → 成功: {reply}
//   → 超时(35s)/连不上/非200: 降级返回 {reply:"⚠️ ...", degraded:true}(仍 200,不 500 崩,不假装)
//
// 2026-07-22 fast-worker 首版:端点地址+token 是契约给死的常量,不读环境变量(mini 侧固定服务,
// 非多环境部署对象)。若以后要换成 env 配置,那是架构决策,不在本次机械落地范围内。

const MINI_CHAT_URL = "http://100.87.134.113:3999/chat";
const MINI_CHAT_TOKEN = "sanlyn-chat-2026";
const TIMEOUT_MS = 35000;
const DEGRADED_REPLY = "⚠️ Claude 暂时不通(mini/隧道抖动),你的话我先记着,稍后可重试";

function setCorsChat(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function forwardToMini(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(MINI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-chat-token": MINI_CHAT_TOKEN,
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!r.ok) {
      console.error("[taskhub-chat] mini non-200:", r.status);
      return { ok: false };
    }
    const d = await r.json();
    if (!d || typeof d.reply !== "string") {
      console.error("[taskhub-chat] mini bad payload:", JSON.stringify(d).slice(0, 200));
      return { ok: false };
    }
    return { ok: true, reply: d.reply };
  } catch (err) {
    console.error("[taskhub-chat] forward failed:", err.message);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function handleChat(req, res) {
  const b = req.body || {};
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) {
    return res.status(200).json({ success: false, error: "message 不能为空" });
  }

  const result = await forwardToMini(message);
  if (result.ok) {
    return res.status(200).json({ success: true, reply: result.reply, degraded: false });
  }
  // 降级:不 500,不崩,如实告知
  return res.status(200).json({ success: true, reply: DEGRADED_REPLY, degraded: true });
}

export default async function handler(req, res) {
  setCorsChat(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const p = req.path || "";
  try {
    if (req.method === "POST" && p.endsWith("/chat")) return await handleChat(req, res);
    return res.status(404).json({ success: false, error: "unknown taskhub-chat route" });
  } catch (err) {
    console.error("[taskhub-chat]", err);
    // 兜底也走降级语义,不 500 崩前端
    return res.status(200).json({ success: true, reply: DEGRADED_REPLY, degraded: true });
  }
}
