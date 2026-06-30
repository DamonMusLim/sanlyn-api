// api/db/collab-closure.js — 协同闭环视图端点(接通用引擎)
// GET  ?action=list&from=&to=  → 财务域闭环列表(需JWT)
// POST ?action=upload_contract  (multipart customs_no+file) → 上传采购合同
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { getClosure } from "./collab-closure-engine.js";
import { FINANCE_DOMAIN } from "./collab-domains.js";
import { readUploadPayload, validateFile, uploadToOss } from "./factory-invoice-upload.js";

export const config = { api: { bodyParser: false } };

const FAC = {
  "371120260000179925": "福建泰迪", "371120260000198206": "福建泰迪",
  "425820260000623039": "烟台中宠", "422720260000516460": "烟台中宠",
  "422720260000521242": "烟台中宠", "422720260000521266": "烟台中宠",
  "425820260000664707": "徐州大之圣", "420420260000171960": "连云港中砂",
  "021720260000158349": "辽宁宠爱",
};

function json(res, code, body) { return res.status(code).json(body); }

async function ensureContractTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS purchase_contracts (
    id serial PRIMARY KEY, customs_no varchar, file_url text, file_name text,
    created_by text, created_at timestamptz DEFAULT now())`).catch(() => {});
}

async function handleList(req, res) {
  const pool = getPool();
  const from = (req.query.from || "").trim() || null;
  const to = (req.query.to || "").trim() || null;
  const rows = await getClosure(pool, FINANCE_DOMAIN, { from, to });
  // 采购合同真源:purchase_contracts(引擎里恒missing,这里覆盖)
  await ensureContractTable(pool);
  const cr = await pool.query(`SELECT customs_no, file_url FROM purchase_contracts`);
  const contractMap = new Map(cr.rows.map((r) => [r.customs_no, r.file_url]));
  // fer金额(报关货值/退税)
  const amts = await pool.query(
    `SELECT customs_no, fob_cny, rebate_expected FROM finance_export_rebates
      WHERE ($1::date IS NULL OR export_date>=$1) AND ($2::date IS NULL OR export_date<=$2)`, [from, to]);
  const amtMap = new Map(amts.rows.map((r) => [r.customs_no, r]));

  const summary = { total: rows.length };
  const out = rows.map((r) => {
    if (contractMap.has(r.key) && r.items["采购合同"]) {
      r.items["采购合同"] = { status: "done", doc_url: contractMap.get(r.key) };
      if (r.stage === "采购合同") { // 重算环节:采购合同有了往后推
        const order = ["报关单", "进项票", "水单", "采购合同"];
        r.stage = order.find((k) => r.items[k]?.status === "missing") || "已闭环";
        r.owner = r.stage === "已闭环" ? null : (r.stage === "水单" ? "财务" : "工厂");
      }
    }
    summary[r.stage] = (summary[r.stage] || 0) + 1;
    const a = amtMap.get(r.key) || {};
    return { ...r, factory: FAC[r.key] || r.label || r.key, fob_cny: a.fob_cny, rebate_expected: a.rebate_expected };
  });
  return res.json({ success: true, rows: out, summary });
}

async function handleUploadContract(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file);
  if (err) return json(res, 400, { error: err });
  const customsNo = (fields.customs_no || fields.customsNo || "").trim();
  if (!customsNo) return json(res, 400, { error: "customs_no required" });
  await ensureContractTable(pool);
  const exist = await pool.query(`SELECT id FROM purchase_contracts WHERE customs_no=$1 LIMIT 1`, [customsNo]);
  if (exist.rows.length) return json(res, 409, { error: "该报关单采购合同已上传" });
  const oss = await uploadToOss(customsNo, "CONTRACT", file);
  await pool.query(
    `INSERT INTO purchase_contracts (customs_no, file_url, file_name, created_by, created_at)
     VALUES ($1,$2,$3,$4,now())`,
    [customsNo, oss.url, file.fileName || null, "finance"]);
  return res.json({ success: true, customs_no: customsNo, file_url: oss.url });
}

// 内部补料:工厂code(从订单按合同号取)
async function factoryCodeFor(pool, customsNo) {
  const r = await pool.query(
    `SELECT o.factory_code FROM finance_export_rebates fer
       JOIN orders o ON o.contract_no=fer.contract_no AND o.factory_code IS NOT NULL
      WHERE fer.customs_no=$1 LIMIT 1`, [customsNo]);
  return r.rows[0]?.factory_code || null;
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
     SELECT $1, $2::date, ARRAY[$3::varchar], $4, $5, $6::jsonb, 'collab-closure-manual', now(), now()
     WHERE NOT EXISTS (SELECT 1 FROM finance_invoices_in WHERE invoice_no=$1 AND customs_nos @> ARRAY[$3::varchar])`,
    [invoiceNo, fields.issue_date || null, customsNo, FAC[customsNo] || null, amount,
     JSON.stringify([{ url: oss.url, name: file.fileName }])]);
  return res.json({ success: true, customs_no: customsNo, invoice_no: invoiceNo, file_url: oss.url });
}

async function handleUploadSlip(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const err = validateFile(file); if (err) return json(res, 400, { error: err });
  const customsNo = (fields.customs_no || "").trim();
  if (!customsNo) return json(res, 400, { error: "customs_no required" });
  const facCode = await factoryCodeFor(pool, customsNo);
  const amount = fields.amount ? parseFloat(String(fields.amount).replace(/[^\d.]/g, "")) : null;
  const oss = await uploadToOss(facCode || customsNo, "SLIP", file);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slip = await client.query(
      `INSERT INTO bank_slips (beneficiary_name, beneficiary_company_code, amount, currency, file_url, status, raw, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,'CNY',$4,'recorded',$5::jsonb,'finance-collab',now(),now()) RETURNING id`,
      [FAC[customsNo] || null, facCode, amount, oss.url,
       JSON.stringify({ source: "collab-closure-slip", customs_no: customsNo })]);
    await client.query(
      `INSERT INTO bank_slip_links (slip_id, bl_no, amount_alloc, alloc_currency, note, created_at)
       VALUES ($1,$2,$3,'CNY','协同闭环补水单',now())`, [slip.rows[0].id, customsNo, amount]);
    await client.query("COMMIT");
    return res.json({ success: true, customs_no: customsNo, slip_id: slip.rows[0].id, file_url: oss.url });
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const action = (req.query.action || "").trim();
    if (req.method === "GET" && action === "list") {
      if (!requireAuth(req, res)) return;
      return handleList(req, res);
    }
    if (req.method === "POST" && action === "upload_contract") {
      if (!requireAuth(req, res)) return;
      return handleUploadContract(req, res);
    }
    if (req.method === "POST" && action === "upload_invoice") {
      if (!requireAuth(req, res)) return;
      return handleUploadInvoice(req, res);
    }
    if (req.method === "POST" && action === "upload_slip") {
      if (!requireAuth(req, res)) return;
      return handleUploadSlip(req, res);
    }
    return json(res, 404, { error: "unknown action" });
  } catch (e) {
    console.error("[collab-closure]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
