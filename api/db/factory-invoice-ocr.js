// api/db/factory-invoice-ocr.js
// 工厂进项票 OCR 相关函数（从 factory-portal.js 抽出，遵守单文件 ≤500 行铁律）。
//   - 字段清洗：num2 / safeDate
//   - 媒体处理：mediaTypeOf / pdfToJpeg / imageBytesForOcr
//   - 文本解析：extractJsonObject
//   - 主入口：ocrInvoice（调 MiniMax-M3，鉴权用 Authorization: Bearer）
// extOf / randomId 复用 factory-portal-utils.js（单一真源，不再各拷一份）。

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { extOf, randomId } from "./factory-portal-utils.js";

export function num2(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

export function safeDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  if (Number.isNaN(d.getTime())) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function mediaTypeOf(file) {
  const mt = String(file?.mime || "").toLowerCase();
  if (mt === "image/jpg") return "image/jpeg";
  if (mt.startsWith("image/")) return mt;
  const ext = extOf(file?.fileName);
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), `factory_invoice_${Date.now()}_${randomId()}`);
    execFile("/usr/bin/pdftoppm", ["-jpeg", "-r", "160", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error(`pdftoppm failed: ${err.message}`));
      const candidates = [`${tmpBase}-1.jpg`, `${tmpBase}-01.jpg`, `${tmpBase}-001.jpg`];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          const data = fs.readFileSync(c);
          fs.unlinkSync(c);
          return resolve(data);
        }
      }
      reject(new Error("pdftoppm output file not found"));
    });
  });
}

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(body); } catch (_) {}
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new Error("OCR JSON parse failed");
}

export async function imageBytesForOcr(file) {
  const isPdf = file.mime === "application/pdf" || extOf(file.fileName) === ".pdf";
  if (!isPdf) return { bytes: file.buffer, mediaType: mediaTypeOf(file) };
  const pdfPath = path.join(os.tmpdir(), `factory_invoice_${Date.now()}_${randomId()}.pdf`);
  fs.writeFileSync(pdfPath, file.buffer);
  try {
    return { bytes: await pdfToJpeg(pdfPath), mediaType: "image/jpeg" };
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
  }
}

export async function ocrInvoice(file) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const image = await imageBytesForOcr(file);
  const prompt = `请从这张中国增值税发票中提取字段，只返回合法 JSON，不要 markdown，不要编造。未知文本用空字符串，未知数字用 null：
{
  "invoice_no": "",
  "invoice_code": "",
  "issue_date": "YYYY-MM-DD",
  "seller_name": "",
  "seller_tax_id": "",
  "buyer_name": "",
  "buyer_tax_id": "",
  "amount_ex_tax": null,
  "total_tax": null,
  "amount_incl_tax": null,
  "tax_rate": null
}`;
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify({
      model: "MiniMax-M3",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`MiniMax OCR HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
  const body = JSON.parse(bodyText);
  const rawText = Array.isArray(body.content)
    ? body.content.map((b) => b?.text || "").join("\n").trim()
    : "";
  const parsed = extractJsonObject(rawText);
  return {
    rawText,
    parsed: {
      invoice_no: String(parsed.invoice_no || "").trim(),
      invoice_code: String(parsed.invoice_code || "").trim(),
      issue_date: safeDate(parsed.issue_date),
      seller_name: String(parsed.seller_name || "").trim(),
      seller_tax_id: String(parsed.seller_tax_id || "").trim(),
      buyer_name: String(parsed.buyer_name || "").trim(),
      buyer_tax_id: String(parsed.buyer_tax_id || "").trim(),
      amount_ex_tax: num2(parsed.amount_ex_tax),
      total_tax: num2(parsed.total_tax),
      amount_incl_tax: num2(parsed.amount_incl_tax),
      tax_rate: parsed.tax_rate === null || parsed.tax_rate === undefined || parsed.tax_rate === ""
        ? null
        : Number(parsed.tax_rate) > 1 ? Number(parsed.tax_rate) / 100 : Number(parsed.tax_rate),
    },
  };
}
