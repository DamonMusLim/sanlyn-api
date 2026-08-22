// api/db/payment-batch.js
// Payment batch draft/approval and generic bank transfer instruction Excel.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import ExcelJS from "exceljs";
import OSS from "ali-oss";

const DEFAULT_PAYER = "OCEANBABY";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  const n = Number(String(v).replace(/[,\s￥¥]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeCurrency(v) {
  const value = text(v).toUpperCase();
  if (!value) return null;
  if (/^(USD|US\$|美元|美金)$/.test(value)) return "USD";
  if (/^(CNY|RMB|人民币)$/.test(value)) return "CNY";
  return value.slice(0, 8);
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
  const parts = Array.isArray(values)
    ? values.flatMap(v => text(v).split(/[|,，、/\s]+/))
    : text(values).split(/[|,，、/\s]+/);
  return orderedUnique(parts);
}

function invoiceIds(input) {
  const ids = Array.isArray(input) ? input : [];
  const out = orderedUnique(ids.map(v => String(v)));
  if (!out.length || out.some(id => !/^\d+$/.test(id))) {
    const err = new Error("invoice_ids_required");
    err.status = 400;
    throw err;
  }
  return out;
}

function authUser(req, auth) {
  return auth && typeof auth === "object" ? auth : (req.user || req.auth || req.session?.user || {});
}

function rolesOf(user) {
  const roles = [];
  for (const key of ["role", "user_role", "account_role"]) {
    if (user && user[key]) roles.push(user[key]);
  }
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  if (Array.isArray(user?.permissions)) roles.push(...user.permissions);
  return roles.map(v => text(v).toLowerCase()).filter(Boolean);
}

function canReview(user) {
  if (user?.is_admin === true || user?.admin === true) return true;
  return rolesOf(user).some(r => r === "admin" || r === "finance" || r === "finance_admin" || r === "accounting");
}

function actorName(user) {
  return s(user?.username) || s(user?.name) || s(user?.email) || s(user?.id) || "system";
}

function payCurrency(invoice, audit) {
  return normalizeCurrency(audit?.pay_currency)
    || normalizeCurrency(invoice.payment_currency_limit)
    || normalizeCurrency(invoice.receivable_fx_currency)
    || normalizeCurrency(invoice.currency)
    || "CNY";
}

function payableAmount(invoice, currency) {
  return currency === "USD" ? money(invoice.receivable_fx_amount) : money(invoice.amount_incl_tax);
}

function memoFor(invoice) {
  const bl = normalizeBlNos(invoice.bl_nos).join(",");
  return `发票${invoice.invoice_no || ""} BL:${bl}`;
}

async function getInvoices(pool, ids, forUpdate = false) {
  const q = await pool.query(
    `SELECT * FROM finance_invoices_in
      WHERE id = ANY($1::bigint[])
      ORDER BY id ASC
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [ids]
  );
  const found = new Map(q.rows.map(row => [String(row.id), row]));
  return ids.map(id => found.get(String(id)) || { id, missing: true });
}

async function latestAudits(pool, ids) {
  const q = await pool.query(
    `SELECT DISTINCT ON (invoice_id) *
       FROM finance_invoice_match_audits
      WHERE invoice_id = ANY($1::bigint[])
      ORDER BY invoice_id, checked_at DESC, id DESC`,
    [ids]
  );
  return new Map(q.rows.map(row => [String(row.invoice_id), row]));
}

async function previewInvoices(pool, ids, options = {}) {
  const invoices = await getInvoices(pool, ids, options.forUpdate === true);
  const audits = await latestAudits(pool, ids);
  const eligible = [];
  const blocked = [];
  const currencies = [];

  for (const invoice of invoices) {
    const reasons = [];
    if (invoice.missing) {
      blocked.push({ invoice_id: Number(invoice.id), reasons: ["invoice_not_found"] });
      continue;
    }
    const audit = audits.get(String(invoice.id));
    const currency = payCurrency(invoice, audit);
    const limit = normalizeCurrency(invoice.payment_currency_limit);
    const receivableCurrency = normalizeCurrency(invoice.receivable_fx_currency);
    const amount = payableAmount(invoice, currency);

    if (!audit) reasons.push("无匹配审计，请先执行match");
    if (audit?.status === "gap") reasons.push(invoice.payment_ready_block_reason || "发票与账单存在差异");
    if (invoice.critical_fields_confirmed !== true) reasons.push("关键字段尚未确认");
    if (limit && limit !== currency) reasons.push(`付款限币种${limit}与审计实付币种${currency}冲突`);
    if (limit && receivableCurrency && limit !== receivableCurrency) reasons.push(`付款限币种${limit}与应收币种${receivableCurrency}冲突`);
    if (!s(invoice.seller_name)) reasons.push("缺收款户名");
    if (!s(invoice.payee_bank_account)) reasons.push("缺收款银行账号");
    if (amount == null || amount <= 0) reasons.push("缺有效实付金额");

    if (reasons.length) {
      blocked.push({ invoice_id: Number(invoice.id), reasons });
      continue;
    }
    currencies.push(currency);
    eligible.push({
      invoice_id: invoice.id,
      payee_name: s(invoice.seller_name),
      payee_bank_name: s(invoice.payee_bank_name),
      payee_account_no: s(invoice.payee_bank_account),
      currency,
      amount,
      memo: memoFor(invoice),
      supplier_invoice_no: s(invoice.invoice_no),
    });
  }

  const currenciesSeen = orderedUnique(currencies);
  return {
    success: true,
    eligible,
    blocked,
    currencies_seen: currenciesSeen,
    mixed_currency: currenciesSeen.length > 1,
  };
}

async function nextBatchNo(client) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const q = await client.query(
    `SELECT batch_no FROM finance_payment_batches
      WHERE batch_no LIKE $1
      ORDER BY batch_no DESC
      LIMIT 1`,
    [`PB${day}%`]
  );
  const last = q.rows[0]?.batch_no || "";
  const seq = (Number(last.slice(-3)) || 0) + 1;
  return `PB${day}${String(seq).padStart(3, "0")}`;
}

async function createBatch(pool, body, user) {
  const ids = invoiceIds(body.invoice_ids);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const preview = await previewInvoices(client, ids, { forUpdate: true });
    if (preview.blocked.length || preview.mixed_currency) {
      await client.query("ROLLBACK");
      return { success: false, error: preview.mixed_currency ? "mixed_currency" : "invoice_not_ready", ...preview };
    }
    const items = preview.eligible;
    const currency = items[0].currency;
    const total = money(items.reduce((sum, item) => sum + item.amount, 0));
    const batchNo = await nextBatchNo(client);
    const batchQ = await client.query(
      `INSERT INTO finance_payment_batches
        (batch_no,payer_company_code,payer_bank_name,payer_account_no,currency,total_amount,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
       RETURNING *`,
      [batchNo, s(body.payer_company_code) || DEFAULT_PAYER, s(body.payer_bank_name), s(body.payer_account_no), currency, total, actorName(user)]
    );
    const batch = batchQ.rows[0];
    const inserted = [];
    for (const item of items) {
      const q = await client.query(
        `INSERT INTO finance_payment_batch_items
          (batch_id,invoice_id,payee_name,payee_bank_name,payee_account_no,currency,amount,memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [batch.id, item.invoice_id, item.payee_name, item.payee_bank_name, item.payee_account_no, item.currency, item.amount, item.memo]
      );
      inserted.push(q.rows[0]);
    }
    await client.query(
      `UPDATE finance_invoices_in
          SET review_status='payment_sheet', updated_at=NOW()
        WHERE id = ANY($1::bigint[]) AND review_status='matched'`,
      [ids]
    );
    await client.query("COMMIT");
    return { success: true, batch, items: inserted };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

async function uploadToOSS(buffer, batchNo) {
  const key = `finance/payment-batches/${batchNo}.xlsx`;
  await ossClient().put(key, Buffer.from(buffer), { headers: { "Content-Type": XLSX_TYPE } });
  return `https://files.sanlynos.com/${key}`;
}

async function loadBatch(pool, batchId) {
  if (!batchId || !/^\d+$/.test(String(batchId))) {
    const err = new Error("batch_id_required");
    err.status = 400;
    throw err;
  }
  const batchQ = await pool.query("SELECT * FROM finance_payment_batches WHERE id=$1 LIMIT 1", [batchId]);
  if (!batchQ.rows[0]) {
    const err = new Error("batch_not_found");
    err.status = 404;
    throw err;
  }
  const itemsQ = await pool.query(
    `SELECT i.*, f.invoice_no AS supplier_invoice_no
       FROM finance_payment_batch_items i
       LEFT JOIN finance_invoices_in f ON f.id=i.invoice_id
      WHERE i.batch_id=$1
      ORDER BY i.id ASC`,
    [batchId]
  );
  return { batch: batchQ.rows[0], items: itemsQ.rows };
}

function styleSheet(ws) {
  ws.columns = [
    { width: 8 }, { width: 28 }, { width: 34 }, { width: 30 },
    { width: 10 }, { width: 16 }, { width: 42 }, { width: 24 },
  ];
  ws.getColumn(4).numFmt = "@";
  ws.getColumn(6).numFmt = "#,##0.00";
  ws.getColumn(6).alignment = { horizontal: "right" };
  for (const row of [1, 2, 3, 5]) {
    ws.getRow(row).font = { bold: true };
  }
  ws.getRow(5).alignment = { vertical: "middle", horizontal: "center" };
}

async function buildExcel(batch, items) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "sanlyn-api";
  workbook.created = new Date();
  const ws = workbook.addWorksheet("付款指令");
  ws.addRow([`付款主体: ${batch.payer_company_code || ""}`]);
  ws.addRow([`批次号: ${batch.batch_no}`]);
  ws.addRow([`生成日期: ${new Date().toISOString().slice(0, 10)}`]);
  ws.addRow(["⚠️付款前请人工核对每笔收款账号"]);
  ws.addRow(["序号", "收款户名", "收款开户行", "收款账号", "币种", "金额", "附言(发票号+BL)", "供应商发票号"]);
  items.forEach((item, index) => {
    ws.addRow([
      index + 1,
      item.payee_name,
      item.payee_bank_name,
      String(item.payee_account_no || ""),
      item.currency,
      Number(item.amount),
      item.memo,
      item.supplier_invoice_no || "",
    ]);
  });
  ws.addRow([]);
  ws.addRow(["合计", "", "", "", batch.currency, Number(batch.total_amount), `笔数:${items.length}`]);
  styleSheet(ws);
  return workbook.xlsx.writeBuffer();
}

async function confirmBatch(pool, body, user) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockQ = await client.query(
      "SELECT * FROM finance_payment_batches WHERE id=$1 FOR UPDATE",
      [body.batch_id]
    );
    const batch = lockQ.rows[0];
    if (!batch) {
      await client.query("ROLLBACK");
      return { success: false, error: "batch_not_found" };
    }
    if (batch.status !== "draft") {
      await client.query("ROLLBACK");
      return { success: false, error: "batch_not_draft", batch };
    }
    const itemsQ = await client.query(
      `SELECT i.*, f.invoice_no AS supplier_invoice_no
         FROM finance_payment_batch_items i
         LEFT JOIN finance_invoices_in f ON f.id=i.invoice_id
        WHERE i.batch_id=$1
        ORDER BY i.id ASC`,
      [batch.id]
    );
    const buffer = await buildExcel(batch, itemsQ.rows);
    const excelUrl = await uploadToOSS(buffer, batch.batch_no);
    const updatedQ = await client.query(
      `UPDATE finance_payment_batches
          SET status='ready', approved_by=$2, approved_at=NOW(), excel_url=$3
        WHERE id=$1
        RETURNING *`,
      [batch.id, actorName(user), excelUrl]
    );
    await client.query("COMMIT");
    return { success: true, batch: updatedQ.rows[0], items: itemsQ.rows, excel_url: excelUrl };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listBatches(pool, status) {
  const params = [];
  const where = status ? "WHERE status=$1" : "";
  if (status) params.push(status);
  const q = await pool.query(
    `SELECT * FROM finance_payment_batches ${where} ORDER BY created_at DESC, id DESC LIMIT 200`,
    params
  );
  return { success: true, batches: q.rows };
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
      if (req.query?.action === "list") return send(res, 200, await listBatches(pool, s(req.query?.status)));
      const details = await loadBatch(pool, req.query?.batch_id);
      return send(res, 200, { success: true, ...details });
    }
    if (req.method !== "POST") return send(res, 405, { success: false, error: "method_not_allowed" });
    const body = req.body || {};
    if (body.action === "preview") return send(res, 200, await previewInvoices(pool, invoiceIds(body.invoice_ids)));
    if (body.action === "create") return send(res, 200, await createBatch(pool, body, user));
    if (body.action === "confirm") return send(res, 200, await confirmBatch(pool, body, user));
    return send(res, 400, { success: false, error: "unknown_action" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
