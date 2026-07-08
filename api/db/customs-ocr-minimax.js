// api/db/customs-ocr-minimax.js — 报关单扫描件 OCR (MiniMax M3)
// 报关单PDF/图 → pdftoppm转JPEG → MiniMax M3 → {customs_no, items[], cny_total, by_source{}}
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), "cust_" + Date.now());
    execFile("pdftoppm", ["-jpeg", "-r", "170", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      for (const c of [tmpBase + "-1.jpg", tmpBase + "-01.jpg", tmpBase + "-001.jpg"]) {
        if (fs.existsSync(c)) { const d = fs.readFileSync(c); fs.unlinkSync(c); return resolve(d); }
      }
      reject(new Error("pdftoppm: output not found"));
    });
  });
}

function mimeOf(fn) {
  const e = String(fn).toLowerCase().replace(/.*\./, "");
  return e === "png" ? "image/png" : e === "webp" ? "image/webp" : "image/jpeg";
}

const PROMPT = `这是中国海关出口货物报关单。仔细读表格,提取并返回JSON(只返回JSON,无markdown):
{"customs_no":"抬头的18位海关编号","items":[{"name":"商品名称","total":该项总价数字,"currency":"人民币或美元","source":"境内货源地(如徐州/连云港/烟台)"}],"cny_total":所有币制为人民币的项总价之和}
注意:总价是"单价/总价/币制"列里较大的那个数;cny_total只加人民币项。`;

// fileBytes: Buffer; filename; absPath: PDF在磁盘路径(PDF需要)
export async function ocrCustoms(fileBytes, filename, absPath) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  let imgBytes = fileBytes, media_type = mimeOf(filename);
  if (String(filename).toLowerCase().endsWith(".pdf") && absPath) {
    imgBytes = await pdfToJpeg(absPath); media_type = "image/jpeg";
  }
  const b64 = imgBytes.toString("base64");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3", max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type, data: b64 } },
        { type: "text", text: PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`MiniMax OCR HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
  const j = await resp.json();
  const raw = j.content?.[0]?.text || "";
  const clean = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(clean);
  // 按货源地汇总(人民币项)
  const bySource = {};
  for (const it of parsed.items || []) {
    if (String(it.currency || "").includes("人民币")) {
      const s = it.source || "未知";
      bySource[s] = (bySource[s] || 0) + Number(it.total || 0);
    }
  }
  return { customs_no: parsed.customs_no || null, items: parsed.items || [], cny_total: Number(parsed.cny_total) || 0, by_source: bySource, raw };
}
