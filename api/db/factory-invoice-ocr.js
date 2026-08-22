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

/** 发票号归一：去空格/连字符、全角数字转半角、统一大写。⛔ 只做无损归一，不补位不截断。 */
export function normalizeInvoiceNo(v) {
  let s = String(v ?? "").trim();
  if (!s) return "";
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角数字
  s = s.replace(/[\s\-\u2010-\u2015_]/g, "");                                            // 空格/各种连字符
  return s.toUpperCase();
}

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
  /* 🔴 0817 实测修正三处（用大之圣 26322000006688361311 那张票验的）：
       ① 买卖方被认反了：seller 认成「厦门巴比进出口有限公司」(那是购买方)、buyer 认成大之圣(那是销售方)
          → 误报 seller_mismatch。发票版式是【左＝购买方，右＝销售方】，必须写死告诉模型。
       ② line_items 根本没让它抽 → 品名一行都没存 → 品名压根没核对（Damon：品名一定要开对）
       ③ tax_rate 返 null → 明确说从税率列取、写成 0.13 这种小数
       另：「巴匕」常被 OCR 成「巴比」，靠税号兜底判主体，别只比名字。 */
  const prompt = `请从这张中国增值税发票图片中提取字段，只返回合法 JSON，不要 markdown，不要编造。
未知文本用空字符串，未知数字用 null。

版式要点（务必遵守）：
- 发票抬头下方有左右两个框：**左边框是「购买方信息」→ buyer_*；右边框是「销售方信息」→ seller_***。不要弄反。
- 中间表格每一行是一个货物明细，项目名称形如「*大类*品名」（如 *宠物用品*宠物用纺织制品），
  请把**完整原文**放进 name（保留星号前缀），不要改写、不要省略。
- 单位/数量/单价/金额/税率/税额 按该行原样取；税率写成小数（13% → 0.13）。
- 「价税合计（小写）」= amount_incl_tax；「合计」行的金额列 = amount_ex_tax、税额列 = total_tax。

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
  "tax_rate": null,
  "line_items": [
    { "name": "", "spec": "", "unit": "", "qty": null, "unit_price": null, "amount": null, "tax_rate": null, "tax_amount": null }
  ]
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
      // 0817 forge #5：归一后再存/比对，否则「同一票号不同写法」仍能绕过唯一索引
      invoice_no: normalizeInvoiceNo(parsed.invoice_no),
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
      // 0817 新增：明细行（品名核对靠它，之前一直是空数组）
      line_items: Array.isArray(parsed.line_items)
        ? parsed.line_items.map((l) => ({
            name: String(l?.name || "").trim(),
            spec: String(l?.spec || "").trim(),
            unit: String(l?.unit || "").trim(),
            qty: num2(l?.qty),
            unit_price: num2(l?.unit_price),
            amount: num2(l?.amount),
            tax_rate: l?.tax_rate === null || l?.tax_rate === undefined || l?.tax_rate === ""
              ? null
              : Number(l.tax_rate) > 1 ? Number(l.tax_rate) / 100 : Number(l.tax_rate),
            tax_amount: num2(l?.tax_amount),
          })).filter((l) => l.name || l.amount !== null)
        : [],
    },
  };
}

/** 发票品名去掉税局大类前缀：`*宠物用品*宠物用纺织制品` → `宠物用纺织制品` */
export function stripGoodsPrefix(name) {
  return String(name || "").replace(/^\s*\*[^*]*\*/, "").trim();
}
