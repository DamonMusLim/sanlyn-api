// api/db/collab-closure.js — 协同闭环视图端点(接通用引擎)
// GET  ?action=list&from=&to=  → 财务域闭环列表(需JWT)
// POST ?action=upload_contract  (multipart customs_no+file) → 上传采购合同
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { getClosure } from "./collab-closure-engine.js";
import { FINANCE_DOMAIN } from "./collab-domains.js";
import { readUploadPayload, validateFile, uploadToOss } from "./factory-invoice-upload.js";
import { ocrCustoms } from "./customs-ocr-minimax.js";
import fs from "fs";
import os from "os";
import path from "path";

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
  // 报关单原件(OCR上传落 customs_docs),让报关单chip能打开原件
  await ensureCustomsDocsTable(pool);
  const cd = await pool.query(`SELECT customs_no, file_url FROM customs_docs`);
  const custDocMap = new Map(cd.rows.map((r) => [r.customs_no, r.file_url]));

  const summary = { total: rows.length };
  const out = rows.map((r) => {
    if (custDocMap.has(r.key) && r.items["报关单"]) r.items["报关单"].doc_url = custDocMap.get(r.key);
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
  // 采购合同=我们的PO,存入 contracts 表(唯一真源)
  const fer = await pool.query(`SELECT contract_no FROM finance_export_rebates WHERE customs_no=$1 LIMIT 1`, [customsNo]);
  const contractNo = fer.rows[0]?.contract_no || customsNo;
  const exist = await pool.query(`SELECT id FROM contracts WHERE contract_no=$1 AND file_url IS NOT NULL LIMIT 1`, [contractNo]);
  if (exist.rows.length) return json(res, 409, { error: "该合同采购合同已上传" });
  const facCode = await factoryCodeFor(pool, customsNo);
  const oss = await uploadToOss(facCode || customsNo, "CONTRACT", file);
  await pool.query(
    `INSERT INTO contracts (contract_no, type, status, party_b_code, file_url, file_name, created_by, created_at, updated_at)
     VALUES ($1,'采购合同','active',$2,$3,$4,'finance',now(),now())`,
    [contractNo, facCode, oss.url, file.fileName || null]);
  return res.json({ success: true, customs_no: customsNo, contract_no: contractNo, file_url: oss.url });
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

async function ensureCustomsDocsTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS customs_docs (
    id serial PRIMARY KEY, customs_no varchar UNIQUE, file_url text, file_name text,
    ocr jsonb, cny_total numeric, created_by text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`).catch(() => {});
}

// 报关单上传 → MiniMax M3 OCR → fer仅补空填报关货值 + 存原件(事件驱动,无cron)
async function handleUploadCustoms(req, res) {
  const pool = getPool();
  const { fields, file } = await readUploadPayload(req);
  const verr = validateFile(file); if (verr) return json(res, 400, { error: verr });
  const confirmed = ["1", "true", "yes"].includes(String(req.query.confirmed || fields.confirmed || "").toLowerCase());
  const explicitDry = ["1", "true", "yes"].includes(String(req.query.dry || req.query.dry_run || fields.dry || fields.dry_run || "").toLowerCase());
  const dry = explicitDry || !confirmed;
  // 落临时文件(PDF需路径给pdftoppm)
  const tmp = path.join(os.tmpdir(), `custup_${Date.now()}_${String(file.fileName || "f").replace(/[^\w.]/g, "_")}`);
  fs.writeFileSync(tmp, file.buffer);
  let ocr;
  try { ocr = await ocrCustoms(file.buffer, file.fileName || "x.pdf", tmp); }
  finally { try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {} }

  const customsNo = String(ocr.customs_no || fields.customs_no || "").replace(/\D/g, "");
  if (customsNo.length < 10) return json(res, 422, { error: "OCR未识别到有效海关编号", ocr_raw: ocr.raw });
  const cny = Number(ocr.cny_total) || 0;

  const cur = await pool.query(
    `SELECT fob_cny, rebate_rate FROM finance_export_rebates WHERE customs_no=$1 LIMIT 1`, [customsNo]);
  const exists = cur.rows.length > 0;
  const curCny = exists ? Number(cur.rows[0].fob_cny) || 0 : 0;
  const rate = exists ? (Number(cur.rows[0].rebate_rate) || 0.09) : 0.09;
  const willFill = cny > 0 && curCny === 0;
  const plan = { customs_no: customsNo, cny_total: cny, by_source: ocr.by_source,
    fer_exists: exists, cur_fob_cny: curCny, will_fill: willFill, will_insert: !exists && cny > 0,
    rebate_would: +(cny * rate).toFixed(2) };
  if (dry) return res.json({ success: true, dry: true, confirmed: false, confirmation_required: true, plan, ocr_items: ocr.items });

  const oss = await uploadToOss(customsNo, "CUSTOMS", file);
  await ensureCustomsDocsTable(pool);
  await pool.query(
    `INSERT INTO customs_docs (customs_no, file_url, file_name, ocr, cny_total, created_by, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'collab-ocr',now())
     ON CONFLICT (customs_no) DO UPDATE SET file_url=EXCLUDED.file_url, file_name=EXCLUDED.file_name,
       ocr=EXCLUDED.ocr, cny_total=EXCLUDED.cny_total, updated_at=now()`,
    [customsNo, oss.url, file.fileName || null, JSON.stringify(ocr), cny || null]);

  let ferAction = "unchanged";
  if (!exists && cny > 0) {
    await pool.query(
      `INSERT INTO finance_export_rebates (customs_no, fob_cny, rebate_rate, rebate_expected, export_date, source, created_at)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,'ocr-collab',now())`,
      [customsNo, cny, rate, +(cny * rate).toFixed(2)]);
    ferAction = "inserted";
  } else if (exists && willFill) {
    await pool.query(
      `UPDATE finance_export_rebates SET fob_cny=$2, rebate_expected=ROUND($2*COALESCE(rebate_rate,0.09),2)
        WHERE customs_no=$1 AND COALESCE(fob_cny,0)=0`, [customsNo, cny]);
    ferAction = "filled";
  }
  return res.json({ success: true, customs_no: customsNo, cny_total: cny,
    by_source: ocr.by_source, fer_action: ferAction, file_url: oss.url });
}

// 删除报关单原件(重传/清理测试;revert_fer=1 才回滚OCR新建的fer行)
async function handleDeleteCustomsDoc(req, res) {
  const pool = getPool();
  const customsNo = String(req.query.customs_no || "").replace(/\D/g, "");
  if (!customsNo) return json(res, 400, { error: "customs_no required" });
  await ensureCustomsDocsTable(pool);
  const del = await pool.query(`DELETE FROM customs_docs WHERE customs_no=$1 RETURNING id`, [customsNo]);
  let ferReverted = 0;
  if (String(req.query.revert_fer || "") === "1") {
    const r = await pool.query(
      `DELETE FROM finance_export_rebates WHERE customs_no=$1 AND source='ocr-collab' RETURNING customs_no`, [customsNo]);
    ferReverted = r.rows.length;
  }
  return res.json({ success: true, deleted: del.rows.length, fer_reverted: ferReverted });
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
    if (req.method === "POST" && action === "upload_customs") {
      if (!requireAuth(req, res)) return;
      return handleUploadCustoms(req, res);
    }
    if (req.method === "POST" && action === "delete_customs_doc") {
      if (!requireAuth(req, res)) return;
      return handleDeleteCustomsDoc(req, res);
    }
    return json(res, 404, { error: "unknown action" });
  } catch (e) {
    console.error("[collab-closure]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
