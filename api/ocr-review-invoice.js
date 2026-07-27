// /api/ocr-review-invoice.js
// 发票/账单 OCR 提取：只返回结构化字段，不写库。

import { callQwenVL, parseQwenResponse } from "./ocr-review.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const INVOICE_PROMPT = `你是发票和物流账单识别专家。图片/PDF是一张电子发票、账单或费用单，正文或备注里可能混有提单号、柜号、银行账号、金额和公司名称。

任务：
1. 提取发票号码、销售方名称、购买方名称、价税合计金额和币种。
2. 从备注/正文提取所有提单号/BILL号，可能有多个。
3. 从备注/正文提取所有柜号，柜号通常是4位字母加7位或更多数字，如 COAU7269765850、OOLU2329707640。
4. 银行账号、税号、电话、日期、发票代码不是提单号也不是柜号；不要把纯数字账号识别成提单号。
5. 备注里写人民币发票但另有USD换算说明时，currency 可填 USD；普通人民币发票填 CNY。

严格只返回如下JSON，不要任何其他文字、解释或markdown：
{"invoiceNo":"发票号码或null","sellerName":"销售方名称或null","buyerName":"购买方名称或null","amount":价税合计小写金额数字或null,"currency":"币种代码,人民币填CNY,备注里写USD换算的填USD或null","blNos":["备注/正文里出现的所有提单号/BILL号，可能有多个，逐个提取，找不到给空数组"],"containerNos":["备注/正文里出现的所有柜号(形如4位字母+7位或更多数字)，可能有多个，找不到给空数组"]}`;

function cleanString(v) {
  return v == null ? "" : String(v).trim();
}

function toAmountNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const s = cleanString(v).toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export async function extractInvoiceFields(ossUrl) {
  const qwenData = await callQwenVL(ossUrl, INVOICE_PROMPT);
  console.log("[ocr-review-invoice] qwen response:", JSON.stringify(qwenData).slice(0, 400));

  const parsed = parseQwenResponse(qwenData) || {};
  const fields = {
    invoiceNo: cleanString(parsed.invoiceNo) || null,
    sellerName: cleanString(parsed.sellerName) || null,
    buyerName: cleanString(parsed.buyerName) || null,
    amount: toAmountNumber(parsed.amount),
    currency: cleanString(parsed.currency).toUpperCase() || null,
    blNos: uniqStrings(parsed.blNos),
    containerNos: uniqStrings(parsed.containerNos),
  };
  console.log("[ocr-review-invoice] extracted:", JSON.stringify(fields));
  return fields;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { ossUrl } = req.body || {};
    if (!ossUrl) return res.status(400).json({ success: false, error: "Missing ossUrl" });
    const fields = await extractInvoiceFields(ossUrl);
    return res.status(200).json({ success: true, fields });
  } catch (err) {
    console.error("[ocr-review-invoice] error:", err);
    return res.status(500).json({ success: false, error: err.message || "OCR failed" });
  }
}
