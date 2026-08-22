// api/db/invoice-bill-match.js
// Match freight invoices to supplier bill rows by BL + supplier, then audit gaps.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const EPS = 0.01;
const OCR_SOURCE = "freight-invoice-ocr";

function s(v) {
  const out = v == null ? "" : String(v).trim();
  return out || null;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeCurrency(v) {
  const text = String(v || "").trim().toUpperCase();
  if (!text) return null;
  if (/^(USD|US\$|美元|美金)$/.test(text)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(text)) return "CNY";
  return text.slice(0, 8);
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
  if (Array.isArray(values)) return orderedUnique(values);
  return orderedUnique(String(values || "").split(/[|,，、/\s]+/));
}

function normalizeCompany(name) {
  const exact = String(name || "")
    .replace(/[（）]/g, m => (m === "（" ? "(" : ")"))
    .replace(/\s+/g, "")
    .trim();
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
  if (x.exact === y.exact) return true;
  return x.core.length >= 2 && y.core.length >= 2 && (x.core.includes(y.core) || y.core.includes(x.core));
}

function payCurrency(invoice) {
  return normalizeCurrency(invoice.payment_currency_limit)
    || normalizeCurrency(invoice.receivable_fx_currency)
    || normalizeCurrency(invoice.currency)
    || "CNY";
}

function payableAmount(invoice, currency = payCurrency(invoice)) {
  return currency === "CNY" ? money(invoice.amount_incl_tax) : money(invoice.receivable_fx_amount);
}

function assertInvoiceId(id) {
  if (!id || !/^\d+$/.test(String(id))) {
    const err = new Error("invoice_id required");
    err.status = 400;
    throw err;
  }
}

async function getInvoice(pool, invoiceId) {
  const q = await pool.query("SELECT * FROM finance_invoices_in WHERE id=$1 LIMIT 1", [invoiceId]);
  return q.rows[0] || null;
}

async function candidateBills(pool, blNos) {
  if (!blNos.length) return [];
  const q = await pool.query(
    `SELECT *
       FROM freight_supplier_bills
      WHERE bl_no = ANY($1::text[])
      ORDER BY id ASC`,
    [blNos]
  );
  return q.rows;
}

async function findSiblings(pool, invoice) {
  const blNos = normalizeBlNos(invoice.bl_nos);
  if (!blNos.length) return [invoice];
  const q = await pool.query(
    `SELECT *
       FROM finance_invoices_in
      WHERE source=$1
        AND bl_nos && $2::text[]
      ORDER BY id ASC`,
    [OCR_SOURCE, blNos]
  );
  const currency = payCurrency(invoice);
  return q.rows.filter(row => payCurrency(row) === currency && companyMatches(row.seller_name, invoice.seller_name));
}

function billBreakdown(blNos, allSupplierBills, payCurrencyValue) {
  return blNos.map(bl => {
    const rows = allSupplierBills.filter(b => b.bl_no === bl);
    const sameCurrency = rows.filter(b => normalizeCurrency(b.currency) === payCurrencyValue);
    const amount = money(sameCurrency.reduce((sum, b) => sum + money(b.amount), 0));
    return { bl_no: bl, present: rows.length > 0, amount, currency: payCurrencyValue, bill_ids: sameCurrency.map(b => b.id) };
  });
}

function reasonText({ status, payCurrencyValue, groupInvoiceAmount, matchedBillAmount, diffAmount, missingBlNos }) {
  const missing = missingBlNos.length ? missingBlNos.join(", ") : "无";
  if (status === "matched") return null;
  return `${payCurrencyValue}组发票合计${groupInvoiceAmount} vs 账单${matchedBillAmount} 差${diffAmount}；缺BL:${missing}`;
}

async function writeLinks(client, invoiceId, bills) {
  let count = 0;
  for (const bill of bills) {
    const q = await client.query(
      `INSERT INTO finance_invoice_bill_links (invoice_id, bill_id, bl_no, match_method)
       VALUES ($1,$2,$3,'bl+supplier')
       ON CONFLICT (invoice_id, bill_id) DO NOTHING
       RETURNING id`,
      [invoiceId, bill.id, bill.bl_no]
    );
    count += q.rowCount;
  }
  return count;
}

async function auditNoBl(pool, invoice) {
  const currency = payCurrency(invoice);
  const amount = payableAmount(invoice, currency);
  const reasons = { no_bl_nos: true };
  const q = await pool.query(
    `INSERT INTO finance_invoice_match_audits
      (invoice_id,status,pay_currency,invoice_amount,group_invoice_amount,matched_bill_amount,diff_amount,
       missing_bl_nos,matched_bl_nos,blocking_reasons)
     VALUES ($1,'gap',$2,$3,$3,0,$3,ARRAY[]::text[],ARRAY[]::text[],$4::jsonb)
     RETURNING *`,
    [invoice.id, currency, amount, JSON.stringify(reasons)]
  );
  await pool.query(
    `UPDATE finance_invoices_in
        SET review_status='gap',
            payment_ready_block_reason='缺提单号，无法匹配货代账单',
            updated_at=NOW()
      WHERE id=$1 AND review_status IN ('parsed','matched','gap')`,
    [invoice.id]
  );
  return { success: true, status: "gap", audit: q.rows[0], links_count: 0, sibling_invoice_ids: [invoice.id] };
}

export async function runMatch(pool, invoiceId) { // exported so brief3 confirm can auto-rematch after corrections (Claude fix 0731)
  assertInvoiceId(invoiceId);
  const invoice = await getInvoice(pool, invoiceId);
  if (!invoice) {
    const err = new Error("invoice not found");
    err.status = 404;
    throw err;
  }
  const ownBlNos = normalizeBlNos(invoice.bl_nos);
  if (!ownBlNos.length) return auditNoBl(pool, invoice);

  const payCurrencyValue = payCurrency(invoice);
  const siblings = await findSiblings(pool, invoice);
  const siblingIds = siblings.map(row => row.id);
  const groupBlNos = orderedUnique(siblings.flatMap(row => normalizeBlNos(row.bl_nos)));
  const allBills = await candidateBills(pool, groupBlNos);
  const supplierBills = allBills.filter(bill => companyMatches(bill.supplier, invoice.seller_name));
  const sameCurrencyBills = supplierBills.filter(bill => normalizeCurrency(bill.currency) === payCurrencyValue);
  const ownSameCurrencyBills = sameCurrencyBills.filter(bill => ownBlNos.includes(bill.bl_no));
  const missingBlNos = groupBlNos.filter(bl => !supplierBills.some(bill => bill.bl_no === bl));
  const matchedBlNos = orderedUnique(sameCurrencyBills.map(bill => bill.bl_no));
  const groupInvoiceAmount = money(siblings.reduce((sum, row) => sum + payableAmount(row, payCurrencyValue), 0));
  const matchedBillAmount = money(sameCurrencyBills.reduce((sum, bill) => sum + money(bill.amount), 0));
  const diffAmount = money(groupInvoiceAmount - matchedBillAmount);
  const status = Math.abs(diffAmount) <= EPS && missingBlNos.length === 0 ? "matched" : "gap";
  const blockingReasons = {
    missing_bl_nos: missingBlNos,
    amount_diff: Math.abs(diffAmount) > EPS ? diffAmount : 0,
    supplier_match: supplierBills.length > 0 ? "matched" : "none",
    group_bl_nos: groupBlNos,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linksCount = await writeLinks(client, invoice.id, ownSameCurrencyBills);
    const auditQ = await client.query(
      `INSERT INTO finance_invoice_match_audits
        (invoice_id,status,pay_currency,invoice_amount,group_invoice_amount,matched_bill_amount,diff_amount,
         missing_bl_nos,matched_bl_nos,blocking_reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10::jsonb)
       RETURNING *`,
      [
        invoice.id, status, payCurrencyValue, payableAmount(invoice, payCurrencyValue),
        groupInvoiceAmount, matchedBillAmount, diffAmount, missingBlNos, matchedBlNos,
        JSON.stringify(blockingReasons),
      ]
    );
    const blockReason = reasonText({ status, payCurrencyValue, groupInvoiceAmount, matchedBillAmount, diffAmount, missingBlNos });
    await client.query(
      `UPDATE finance_invoices_in
          SET review_status=$2,
              payment_ready_block_reason=$3,
              updated_at=NOW()
        WHERE id=$1 AND review_status IN ('parsed','matched','gap')`,
      [invoice.id, status, blockReason]
    );
    await client.query("COMMIT");
    return { success: true, status, audit: auditQ.rows[0], links_count: linksCount, sibling_invoice_ids: siblingIds };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function latestAudit(pool, invoiceId) {
  const q = await pool.query(
    `SELECT * FROM finance_invoice_match_audits
      WHERE invoice_id=$1
      ORDER BY checked_at DESC, id DESC
      LIMIT 1`,
    [invoiceId]
  );
  return q.rows[0] || null;
}

async function readiness(pool, invoiceId) {
  assertInvoiceId(invoiceId);
  const invoice = await getInvoice(pool, invoiceId);
  if (!invoice) {
    const err = new Error("invoice not found");
    err.status = 404;
    throw err;
  }
  const audit = await latestAudit(pool, invoiceId);
  const effective = audit?.pay_currency || payCurrency(invoice);
  const limit = normalizeCurrency(invoice.payment_currency_limit);
  const receivableCurrency = normalizeCurrency(invoice.receivable_fx_currency);
  const reasons = [];
  if (!audit) reasons.push("无匹配审计，请先执行match");
  if (audit?.status === "gap") reasons.push(invoice.payment_ready_block_reason || "发票与账单存在差异");
  if (invoice.critical_fields_confirmed === false) reasons.push("关键字段尚未确认");
  if (limit && limit !== effective) reasons.push(`付款限币种${limit}与审计实付币种${effective}冲突`);
  if (limit && receivableCurrency && limit !== receivableCurrency) reasons.push(`付款限币种${limit}与应收币种${receivableCurrency}冲突`);
  if (!s(invoice.payee_bank_account)) reasons.push("缺收款银行账号");
  return { success: true, can_generate_payment: reasons.length === 0, reasons, invoice, audit };
}

async function getDetails(pool, invoiceId) {
  assertInvoiceId(invoiceId);
  const invoice = await getInvoice(pool, invoiceId);
  if (!invoice) {
    const err = new Error("invoice not found");
    err.status = 404;
    throw err;
  }
  const audit = await latestAudit(pool, invoiceId);
  const linksQ = await pool.query(
    `SELECT l.*, b.supplier, b.bl_no AS bill_bl_no, b.cost_category, b.amount, b.currency, b.qty, b.unit_price, b.ap_status
       FROM finance_invoice_bill_links l
       JOIN freight_supplier_bills b ON b.id = l.bill_id::uuid -- bills.id是uuid,links.bill_id存text(Claude fix 0731)
      WHERE l.invoice_id=$1
      ORDER BY b.bl_no, b.id`,
    [invoiceId]
  );
  return { success: true, invoice, audit, links: linksQ.rows };
}

function formatAmount(currency, amount) {
  return `${currency || ""} ${money(amount).toFixed(2)}`.trim();
}

async function chaseDraft(pool, invoiceId) {
  const details = await getDetails(pool, invoiceId);
  const { invoice, audit } = details;
  const currency = audit?.pay_currency || payCurrency(invoice);
  const blNos = normalizeBlNos(invoice.bl_nos);
  const bills = (await candidateBills(pool, blNos)).filter(bill => companyMatches(bill.supplier, invoice.seller_name));
  const lines = billBreakdown(blNos, bills, currency).map(row => {
    const status = row.present ? `有，${formatAmount(currency, row.amount)}` : "无";
    return `${row.bl_no}: ${status}`;
  });
  const matchedNote = audit?.status === "matched" ? "目前系统审计为已匹配，本邮件仅作复核草稿。" : "";
  const diff = audit ? `金额差异: 发票组${formatAmount(currency, audit.group_invoice_amount)}，账单${formatAmount(currency, audit.matched_bill_amount)}，差额${formatAmount(currency, audit.diff_amount)}。` : "金额差异: 暂无审计记录。";
  const body = [
    `致 ${invoice.seller_name || "贵司"}：`,
    `我司核对贵司发票${invoice.invoice_no || ""}(金额${formatAmount(currency, audit?.invoice_amount || payableAmount(invoice, currency))})与提单 ${blNos.join(", ")} 的账单，发现如下情况：`,
    diff,
    "提单账单明细:",
    ...lines,
    "请补充对应账单或说明差异。",
    matchedNote,
    "--上海洋宝宝国际物流有限公司",
  ].filter(Boolean).join("\n");
  return {
    success: true,
    status: audit?.status || null,
    to: null,
    subject: `【对账】贵司发票${invoice.invoice_no || ""}与我方账单差异核对`,
    body,
  };
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
      return res.status(200).json(await getDetails(pool, invoiceId));
    }
    if (req.method !== "POST") return res.status(405).json({ success: false, error: "GET or POST only" });
    const body = req.body || {};
    const action = body.action || "match";
    if (action === "readiness") return res.status(200).json(await readiness(pool, body.invoice_id));
    if (action === "chase-draft") return res.status(200).json(await chaseDraft(pool, body.invoice_id));
    if (action !== "match") return res.status(400).json({ success: false, error: "unknown action" });
    return res.status(200).json(await runMatch(pool, body.invoice_id));
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
