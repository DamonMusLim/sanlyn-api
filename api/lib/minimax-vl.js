// api/lib/minimax-vl.js — 统一 MiniMax-M3 视觉/文本调用，替代阿里云 qwen(DashScope)
// 返回 OpenAI 兼容形状 {choices:[{message:{content}}]}，各端点原解析逻辑不动。
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

const MM_URL = "https://api.minimaxi.com/anthropic/v1/messages";
const MODEL = "MiniMax-M3";

async function pdfFirstPageToJpeg(pdfBytes) {
  const tmpPdf = path.join(os.tmpdir(), "mm_" + process.pid + "_" + Date.now() + ".pdf");
  fs.writeFileSync(tmpPdf, pdfBytes);
  const tmpBase = tmpPdf.replace(/\.pdf$/, "");
  await new Promise((resolve, reject) => {
    execFile("pdftoppm", ["-jpeg", "-r", "160", "-f", "1", "-l", "1", tmpPdf, tmpBase], (err) => err ? reject(new Error("pdftoppm failed: " + err.message)) : resolve());
  });
  let jpg = null;
  for (const c of [tmpBase + "-1.jpg", tmpBase + "-01.jpg", tmpBase + "-001.jpg"]) {
    if (fs.existsSync(c)) { jpg = fs.readFileSync(c); try { fs.unlinkSync(c); } catch {} break; }
  }
  try { fs.unlinkSync(tmpPdf); } catch {}
  if (!jpg) throw new Error("pdftoppm: output not found");
  return jpg;
}

function wrap(text) { return { choices: [{ message: { content: text } }] }; }

async function mmCall(content) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const resp = await fetch(MM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content }] }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200));
  const j = await resp.json();
  return (j.content || []).map(c => c.text || "").join("").trim();
}

// 视觉识别：图片URL / PDF URL / data:base64 URL + 提示词。返回 OpenAI 形状。
export async function visionOcr(imageUrl, prompt) {
  let bytes, mediaType = "image/jpeg";
  if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
    const m = imageUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) throw new Error("非法 data URL");
    mediaType = m[1] || "image/jpeg";
    bytes = Buffer.from(m[2], "base64");
  } else {
    const dl = await fetch(imageUrl);
    if (!dl.ok) throw new Error("下载图片失败 HTTP " + dl.status);
    bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.slice(1, 4).toString("latin1") === "PNG") mediaType = "image/png";
  }
  const isPdf = bytes.slice(0, 5).toString("latin1") === "%PDF-" || (typeof imageUrl === "string" && /\.pdf(\?|$)/i.test(imageUrl));
  if (isPdf) { bytes = await pdfFirstPageToJpeg(bytes); mediaType = "image/jpeg"; }
  const b64 = bytes.toString("base64");
  const text = await mmCall([
    { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
    { type: "text", text: prompt },
  ]);
  return wrap(text);
}

// 纯文本：system+user。返回 OpenAI 形状。
export async function textChat(systemPrompt, userPrompt) {
  const text = await mmCall([{ type: "text", text: (systemPrompt ? systemPrompt + "\n\n" : "") + userPrompt }]);
  return wrap(text);
}
