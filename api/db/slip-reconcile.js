// api/db/slip-reconcile.js
// Payment bank slip OCR -> manual match -> confirmed AP reconciliation.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { processDoc } from "./doc-textlayer.js";
import fs from "fs";
import path from "path";

const EPS = 0.01;
const MODEL = "MiniMax-M3";

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function s(v) {
  const out = text(v);
  return out || null;
}

function money(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,\s￥¥$]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeCurrency(v) {
  const value = text(v).toUpperCase();
  if (!value) return null;
  if (/^(USD|US\$|美元|美金)$/.test(value)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(value)) return "CNY";
  return value.slice(0, 8);
}

function safeDate(v) {
  if (!v) return null;
  // pg returns DATE/timestamp columns as JS Date objects; String(dateObj) => "Fri Jul 31 2026..."
  // whose slice(0,10) is garbage. Always derive YYYY-MM-DD from the Date itself (Claude fix 0731,
  // live-caught on reconcile). Prefer local calendar date to avoid UTC day-shift on date-only values.
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (typeof v === "string") { const m = v.match(/^\d{4}-\d{2}-\d{2}/); if (m) return m[0]; }
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, "0"), da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function centsEqual(a, b) {
  return Math.abs((money(a) || 0) - (money(b) || 0)) <= EPS;
}

function normalizeAccount(v) {
  return text(v).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function accountMatches(a, b) {
  const x = normalizeAccount(a);
  const y = normalizeAccount(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.length >= 4 && y.length >= 4 && x.slice(-4) === y.slice(-4);
}

function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const one = text(v);
    if (!one || seen.has(one)) continue;
    seen.add(one);
    out.push(one);
  }
  return out;
}

function normalizeBlNos(values) {
  if (Array.isArray(values)) return orderedUnique(values.flatMap(v => text(v).split(/[|,，、/\s]+/)));
  return orderedUnique(text(values).split(/[|,，、/\s]+/));
}

function normalizeCompany(name) {
  const exact = text(name).replace(/[（）]/g, m => (m === "（" ? "(" : ")")).replace(/\s+/g, "");
  const core = exact
    .replace(/\([^)]*\)/g, "")
    .replace(/有限责任公司|股份有限公司|有限公司|集团|国际物流|物流|货运代理|货代|供应链|贸易|公司/g, "")
    .replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "")
    .toLowerCase();
  return { exact, core };
}

function companyMatches(a, b) {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x.exact || !y.exact) return false;
  return x.exact === y.exact || (x.core.length >= 2 && y.core.length >= 2 && (x.core.includes(y.core) || y.core.includes(x.core)));
}

function payCurrency(invoice) {
  return normalizeCurrency(invoice.payment_currency_limit) || normalizeCurrency(invoice.receivable_fx_currency) || normalizeCurrency(invoice.currency) || "CNY";
}

function payableAmount(invoice, currency = payCurrency(invoice)) {
  return currency === "CNY" ? money(invoice.amount_incl_tax) : money(invoice.receivable_fx_amount);
}

function authUser(req, auth) {
  return auth && typeof auth === "object" ? auth : (req.user || req.auth || req.session?.user || {});
}

function rolesOf(user) {
  const roles = [];
  for (const key of ["role", "user_role", "account_role"]) if (user?.[key]) roles.push(user[key]);
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  if (Array.isArray(user?.permissions)) roles.push(...user.permissions);
  return roles.map(v => text(v).toLowerCase()).filter(Boolean);
}

function canReview(user) {
  if (user?.is_admin === true || user?.admin === true) return true;
  return rolesOf(user).some(r => ["admin", "finance", "finance_admin", "accounting"].includes(r));
}

function actorName(user) {
  return s(user?.username) || s(user?.name) || s(user?.email) || s(user?.id) || "system";
}

function tokensFromRemark(remark) {
  const raw = text(remark).match(/[A-Za-z]{1,8}[-_]?\d[A-Za-z0-9._/-]{1,40}|\d{6,30}/g) || [];
  return orderedUnique(raw.map(v => v.replace(/[，,;；。:：)）\]]+$/g, ""))).slice(0, 80);
}

function slipRemark(slip) {
  return [slip.remark_details, slip.beneficiary_reference, slip.raw?.remark, slip.raw?.extracted?.remark].filter(Boolean).join(" ");
}

function mismatchesForSlipInvoice(slip, invoice) {
  const out = [];
  const cur = payCurrency(invoice);
  const amt = payableAmount(invoice, cur);
  if (normalizeCurrency(slip.currency) !== cur) out.push("currency");
  if (!centsEqual(slip.amount, amt)) out.push("amount");
  if (slip.beneficiary_account_masked && invoice.payee_bank_account && !accountMatches(slip.beneficiary_account_masked, invoice.payee_bank_account)) out.push("account");
  return out;
}

async function minimaxExtract(content) {
  if (!process.env.MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY not set");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.MINIMAX_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content }],
    }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const txt = (await resp.json()).content?.map(c => c.text || "").join("").trim() || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("MiniMax returned no JSON");
  return JSON.parse(m[0]);
}

async function extractFromText(rawText) {
  return minimaxExtract([{ type: "text", text: [
    "从银行付款水单文字中抽取字段，只返回JSON，不要解释。字段:",
    "payment_date,sender_name,sender_account,beneficiary_name,beneficiary_account,currency,amount,txn_ref,remark,bank_source,beneficiary_bank,sender_bank。",
    "金额用数字，日期YYYY-MM-DD，缺失为null。",
    rawText || "",
  ].join("\n") }]);
}

async function extractFromFileUrl(fileUrl) {
  const isHttp = /^https?:\/\//i.test(fileUrl);
  const bytes = isHttp ? Buffer.from(await (await fetch(fileUrl)).arrayBuffer()) : fs.readFileSync(path.resolve(fileUrl));
  const media = /\.png(\?|$)/i.test(fileUrl) ? "image/png" : /\.jpe?g(\?|$)/i.test(fileUrl) ? "image/jpeg" : "application/pdf";
  return minimaxExtract([
    { type: media === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: media, data: bytes.toString("base64") } },
    { type: "text", text: "抽取付款水单字段，只返回JSON: payment_date,sender_name,sender_account,beneficiary_name,beneficiary_account,currency,amount,txn_ref,remark,bank_source,beneficiary_bank,sender_bank。缺失为null。" },
  ]);
}

async function getDocUrl(pool, docUploadId) {
  const q = await pool.query("SELECT id, url FROM document_uploads WHERE id=$1 LIMIT 1", [docUploadId]);
  return q.rows[0]?.url || null;
}

async function runOcr(pool, body, user) {
  if (!body.doc_upload_id && !body.file_url) {
    const err = new Error("doc_upload_id_or_file_url_required");
    err.status = 400;
    throw err;
  }
  let parsed, rawText = "";
  let fileUrl = s(body.file_url);
  if (body.doc_upload_id) {
    const textlayer = await processDoc(pool, { doc_upload_id: body.doc_upload_id });
    rawText = textlayer?.textlayer?.text || "";
    fileUrl = fileUrl || await getDocUrl(pool, body.doc_upload_id);
    parsed = rawText ? await extractFromText(rawText) : await extractFromFileUrl(fileUrl);
  } else {
    parsed = await extractFromFileUrl(fileUrl);
  }

  const amount = money(parsed.amount);
  const paymentDate = safeDate(parsed.payment_date);
  if (amount == null) throw Object.assign(new Error("amount_missing_or_invalid"), { status: 400 });
  if (!paymentDate) throw Object.assign(new Error("payment_date_missing_or_invalid"), { status: 400 });
  const raw = { ocr_model: MODEL, ocr_raw_text: rawText, extracted: parsed, doc_upload_id: body.doc_upload_id || null, file_url: fileUrl };
  const q = await pool.query(
    `INSERT INTO bank_slips
      (bank_source, txn_ref, sender_name, sender_bank, beneficiary_name, beneficiary_bank,
       beneficiary_account_masked, amount, currency, remark_details, beneficiary_reference,
       payment_date, file_url, status, raw, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'parsed',$14::jsonb,$15)
     RETURNING *`,
    [
      s(parsed.bank_source), s(parsed.txn_ref), s(parsed.sender_name), s(parsed.sender_bank),
      s(parsed.beneficiary_name), s(parsed.beneficiary_bank), s(parsed.beneficiary_account),
      amount, normalizeCurrency(parsed.currency), s(parsed.remark), s(parsed.beneficiary_reference),
      paymentDate, fileUrl, JSON.stringify(raw), actorName(user),
    ]
  );
  return { success: true, slip_id: q.rows[0].id, parsed: q.rows[0] };
}

async function getSlip(pool, slipId, forUpdate = false) {
  if (!slipId || !/^\d+$/.test(String(slipId))) throw Object.assign(new Error("slip_id_required"), { status: 400 });
  const q = await pool.query(`SELECT * FROM bank_slips WHERE id=$1 LIMIT 1 ${forUpdate ? "FOR UPDATE" : ""}`, [slipId]);
  if (!q.rows[0]) throw Object.assign(new Error("slip_not_found"), { status: 404 });
  return q.rows[0];
}

async function matchByBatch(pool, slip, tokens) {
  const pb = tokens.filter(t => /^PB[-_]?\d|^PB[A-Z0-9]/i.test(t)).map(t => t.toUpperCase());
  if (!pb.length) return null;
  const q = await pool.query("SELECT * FROM finance_payment_batches WHERE upper(batch_no)=ANY($1::text[]) ORDER BY id DESC LIMIT 1", [pb]);
  if (!q.rows[0]) return null;
  const items = await pool.query(
    `SELECT i.*, f.invoice_no, f.payee_bank_account, f.amount_incl_tax, f.receivable_fx_amount,
            f.payment_currency_limit, f.receivable_fx_currency, f.bl_nos, f.seller_name, f.review_status
       FROM finance_payment_batch_items i
       LEFT JOIN finance_invoices_in f ON f.id=i.invoice_id
      WHERE i.batch_id=$1 ORDER BY i.id`,
    [q.rows[0].id]
  );
  const total = money(items.rows.reduce((sum, r) => sum + (money(r.amount) || 0), 0));
  const mismatches = [];
  if (!centsEqual(total, slip.amount)) mismatches.push("amount");
  if (normalizeCurrency(q.rows[0].currency) !== normalizeCurrency(slip.currency)) mismatches.push("currency");
  return { matched_batch_id: q.rows[0].id, matched_invoice_ids: items.rows.map(r => r.invoice_id).filter(Boolean), batch: q.rows[0], items: items.rows, match_method: "remark_batch_no", confidence: mismatches.length ? 0.75 : 0.98, mismatches };
}

async function matchByInvoiceNo(pool, slip, tokens) {
  if (!tokens.length) return null;
  const q = await pool.query("SELECT * FROM finance_invoices_in WHERE invoice_no=ANY($1::text[]) ORDER BY id", [tokens]);
  if (!q.rows.length) return null;
  const mismatches = orderedUnique(q.rows.flatMap(r => mismatchesForSlipInvoice(slip, r)));
  return { matched_invoice_ids: q.rows.map(r => r.id), invoices: q.rows, match_method: "remark_invoice_no", confidence: mismatches.length ? 0.8 : 0.96, mismatches };
}

async function matchByAccountAmount(pool, slip) {
  const cur = normalizeCurrency(slip.currency);
  const amount = money(slip.amount);
  if (!cur || amount == null || !s(slip.beneficiary_account_masked)) return null;
  const q = await pool.query(
    `SELECT *
       FROM finance_invoices_in
      WHERE (COALESCE(payment_currency_limit, receivable_fx_currency, 'CNY') ILIKE $1)
        AND (ABS(COALESCE(CASE WHEN COALESCE(payment_currency_limit, receivable_fx_currency, 'CNY') ILIKE 'CNY'
                               THEN amount_incl_tax ELSE receivable_fx_amount END,0) - $2) <= $3)
      ORDER BY id DESC LIMIT 50`,
    [cur, amount, EPS]
  );
  const matched = q.rows.filter(r => accountMatches(slip.beneficiary_account_masked, r.payee_bank_account));
  if (!matched.length) return null;
  return { matched_invoice_ids: matched.map(r => r.id), invoices: matched, match_method: "account_amount_currency", confidence: matched.length === 1 ? 0.93 : 0.86, mismatches: [] };
}

export async function runMatch(pool, slipId) {
  const slip = await getSlip(pool, slipId);
  const tokens = tokensFromRemark(slipRemark(slip));
  const result = await matchByBatch(pool, slip, tokens) || await matchByInvoiceNo(pool, slip, tokens) || await matchByAccountAmount(pool, slip);
  if (!result) {
    await pool.query("UPDATE bank_slips SET raw=COALESCE(raw,'{}'::jsonb)||$1::jsonb WHERE id=$2", [JSON.stringify({ last_match: { status: "unmatched", at: new Date().toISOString() } }), slip.id]);
    return { success: true, status: "unmatched", matched_invoice_ids: [], match_method: null, confidence: 0, mismatches: ["no_match"] };
  }
  await pool.query("UPDATE bank_slips SET raw=COALESCE(raw,'{}'::jsonb)||$1::jsonb WHERE id=$2", [JSON.stringify({ last_match: result }), slip.id]);
  return { success: true, status: result.mismatches?.length ? "mismatch" : "matched", ...result };
}

async function loadTargetInvoices(client, body) {
  if (body.batch_id) {
    const items = await client.query(
      `SELECT i.id AS item_id, i.batch_id, i.invoice_id, i.amount AS item_amount,
              i.currency AS item_currency, i.status AS item_status, f.*
         FROM finance_payment_batch_items i
         JOIN finance_invoices_in f ON f.id=i.invoice_id
        WHERE i.batch_id=$1
        ORDER BY i.id FOR UPDATE OF i, f`,
      [body.batch_id]
    );
    return { invoices: items.rows, items: items.rows };
  }
  const ids = orderedUnique(body.invoice_ids).filter(v => /^\d+$/.test(String(v))).map(Number);
  if (!ids.length) throw Object.assign(new Error("invoice_ids_or_batch_id_required"), { status: 400 });
  const q = await client.query("SELECT * FROM finance_invoices_in WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
  if (q.rows.length !== ids.length) throw Object.assign(new Error("some_invoices_not_found"), { status: 404 });
  return { invoices: q.rows, items: [] };
}

async function updateBills(client, invoices, slipDate) {
  const blNos = orderedUnique(invoices.flatMap(i => normalizeBlNos(i.bl_nos)));
  if (!blNos.length) return { updated_bill_ids: [] };
  const bills = await client.query("SELECT * FROM freight_supplier_bills WHERE bl_no=ANY($1::text[]) AND ap_status='unpaid' FOR UPDATE", [blNos]);
  const ids = [];
  for (const bill of bills.rows) {
    const inv = invoices.find(i => normalizeCurrency(bill.currency) === payCurrency(i) && normalizeBlNos(i.bl_nos).includes(bill.bl_no) && companyMatches(bill.supplier, i.seller_name));
    if (!inv) continue;
    ids.push(bill.id);
    await client.query(
      `UPDATE freight_supplier_bills
          SET ap_status='paid', ap_paid_amount=$2, ap_paid_at=$3, reconciled=true
        WHERE id=$1 AND ap_status='unpaid'`,
      [bill.id, money(bill.amount), slipDate]
    );
  }
  return { updated_bill_ids: ids };
}

async function runReconcile(pool, body, user) {
  if (body.confirm !== true) throw Object.assign(new Error("confirm_true_required"), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slip = await getSlip(client, body.slip_id, true);
    const { invoices, items } = await loadTargetInvoices(client, body);
    const cur = normalizeCurrency(slip.currency);
    const allocations = invoices.map(inv => {
      const item = items.find(i => String(i.invoice_id) === String(inv.id));
      return { invoice: inv, amount: money(item?.item_amount) ?? payableAmount(inv, cur), currency: normalizeCurrency(item?.item_currency) || payCurrency(inv) };
    });
    const total = money(allocations.reduce((sum, a) => sum + (money(a.amount) || 0), 0));
    const currencies = orderedUnique(allocations.map(a => a.currency));
    const mismatches = [];
    if (!centsEqual(total, slip.amount)) mismatches.push({ field: "amount", slip_amount: money(slip.amount), target_amount: total });
    if (currencies.length !== 1 || currencies[0] !== cur) mismatches.push({ field: "currency", slip_currency: cur, target_currencies: currencies });
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return { success: false, error: "payment_mismatch", mismatches };
    }
    for (const a of allocations) {
      await client.query(
        `UPDATE finance_invoices_in
            SET bank_payment_date=$2, bank_payment_amount=$3, bank_payment_memo=$4, bank_txn_ref=$5,
                review_status=CASE WHEN review_status IN ('matched','payment_sheet') THEN 'paid' ELSE review_status END,
                updated_at=NOW()
          WHERE id=$1`,
        [a.invoice.id, safeDate(slip.payment_date), a.amount, slipRemark(slip) || body.batch_no || null, s(slip.txn_ref) || s(slip.bank_reference_no)]
      );
    }
    const billResult = await updateBills(client, invoices, safeDate(slip.payment_date));
    let batchStatus = null;
    if (body.batch_id) {
      await client.query(
        "UPDATE finance_payment_batch_items SET status='paid', paid_slip_id=$2, paid_at=$3 WHERE batch_id=$1",
        [body.batch_id, slip.id, safeDate(slip.payment_date)]
      );
      const bq = await client.query(
        `UPDATE finance_payment_batches b
            SET status=CASE WHEN NOT EXISTS (SELECT 1 FROM finance_payment_batch_items i WHERE i.batch_id=b.id AND COALESCE(i.status,'')<>'paid') THEN 'paid' ELSE b.status END
          WHERE b.id=$1 RETURNING status`,
        [body.batch_id]
      );
      batchStatus = bq.rows[0]?.status || null;
    }
    await client.query(
      `UPDATE bank_slips
          SET status='reconciled', confirmed_by=$2, confirmed_at=NOW(),
              raw=COALESCE(raw,'{}'::jsonb)||$3::jsonb
        WHERE id=$1`,
      [slip.id, actorName(user), JSON.stringify({ reconciled: { invoice_ids: invoices.map(i => i.id), batch_id: body.batch_id || null, at: new Date().toISOString() } })]
    );
    await client.query("COMMIT");
    return { success: true, slip_id: slip.id, invoice_ids: invoices.map(i => i.id), allocations: allocations.map(a => ({ invoice_id: a.invoice.id, amount: a.amount, currency: a.currency })), bills: billResult, batch_status: batchStatus };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function exceptions(pool) {
  const q = await pool.query(
    `SELECT id, txn_ref, beneficiary_name, beneficiary_account_masked, amount, currency, payment_date,
            remark_details, beneficiary_reference, status, raw->'last_match' AS last_match, created_at
       FROM bank_slips
      WHERE status='parsed' OR (status IS DISTINCT FROM 'reconciled' AND COALESCE(raw->'last_match'->>'status','') IN ('unmatched','mismatch'))
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 200`
  );
  return { success: true, exceptions: q.rows };
}

async function details(pool, slipId) {
  const slip = await getSlip(pool, slipId);
  return { success: true, slip, match: slip.raw?.last_match || null };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  let auth = null;
  try {
    auth = requireAuth(req, res);
    if (auth === false || res.headersSent) return;
  } catch (e) {
    return send(res, e.status || 401, { success: false, error: e.message || "unauthorized" });
  }
  const user = authUser(req, auth);
  if (!canReview(user)) return send(res, 403, { success: false, error: "finance_or_admin_required" });
  const pool = getPool();
  try {
    if (req.method === "GET") {
      if (req.query?.action === "exceptions") return send(res, 200, await exceptions(pool));
      return send(res, 200, await details(pool, req.query?.slip_id));
    }
    if (req.method !== "POST") return send(res, 405, { success: false, error: "method_not_allowed" });
    const body = req.body || {};
    if (body.action === "ocr") return send(res, 200, await runOcr(pool, body, user));
    if (body.action === "match") return send(res, 200, await runMatch(pool, body.slip_id));
    if (body.action === "reconcile") return send(res, 200, await runReconcile(pool, body, user));
    return send(res, 400, { success: false, error: "unknown_action" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
