// api/ideas-capture.js
// ClawBot Webhook → MiniMax 分析 → Trilium 存储 → 微信回复
//
// POST /api/ideas-capture   — ClawBot 发过来的消息

import { setCors } from "./db.js";

const MINIMAX_KEY  = process.env.MINIMAX_API_KEY  || "sk-cp--TQnRmQajBd6Rbng3ptBw4aES0erZfkbPS2nbYddkiG7pvRN9P3HBAUfhxyarR2m4XYNnJOIicdkqCU3MoI6AK7z4tSEp-a2VCcWoV4WCNF3uLJyJpop83M";
const MINIMAX_URL  = process.env.MINIMAX_BASE_URL  || "https://api.minimaxi.com/v1/text/chatcompletion_v2";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL   || "MiniMax-M2.7-highspeed";
const TRILIUM_URL  = "https://notes.sanlyn.cn";
const TRILIUM_TOKEN = process.env.TRILIUM_TOKEN   || "AQfSZjIZBWh9_Ynknz4Zhnak8hIA93N5KDOf/T6CZWspSoJ5r7/5NPsA=";

// Trilium 各分类的 noteId（建目录时生成的）
const TRILIUM_FOLDERS = {
  douyin:   "DojtvNgDEmQL",  // 📱 抖音灵感
  supply:   "FH6Sm37qWzRH",  // 📦 供应链 & 物流
  ai:       "3ld5zLgqhwq3",  // 🤖 AI 自动化
  product:  "kwyVhAIYgXkb",  // 🎯 产品功能
  inbox:    "VlCrVWKhWtZh",  // 📝 随手记
};

// ── MiniMax 分析 ──────────────────────────────────────────────
async function analyzeWithMinimax(content) {
  const prompt = `你是 Sanlyn 创始人的个人助理，帮他整理业务想法。

用户发来了以下内容（可能是链接、截图描述、或文字想法）：
---
${content}
---

请完成以下任务，用 JSON 格式回复：
{
  "title": "一句话标题（中文，15字以内）",
  "summary": "3个关键点，每点一句话",
  "category": "分类，只能是以下之一：douyin / supply / ai / product / inbox",
  "project": "关联的 Sanlyn 项目（如：Workflow Engine / Customer Portal / Factory Portal / Lyn Jarvis / QC系统 / 无）",
  "action": "建议下一步行动（一句话，如果没有就写 null）"
}

分类规则：
- douyin：来自抖音/社交媒体的案例或灵感
- supply：供应链、物流、单证、报关相关
- ai：AI自动化、工作流、智能提醒相关
- product：Sanlyn OS 产品功能相关
- inbox：其他，暂时无法分类`;

  const resp = await fetch(MINIMAX_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + MINIMAX_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    })
  });

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { title: "新想法", summary: text, category: "inbox", project: "无", action: null };
  }
}

// ── 存入 Trilium ──────────────────────────────────────────────
async function saveToTrilium(analysis, rawContent) {
  const folderId = TRILIUM_FOLDERS[analysis.category] || TRILIUM_FOLDERS.inbox;
  const summaryHtml = (analysis.summary || "")
    .split("\n").filter(Boolean)
    .map(l => `<li>${l}</li>`).join("");

  const content = `
<h2>${analysis.title}</h2>
<h3>原始内容</h3>
<pre>${rawContent}</pre>
<h3>AI 分析</h3>
<ul>${summaryHtml}</ul>
${analysis.project && analysis.project !== "无" ? `<p><b>关联项目：</b>${analysis.project}</p>` : ""}
${analysis.action ? `<p><b>建议行动：</b>${analysis.action}</p>` : ""}
<p style="color:#999;font-size:11px">由 AI 自动整理 · ${new Date().toLocaleString("zh-CN")}</p>`.trim();

  const resp = await fetch(`${TRILIUM_URL}/etapi/create-note`, {
    method: "POST",
    headers: {
      "Authorization": TRILIUM_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      parentNoteId: folderId,
      title: analysis.title,
      type: "text",
      content
    })
  });

  return await resp.json();
}

// ── 主入口 ────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body || {};

    // ClawBot message 格式：{ message: { content, type, sender }, ... }
    const msgContent = body?.message?.content || body?.content || body?.text || "";
    const msgType    = body?.message?.type    || body?.type    || "text";
    const sender     = body?.message?.sender  || body?.sender  || "unknown";

    if (!msgContent) return res.status(200).json({ reply: "没有收到内容" });

    // 只处理文字和链接（图片暂跳过）
    if (msgType === "image") {
      return res.status(200).json({ reply: "图片暂时只能记录，文字描述更好分析哦～" });
    }

    // 调 MiniMax 分析
    const analysis = await analyzeWithMinimax(msgContent);

    // 存 Trilium
    const saved = await saveToTrilium(analysis, msgContent);
    const noteId = saved?.note?.noteId || "?";

    // 回复微信
    const categoryEmoji = {
      douyin: "📱", supply: "📦", ai: "🤖", product: "🎯", inbox: "📝"
    }[analysis.category] || "📝";

    const reply = [
      `✅ 已存入知识库 ${categoryEmoji}`,
      `📌 ${analysis.title}`,
      ``,
      analysis.summary,
      analysis.project && analysis.project !== "无" ? `🔗 关联：${analysis.project}` : "",
      analysis.action ? `👉 ${analysis.action}` : ""
    ].filter(Boolean).join("\n");

    return res.status(200).json({ reply, noteId });

  } catch (err) {
    console.error("ideas-capture error:", err);
    return res.status(200).json({ reply: "分析出错了，内容已收到，稍后手动整理" });
  }
}
