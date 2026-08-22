// api/db/freight-invoice-ocr.js
// Freight forwarder invoice PDF OCR -> finance_invoices_in.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { processDoc } from "./doc-textlayer.js";
import OSS from "ali-oss";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

const MAX_PAGES = 3;

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

function execFileP(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 30 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${err.message}${stderr ? " " + String(stderr).slice(0, 400) : ""}`;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanup(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

function objKeyFromUrl(url) {
  try { return new URL(url).pathname.replace(/^\/+/, ""); } catch (_) {}
  return String(url || "").replace(/^https?:\/\/[^/]+\//, "").replace(/^\/+/, "");
}

function pageImagePath(base, page) {
  for (const suffix of [`-${page}.jpg`, `-${String(page).padStart(2, "0")}.jpg`, `-${String(page).padStart(3, "0")}.jpg`]) {
    const p = base + suffix;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function pdfPageCount(pdfPath) {
  const { stdout } = await execFileP("pdfinfo", [pdfPath], { encoding: "utf8" });
  const m = String(stdout || "").match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error("pdfinfo could not determine page count");
  return Number(m[1]);
}

async function renderPages(pdfPath, tmpFiles) {
  const total = await pdfPageCount(pdfPath);
  const count = Math.min(total, MAX_PAGES);
  const images = [];
  for (let page = 1; page <= count; page++) {
    const base = path.join(os.tmpdir(), `freight_invoice_${process.pid}_${Date.now()}_${page}`);
    await execFileP("pdftoppm", ["-jpeg", "-r", "180", "-f", String(page), "-l", String(page), pdfPath, base]);
    const imgPath = pageImagePath(base, page);
    if (!imgPath) throw new Error(`pdftoppm output not found for page ${page}`);
    tmpFiles.push(imgPath);
    images.push({ page, bytes: fs.readFileSync(imgPath) });
  }
  return { images, total_pages: total, truncated: total > MAX_PAGES };
}

function s(v) {
  const out = v == null ? "" : String(v).trim();
  return out || null;
}

function num(v) {
  if (v == null || v === "") return null;
  const text = String(v).replace(/[,\s￥¥]/g, "");
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function safeDate(v) {
  const text = String(v || "").trim();
  const m = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function normalizeCurrency(v) {
  const text = String(v || "").trim().toUpperCase();
  if (!text) return null;
  if (/^(USD|US\$|美元|美金)$/.test(text)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(text)) return "CNY";
  return text.slice(0, 8);
}

function normalizeTaxRate(text) {
  const raw = String(text || "").trim();
  if (!raw) return { tax_rate: null, tax_exempt: false };
  if (raw.includes("免税")) return { tax_rate: 0, tax_exempt: true };
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (m) return { tax_rate: Number(m[1]) / 100, tax_exempt: false };
  const n = Number(raw);
  return Number.isFinite(n) ? { tax_rate: n > 1 ? n / 100 : n, tax_exempt: false } : { tax_rate: null, tax_exempt: false };
}

function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const one = String(v || "").trim();
    if (!one || seen.has(one)) continue;
    seen.add(one);
    out.push(one);
  }
  return out;
}

function normalizeBlNos(values) {
  const parts = Array.isArray(values)
    ? values.flatMap(v => String(v || "").split(/[|,，、/\s]+/))
    : String(values || "").split(/[|,，、/\s]+/);
  return orderedUnique(parts);
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(body); } catch (_) {}
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new Error("no valid JSON object in OCR reply");
}

const OCR_PROMPT = `请从这张中国发票中提取货代进项发票字段，只返回 valid JSON，不要 markdown，不要解释，不要编造；不确定或缺失一律返回 null。
重点处理备注栏：开户行和银行账号要逐字照抄，账号的 USD/RMB 前缀必须保留；"限美金/限USD/仅美元" 归一为 USD，"限人民币" 归一为 CNY；"应收USD15300" 抽币种 USD 和金额 15300；提单号支持 |、逗号、顿号、斜杠、空格、换行分隔，去重保序。税率栏原文可能是 "免税"、"***" 或百分数，按原文填 tax_rate_text。
{
  "invoice_no":"发票号码20位",
  "invoice_date":"YYYY-MM-DD",
  "invoice_type":"电子发票(普通发票)/增值税专用发票等",
  "seller_name":null,
  "seller_tax_id":null,
  "buyer_name":null,
  "buyer_tax_id":null,
  "goods_name":"项目名称",
  "amount_incl_tax":0,
  "amount_ex_tax":null,
  "total_tax":null,
  "tax_rate_text":"税率栏原文(免税/13%/***)",
  "check_code":null,
  "remark_raw":"备注栏全文逐字",
  "remark_parsed":{
    "payee_bank_name":"开户行全名",
    "payee_bank_account":"账号原文(USD/RMB前缀必须保留)",
    "payee_account_currency_hint":"从账号前缀或上下文推断USD/CNY,推不出null",
    "payment_currency_limit":"限美金/限USD/仅美元→USD;限人民币→CNY;没写→null",
    "receivable_fx_currency":"应收XXX中的币种,没写null",
    "receivable_fx_amount":"应收金额数字,没写null",
    "bl_nos":["提单号数组,支持 | ， 、 / 空格 换行 分隔,去重保序"]
  },
  "parse_confidence":0.0
}`;

async function ocrPage(imgBytes) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3",
      max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBytes.toString("base64") } },
        { type: "text", text: OCR_PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + bodyText.slice(0, 300));
  const body = JSON.parse(bodyText);
  return extractJsonObject((body.content || []).map(c => c.text || "").join("").trim());
}

function mergeParsed(pages) {
  const first = pages[0] || {};
  const out = { ...first, remark_parsed: { ...(first.remark_parsed || {}) } };
  for (const p of pages.slice(1)) {
    for (const k of ["invoice_no", "invoice_date", "invoice_type", "seller_name", "seller_tax_id", "buyer_name", "buyer_tax_id", "goods_name", "amount_incl_tax", "amount_ex_tax", "total_tax", "tax_rate_text", "check_code", "remark_raw"]) {
      if ((out[k] == null || out[k] === "") && p[k] != null && p[k] !== "") out[k] = p[k];
    }
    const rp = p.remark_parsed || {};
    for (const k of ["payee_bank_name", "payee_bank_account", "payee_account_currency_hint", "payment_currency_limit", "receivable_fx_currency", "receivable_fx_amount"]) {
      if ((out.remark_parsed[k] == null || out.remark_parsed[k] === "") && rp[k] != null && rp[k] !== "") out.remark_parsed[k] = rp[k];
    }
    out.remark_parsed.bl_nos = orderedUnique([...(out.remark_parsed.bl_nos || []), ...(rp.bl_nos || [])]);
    out.parse_confidence = Math.max(Number(out.parse_confidence) || 0, Number(p.parse_confidence) || 0);
  }
  return out;
}

function normalizeParsed(parsed) {
  const rp = parsed.remark_parsed || {};
  const tax = normalizeTaxRate(parsed.tax_rate_text);
  const payeeAccount = s(rp.payee_bank_account);
  const accountHint = normalizeCurrency(rp.payee_account_currency_hint)
    || (/^USD/i.test(payeeAccount || "") ? "USD" : /^RMB/i.test(payeeAccount || "") ? "CNY" : null);
  const out = {
    // Claude hardening (2026-07-31): strip ALL whitespace from invoice_no — a single OCR run
    // returning "2694 2000..." made findDuplicate miss an existing row (live-observed flake);
    // normalizing at parse time protects both storage and dedup comparison.
    invoice_no: s(String(parsed.invoice_no == null ? "" : parsed.invoice_no).replace(/\s+/g, "")),
    issue_date: safeDate(parsed.invoice_date),
    invoice_type: s(parsed.invoice_type),
    seller_name: s(parsed.seller_name),
    seller_tax_id: s(parsed.seller_tax_id),
    buyer_name: s(parsed.buyer_name),
    buyer_tax_id: s(parsed.buyer_tax_id),
    goods_name: s(parsed.goods_name),
    amount_incl_tax: num(parsed.amount_incl_tax),
    amount_ex_tax: num(parsed.amount_ex_tax),
    total_tax: num(parsed.total_tax),
    tax_rate_text: s(parsed.tax_rate_text),
    tax_rate: tax.tax_rate,
    check_code: s(parsed.check_code),
    remark_raw: s(parsed.remark_raw),
    remark_parsed: {
      payee_bank_name: s(rp.payee_bank_name),
      payee_bank_account: payeeAccount,
      payee_account_currency_hint: accountHint,
      payment_currency_limit: normalizeCurrency(rp.payment_currency_limit),
      receivable_fx_currency: normalizeCurrency(rp.receivable_fx_currency),
      receivable_fx_amount: num(rp.receivable_fx_amount),
      bl_nos: normalizeBlNos(rp.bl_nos),
    },
    parse_confidence: Math.max(0, Math.min(1, Number(parsed.parse_confidence) || 0)),
    raw_flags: { tax_exempt: tax.tax_exempt },
  };
  return out;
}

function reviewStatus(p) {
  return p.remark_parsed.payee_bank_account && p.amount_incl_tax != null && p.invoice_no && p.parse_confidence >= 0.7
    ? "parsed"
    : "parse_review";
}

function attachmentFor(doc) {
  return { doc_upload_id: doc.id, url: doc.url || null, name: doc.name || null };
}

function planFor(p) {
  return {
    invoice_no: p.invoice_no,
    invoice_type: p.invoice_type,
    issue_date: p.issue_date,
    seller_name: p.seller_name,
    seller_tax_id: p.seller_tax_id,
    buyer_name: p.buyer_name,
    buyer_tax_id: p.buyer_tax_id,
    goods_name: p.goods_name,
    amount_ex_tax: p.amount_ex_tax,
    total_tax: p.total_tax,
    amount_incl_tax: p.amount_incl_tax,
    tax_rate: p.tax_rate,
    tax_rate_text: p.tax_rate_text,
    currency: "CNY",
    check_code: p.check_code,
    remark: p.remark_raw,
    payee_bank_name: p.remark_parsed.payee_bank_name,
    payee_bank_account: p.remark_parsed.payee_bank_account,
    payee_account_currency_hint: p.remark_parsed.payee_account_currency_hint,
    payment_currency_limit: p.remark_parsed.payment_currency_limit,
    receivable_fx_currency: p.remark_parsed.receivable_fx_currency,
    receivable_fx_amount: p.remark_parsed.receivable_fx_amount,
    bl_nos: p.remark_parsed.bl_nos,
    parse_confidence: p.parse_confidence,
    critical_fields_confirmed: false,
    review_status: reviewStatus(p),
  };
}

async function getDoc(pool, input) {
  const q = input.doc_upload_id
    ? await pool.query("SELECT * FROM document_uploads WHERE id=$1 LIMIT 1", [input.doc_upload_id])
    : await pool.query("SELECT * FROM document_uploads WHERE doc_id=$1 ORDER BY id DESC LIMIT 1", [input.doc_id]);
  return q.rows[0] || null;
}

async function downloadPdf(doc, tmpFiles) {
  const obj = await ossClient().get(objKeyFromUrl(doc.url));
  const pdfPath = path.join(os.tmpdir(), `freight_invoice_${process.pid}_${doc.id}_${Date.now()}.pdf`);
  fs.writeFileSync(pdfPath, obj.content);
  tmpFiles.push(pdfPath);
  return pdfPath;
}

async function appendAttachment(client, invoiceId, doc) {
  await client.query(
    `UPDATE finance_invoices_in
        SET attachments = CASE
              WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(attachments, '[]'::jsonb)) a
                WHERE (a->>'doc_upload_id')::text = $2::text
              ) THEN COALESCE(attachments, '[]'::jsonb)
              ELSE COALESCE(attachments, '[]'::jsonb) || $3::jsonb
            END,
            updated_at = NOW()
      WHERE id=$1`,
    [invoiceId, String(doc.id), JSON.stringify([attachmentFor(doc)])]
  );
  await client.query(
    `UPDATE document_uploads
        SET ref_table='finance_invoices_in', ref_id=$1
      WHERE id=$2 AND ref_table IS NULL AND ref_id IS NULL`,
    [invoiceId, doc.id]
  );
}

async function findDuplicate(pool, p) {
  if (!p.invoice_no) return null;
  const q = await pool.query(
    `SELECT id FROM finance_invoices_in
      WHERE invoice_no=$1 AND (seller_tax_id=$2 OR seller_tax_id IS NULL)
      ORDER BY id ASC LIMIT 1`,
    [p.invoice_no, p.seller_tax_id]
  );
  return q.rows[0] || null;
}

async function extractInvoice(pool, input) {
  const doc = await getDoc(pool, input);
  if (!doc) {
    const err = new Error("document_upload not found");
    err.status = 404;
    throw err;
  }
  await processDoc(pool, { doc_upload_id: doc.id }).catch(() => null);

  const tmpFiles = [];
  try {
    const pdfPath = await downloadPdf(doc, tmpFiles);
    const rendered = await renderPages(pdfPath, tmpFiles);
    const pages = [];
    const errors = [];
    for (const img of rendered.images) {
      try {
        pages.push(await ocrPage(img.bytes));
      } catch (e) {
        errors.push({ page: img.page, error: e.message });
      }
    }
    if (!pages.length) throw new Error("all MiniMax page OCR attempts failed: " + errors.map(e => `p${e.page} ${e.error}`).join("; "));
    const invoiceParse = mergeParsed(pages);
    const parsed = normalizeParsed(invoiceParse);
    return { doc, parsed, invoice_parse: invoiceParse, ocr_meta: { total_pages: rendered.total_pages, pages_ocr_ok: pages.length, errors, truncated: rendered.truncated } };
  } finally {
    cleanup(tmpFiles);
  }
}

export async function runFreightInvoiceOcr(pool, input = {}) {
  const isConfirmed = input.confirmed === true || input.confirmed === "true" || input.confirmed === "1";
  const { doc, parsed, invoice_parse: invoiceParse, ocr_meta } = await extractInvoice(pool, input);
  const plan = planFor(parsed);
  const dup = await findDuplicate(pool, parsed);
  if (dup) {
    if (!isConfirmed) return { success: true, dry_run: true, duplicate: true, invoice_id: dup.id, parsed, plan, ocr_meta };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendAttachment(client, dup.id, doc);
      await client.query("COMMIT");
      return { success: true, dry_run: false, duplicate: true, invoice_id: dup.id, parsed, plan, ocr_meta };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  if (!isConfirmed) return { success: true, dry_run: true, parsed, plan, ocr_meta };

  const raw = {
    invoice_parse: invoiceParse,
    normalized: parsed,
    tax_exempt: parsed.raw_flags.tax_exempt,
    doc_upload_id: doc.id,
    engine: "minimax-m3",
    parsed_at: new Date().toISOString(),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = await client.query(
      `INSERT INTO finance_invoices_in
        (invoice_no, invoice_type, issue_date, seller_name, seller_tax_id, buyer_name, buyer_tax_id,
         amount_ex_tax, total_tax, amount_incl_tax, tax_rate, currency, remark, source, raw,
         check_code, line_items, attachments, review_status,
         payee_bank_name, payee_bank_account, payee_account_currency_hint, payment_currency_limit,
         receivable_fx_currency, receivable_fx_amount, bl_nos, parse_confidence, critical_fields_confirmed,
         created_at, updated_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CNY',$12,'freight-invoice-ocr',$13::jsonb,
         $14,$15::jsonb,$16::jsonb,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,false,NOW(),NOW())
       RETURNING id`,
      [
        parsed.invoice_no, parsed.invoice_type, parsed.issue_date, parsed.seller_name, parsed.seller_tax_id,
        parsed.buyer_name, parsed.buyer_tax_id, parsed.amount_ex_tax, parsed.total_tax, parsed.amount_incl_tax,
        parsed.tax_rate, parsed.remark_raw, JSON.stringify(raw), parsed.check_code,
        JSON.stringify(parsed.goods_name ? [{ goods_name: parsed.goods_name }] : []),
        JSON.stringify([attachmentFor(doc)]), reviewStatus(parsed),
        parsed.remark_parsed.payee_bank_name, parsed.remark_parsed.payee_bank_account,
        parsed.remark_parsed.payee_account_currency_hint, parsed.remark_parsed.payment_currency_limit,
        parsed.remark_parsed.receivable_fx_currency, parsed.remark_parsed.receivable_fx_amount,
        parsed.remark_parsed.bl_nos.length ? parsed.remark_parsed.bl_nos : null, parsed.parse_confidence,
      ]
    );
    const invoiceId = q.rows[0].id;
    await client.query(
      `UPDATE document_uploads
          SET ref_table='finance_invoices_in', ref_id=$1
        WHERE id=$2 AND ref_table IS NULL AND ref_id IS NULL`,
      [invoiceId, doc.id]
    );
    await client.query("COMMIT");
    return { success: true, dry_run: false, duplicate: false, invoice_id: invoiceId, parsed, plan, ocr_meta };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getInvoice(pool, invoiceId) {
  const q = await pool.query("SELECT * FROM finance_invoices_in WHERE id=$1 LIMIT 1", [invoiceId]);
  return q.rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const auth = requireAuth(req, res);
    if (auth === false || res.headersSent) return;
  } catch (e) {
    return res.status(e.status || 401).json({ success: false, error: e.message || "unauthorized" });
  }

  const pool = getPool();
  try {
    if (req.method === "GET") {
      const invoiceId = req.query?.invoice_id;
      if (!invoiceId) return res.status(400).json({ success: false, error: "invoice_id required" });
      const invoice = await getInvoice(pool, invoiceId);
      if (!invoice) return res.status(404).json({ success: false, error: "invoice not found" });
      return res.status(200).json({ success: true, invoice });
    }
    if (req.method !== "POST") return res.status(405).json({ success: false, error: "GET or POST only" });
    const body = req.body || {};
    if (!body.doc_upload_id && !body.doc_id) return res.status(400).json({ success: false, error: "doc_upload_id or doc_id required" });
    return res.status(200).json(await runFreightInvoiceOcr(pool, body));
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
