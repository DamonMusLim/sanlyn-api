// api/db/rebate-doc-upload.js — 退税资料补料(进项票/采购合同/收汇)
// 从已撤 collab-closure.js 搬来的三个上传handler,协同中枢退税资料组用。
// POST ?action=upload_invoice|upload_contract|upload_slip  (JSON base64 或 multipart)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { readUploadPayload, validateFile, uploadToOss } from "./factory-invoice-upload.js";

export const config = { api: { bodyParser: false } };

function json(res, code, body) { return res.status(code).json(body); }

// 工厂code:优先合同号,回退按报关号查订单
async function factoryCodeFor(pool, { contractNo, customsNo }) {
  if (contractNo) {
    const r = await pool.query(`SELECT factory_code FROM orders WHERE contract_no=$1 AND factory_code IS NOT NULL LIMIT 1`, [contractNo]);
    if (r.rows[0]?.factory_code) return r.rows[0].factory_code;
  }
  if (customsNo) {
    const r = await pool.query(
      `SELECT o.factory_code FROM finance_export_rebates fer JOIN orders o ON o.contract_no=fer.contract_no AND o.factory_code IS NOT NULL WHERE fer.customs_no=$1 LIMIT 1`, [customsNo]);
    return r.rows[0]?.factory_code || null;
  }
  return null;
}

async function handleUploadInvoice(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file); if (err) return json(res, 400, { error: err });
  const customsNo = (fields.customs_no || "").trim();
  if (!customsNo) return json(res, 400, { error: "customs_no required" });
  const oss = await uploadToOss(customsNo, "INVOICE", file);
  const invoiceNo = (fields.invoice_no || "").trim() || `MANUAL_${Date.now()}`;
  const amount = fields.amount ? parseFloat(String(fields.amount).replace(/[^\d.]/g, "")) : null;
  await pool.query(
    `INSERT INTO finance_invoices_in (invoice_no, issue_date, customs_nos, seller_name, amount_incl_tax, attachments, source, created_at, updated_at)
     SELECT $1, $2::date, ARRAY[$3::varchar], $4, $5, $6::jsonb, 'collab-rebate-manual', now(), now()
     WHERE NOT EXISTS (SELECT 1 FROM finance_invoices_in WHERE invoice_no=$1 AND customs_nos @> ARRAY[$3::varchar])`,
    [invoiceNo, fields.issue_date || null, customsNo, (fields.seller_name || "").trim() || null, amount,
     JSON.stringify([{ url: oss.url, name: file.fileName }])]);
  return res.json({ success: true, customs_no: customsNo, invoice_no: invoiceNo, file_url: oss.url });
}

async function handleUploadContract(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file); if (err) return json(res, 400, { error: err });
  let contractNo = (fields.contract_no || "").trim();
  const customsNo = (fields.customs_no || "").trim();
  if (!contractNo && customsNo) {
    const fer = await pool.query(`SELECT contract_no FROM finance_export_rebates WHERE customs_no=$1 LIMIT 1`, [customsNo]);
    contractNo = fer.rows[0]?.contract_no || "";
  }
  if (!contractNo) return json(res, 400, { error: "contract_no required" });
  const exist = await pool.query(`SELECT id FROM contracts WHERE contract_no=$1 AND file_url IS NOT NULL LIMIT 1`, [contractNo]);
  if (exist.rows.length) return json(res, 409, { error: "该合同采购合同已上传" });
  const facCode = await factoryCodeFor(pool, { contractNo, customsNo });
  const oss = await uploadToOss(facCode || contractNo, "CONTRACT", file);
  await pool.query(
    `INSERT INTO contracts (contract_no, type, status, party_b_code, file_url, file_name, created_by, created_at, updated_at)
     VALUES ($1,'采购合同','active',$2,$3,$4,'collab-rebate',now(),now())`,
    [contractNo, facCode, oss.url, file.fileName || null]);
  return res.json({ success: true, contract_no: contractNo, file_url: oss.url });
}

async function handleUploadSlip(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file); if (err) return json(res, 400, { error: err });
  const customsNo = (fields.customs_no || "").trim();
  const contractNo = (fields.contract_no || "").trim();
  if (!customsNo && !contractNo) return json(res, 400, { error: "customs_no or contract_no required" });
  const facCode = await factoryCodeFor(pool, { contractNo, customsNo });
  const amount = fields.amount ? parseFloat(String(fields.amount).replace(/[^\d.]/g, "")) : null;
  const oss = await uploadToOss(facCode || customsNo || contractNo, "SLIP", file);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slip = await client.query(
      `INSERT INTO bank_slips (beneficiary_company_code, amount, currency, file_url, status, raw, created_by, created_at, updated_at)
       VALUES ($1,$2,'CNY',$3,'recorded',$4::jsonb,'collab-rebate',now(),now()) RETURNING id`,
      [facCode, amount, oss.url, JSON.stringify({ source: "collab-rebate-slip", customs_no: customsNo, contract_no: contractNo })]);
    await client.query(
      `INSERT INTO bank_slip_links (slip_id, bl_no, contract_no, amount_alloc, alloc_currency, note, created_at)
       VALUES ($1,$2,$3,$4,'CNY','退税组补收汇',now())`, [slip.rows[0].id, customsNo || null, contractNo || null, amount]);
    await client.query("COMMIT");
    return res.json({ success: true, slip_id: slip.rows[0].id, file_url: oss.url });
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = (req.query.action || "").trim();
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (!requireAuth(req, res)) return;
    if (action === "upload_invoice") return handleUploadInvoice(req, res);
    if (action === "upload_contract") return handleUploadContract(req, res);
    if (action === "upload_slip") return handleUploadSlip(req, res);
    return json(res, 404, { error: "unknown action" });
  } catch (e) {
    console.error("[rebate-doc-upload]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
