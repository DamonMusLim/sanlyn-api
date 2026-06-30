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
    return json(res, 404, { error: "unknown action" });
  } catch (e) {
    console.error("[collab-closure]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}
