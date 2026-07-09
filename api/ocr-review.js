// /api/ocr-review.js
// MiniMax-M3 视觉识别水单 + JDY write-back + PostgreSQL upsert
// 2026-07-04 引擎从 qwen-vl(阿里云DashScope,key丢失全站挂) 切到 MiniMax-M3(MINIMAX_API_KEY,已在用)
import { getPool } from "./db.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

// PDF(水单常是回单PDF) 首页转 jpeg 供视觉模型识别
async function pdfFirstPageToJpeg(pdfBytes) {
  const tmpPdf = path.join(os.tmpdir(), "slip_" + process.pid + "_" + Date.now() + ".pdf");
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const OCR_PROMPT = `你是银行单据识别专家。图片是一张银行回单/水单/凭证，可能是以下任一版式，请先判断版式(docType)与资金方向(direction)，再抽取字段。

【来账/收款类 → direction=收款】
· 国际结算贷记通知 / INTERNATION SETTLEMENT CREDIT ADVICE（境外汇入收汇）：收款人=我方，汇款人=客户。金额取"小写金额"，币种取"币种CCY"，日期取"日期/Transaction Date"，对方名称取"汇款人名称Remitter's Name"，附言取"汇款信息Remittance Information"。
· 利息收入回单（银行结息）：收款人=我方。金额取"金额"，对方名称可填"银行结息"。
· 其它收款回单/到账通知版式。
【往账/付款类 → direction=付款】
· 客户付费回单（银行扣手续费/账户维护费）：付款人=我方。对方名称填银行或"费用名称"。
· 国内支付业务付款回单（对外转账支出）：付款人=我方，收款人=对方。对方名称取"收款人名称"，附言取"用途"。
· 其它付款水单/转账支出凭证。

判断规则：标题含"贷记通知/利息/收汇/来账/入账/汇入"→收款；标题含"付款回单/付费/支付业务/往账/借记/转账支出/汇出"→付款。

严格只返回如下JSON，不要任何其他文字、解释或markdown：
{"docType":"单据标题原文或null","direction":"收款或付款或null","amount":金额数字(去掉千分位逗号)或null,"currency":"币种代码如CNY/USD/MYR或null","paymentDate":"YYYY-MM-DD格式或null","bankRef":"交易流水号(优先),否则回单编号或业务编号或null","senderName":"对方名称(收款时=汇款人,付款时=收款人)或null","remittanceInfo":"汇款信息/用途附言或null"}`;

// MiniMax-M3 视觉识别：下载OSS→(PDF转jpeg)→base64→api.minimaxi.com。返回 OpenAI 形状供 parseQwenResponse 复用。
async function callQwenVL(ossUrl) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const dl = await fetch(ossUrl);
  if (!dl.ok) throw new Error("下载OSS失败 HTTP " + dl.status);
  let bytes = Buffer.from(await dl.arrayBuffer());
  let mediaType = "image/jpeg";
  const isPdf = bytes.slice(0, 5).toString("latin1") === "%PDF-" || /\.pdf(\?|$)/i.test(ossUrl);
  if (isPdf) {
    bytes = await pdfFirstPageToJpeg(bytes);
  } else if (bytes.slice(1, 4).toString("latin1") === "PNG") {
    mediaType = "image/png";
  }
  const b64 = bytes.toString("base64");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3", max_tokens: 1024,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text: OCR_PROMPT },
      ]}],
    }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200));
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("").trim();
  return { choices: [{ message: { content: text } }] };
}

function parseQwenResponse(data) {
  try {
    const text = data?.choices?.[0]?.message?.content || "";
    console.log("[ocr-review] qwen raw text:", text.slice(0, 300));
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn("[ocr-review] parse error:", e.message);
    return null;
  }
}

async function updateJDY(jdyId, fields) {
  const res = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/update", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.JDY_TOKEN || "jgAipmndimpj0endT0wStd6gpspAQpAd"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: "689cb08a93c073210bfc772b",
      entry_id: "694a4c10c530d677dc4ca0ef",
      data_id: jdyId,
      data: fields,
    }),
  });
  return res.json();
}

// ── Resolve fund direction (收款/付款) from doc type ──
// 修复：旧逻辑写死 direction='收款'，付款单被错记成收款。
function resolveDirection(fields) {
  const t = String(fields?.docType || "");
  // 单据标题是最强信号
  if (/贷记通知|credit\s*advice|利息|结息|收汇|来账|入账|汇入|收款回单|到账/i.test(t)) return "收款";
  if (/付款回单|付费|支付业务|往账|借记|转账支出|汇出|扣款/i.test(t)) return "付款";
  // 退而求其次：信任模型给出的 direction
  if (fields?.direction === "付款") return "付款";
  if (fields?.direction === "收款") return "收款";
  // 兜底：保持历史行为（客户汇入货款＝收款）
  return "收款";
}

// 金额可能是 "3,921.00" 之类带千分位的字符串，写入 numeric 列前必须清洗成数字
function toAmountNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── AI Audit for payment record ──
function auditPayment(fields) {
  const issues = [];
  if (!fields.currency)     issues.push("缺币种");
  if (!fields.paymentDate)  issues.push("缺付款日期");
  if (!fields.amount)       issues.push("缺本次金额");
  if (!fields.bankRef)      issues.push("缺银行参考号");
  if (!fields.senderName)   issues.push("缺付款方名称");
  if (issues.length === 0)  return { status: "ok", issues: [] };
  if (!fields.amount || !fields.currency) return { status: "error", issues };
  return { status: "warn", issues };
}

// ── Upsert extracted data into finance_payments ──
async function upsertPaymentRecord(jdyId, ocrFields) {
  const pool = getPool();
  const audit = auditPayment(ocrFields);
  const direction = resolveDirection(ocrFields);
  const amount = toAmountNumber(ocrFields.amount);
  // Use jdy_id if available, otherwise generate a unique id from timestamp
  const id = jdyId ? `jdy_${jdyId}` : `ocr_${Date.now()}`;

  const result = await pool.query(`
    INSERT INTO finance_payments(
      _id, jdy_id, type, direction,
      this_amount, currency, payment_date, bank_ref,
      customer_cn, status,
      audit_issues, audit_status,
      raw, created_at, updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW(),NOW())
    ON CONFLICT(_id) DO UPDATE SET
      this_amount  = COALESCE(EXCLUDED.this_amount,  finance_payments.this_amount),
      currency     = COALESCE(EXCLUDED.currency,     finance_payments.currency),
      payment_date = COALESCE(EXCLUDED.payment_date, finance_payments.payment_date),
      bank_ref     = COALESCE(EXCLUDED.bank_ref,     finance_payments.bank_ref),
      customer_cn  = COALESCE(EXCLUDED.customer_cn,  finance_payments.customer_cn),
      audit_issues = EXCLUDED.audit_issues,
      audit_status = EXCLUDED.audit_status,
      updated_at   = NOW()
    RETURNING *
  `, [
    id,
    jdyId || null,
    'OCR扫描',
    direction,
    amount,
    ocrFields.currency   || null,
    ocrFields.paymentDate|| null,
    ocrFields.bankRef    || null,
    ocrFields.senderName || null,
    'ocr_pending',
    JSON.stringify(audit.issues),
    audit.status,
    JSON.stringify({ ocrSource: true, direction, docType: ocrFields.docType || null, remittanceInfo: ocrFields.remittanceInfo || null, rawOcr: ocrFields }),
  ]);
  return result.rows[0];
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { ossUrl, jdyId, saveToDb } = req.body;
    if (!ossUrl) return res.status(400).json({ success: false, error: "Missing ossUrl" });

    // 1. OCR via Qwen VL
    const qwenData = await callQwenVL(ossUrl);
    console.log("[ocr-review] qwen response:", JSON.stringify(qwenData).slice(0, 400));

    const fields = parseQwenResponse(qwenData);
    // 归一化方向，回给前端展示（收款/付款）
    if (fields) fields.direction = resolveDirection(fields);
    console.log("[ocr-review] extracted:", JSON.stringify(fields));

    // 2. Write back to JDY (existing behavior — bankRef + currency)
    let jdyUpdated = false;
    if (jdyId && fields) {
      const jdyFields = {};
      if (fields.bankRef)  jdyFields._widget_1773601903113 = { value: fields.bankRef };
      if (fields.currency) jdyFields._widget_1773601903097 = { value: fields.currency };
      if (Object.keys(jdyFields).length > 0) {
        const r = await updateJDY(jdyId, jdyFields);
        console.log("[ocr-review] JDY update:", JSON.stringify(r));
        jdyUpdated = true;
      }
    }

    // 3. Save to PostgreSQL finance_payments (when saveToDb=true)
    let savedRecord = null;
    if (saveToDb && fields) {
      savedRecord = await upsertPaymentRecord(jdyId, fields);
      console.log("[ocr-review] DB saved:", savedRecord?._id);
    }

    return res.status(200).json({ success: true, fields, jdyUpdated, savedRecord });

  } catch (err) {
    console.error("[ocr-review] error:", err);
    return res.status(500).json({ success: false, error: err.message || "OCR failed" });
  }
}
