// api/db/smart-invoice-upload.js
// POST /api/db/smart-invoice-upload
// phase=detect: OCR + 匹配 shipping_plans；phase=confirm: 按选中的计划入库 finance_invoices_in。

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { extractInvoiceFields } from "../ocr-review-invoice.js";

const INTERNAL_ROLES = new Set([
  "admin", "superadmin", "super_admin", "finance", "operator", "owner",
  "manager", "trader", "system", "internal", "internal_sanlyn",
  "sales", "ceo", "boss", "platform_admin",
]);
const TOKEN_RE = /\b[A-Z]{4}[0-9A-Z]{6,14}\b/gi;

function clean(v, max = 200) {
  return v == null ? "" : String(v).trim().slice(0, max);
}

function money(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = clean(v, 80).toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function arrayFromDb(v) {
  if (Array.isArray(v)) return v.map(x => clean(x, 80)).filter(Boolean);
  if (v == null) return [];
  if (typeof v === "object") return [];
  return String(v)
    .replace(/[{}\[\]"]/g, " ")
    .split(/[,|]/)
    .map(x => clean(x, 80))
    .filter(Boolean);
}

function contractNosFromPlan(row) {
  const values = [
    ...arrayFromDb(row.contract_nos),
    ...arrayFromDb(row.order_contract_nos),
    clean(row.contract_no, 80),
  ].filter(Boolean);
  return uniqStrings(values);
}

function candidateView(row) {
  return {
    id: row.id,
    shipment_no: row.shipment_no || null,
    contract_nos: contractNosFromPlan(row),
    forwarder_cn: row.forwarder_cn || null,
    customer_cn: row.customer_cn || row.customer || null,
  };
}

function fileTokens(fileName) {
  const matches = clean(fileName, 300).match(TOKEN_RE) || [];
  return matches.map(x => x.toUpperCase());
}

function buildHints(fields, fileName, seedHint) {
  return uniqStrings([
    ...(fields?.blNos || []),
    ...(fields?.containerNos || []),
    ...fileTokens(fileName),
    clean(seedHint, 80),
  ]);
}

function isLogistics(user) {
  return String(user?.role || "").toLowerCase() === "logistics";
}

function isInternal(user) {
  return INTERNAL_ROLES.has(String(user?.role || "").toLowerCase());
}

async function logisticsCompanyIds(client, user) {
  const ids = new Set();
  for (const v of [user?.companyId, user?.company_id]) {
    const n = Number(v);
    if (Number.isInteger(n)) ids.add(n);
  }

  const codes = Array.isArray(user?.companyCodes) && user.companyCodes.length
    ? user.companyCodes
    : [user?.companyCode || user?.company_code].filter(Boolean);
  const cleanCodes = codes.map(c => clean(c, 80)).filter(Boolean);
  if (cleanCodes.length) {
    const r = await client.query(
      `SELECT id FROM companies WHERE code = ANY($1::text[]) OR id::text = ANY($1::text[])`,
      [cleanCodes]
    );
    for (const row of r.rows) {
      const n = Number(row.id);
      if (Number.isInteger(n)) ids.add(n);
    }
  }
  return [...ids];
}

async function queryPlansByHint(client, hint, allowedForwarderIds = null) {
  const params = [hint];
  let sql = `
    SELECT *
      FROM shipping_plans
     WHERE deleted_at IS NULL
       AND (bl_no = $1 OR mbl_no = $1 OR hbl_no = $1 OR booking_no = $1
            OR forwarder_booking_no = $1 OR container_no = $1)
  `;
  if (allowedForwarderIds) {
    params.push(allowedForwarderIds);
    sql += ` AND forwarder_company_id = ANY($${params.length}::int[])`;
  }
  sql += " ORDER BY etd DESC NULLS LAST, created_at DESC NULLS LAST, id DESC LIMIT 20";
  return (await client.query(sql, params)).rows;
}

async function queryPlansByIds(client, ids) {
  const cleanIds = ids.map(id => Number(id)).filter(Number.isInteger);
  if (!cleanIds.length) return [];
  const r = await client.query(
    `SELECT *
       FROM shipping_plans
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
      ORDER BY id`,
    [cleanIds]
  );
  return r.rows;
}

async function detect(req, res, client, body) {
  const ossUrl = clean(body.ossUrl || body.oss_url, 1000);
  const fileName = clean(body.fileName || body.file_name || "invoice", 300);
  if (!ossUrl) return res.status(400).json({ success: false, error: "ossUrl required" });

  const fields = await extractInvoiceFields(ossUrl);
  const hints = buildHints(fields, fileName, body.seedHint);
  let allowedForwarderIds = null;
  if (isLogistics(req.user)) {
    allowedForwarderIds = await logisticsCompanyIds(client, req.user);
    if (!allowedForwarderIds.length) {
      return res.status(200).json({ success: true, ocrFields: fields, candidates: [], matchedByHint: [] });
    }
  } else if (!isInternal(req.user)) {
    return res.status(403).json({ success: false, error: "internal or logistics role required" });
  }

  const byId = new Map();
  const matchedByHint = [];
  for (const hint of hints) {
    const rows = await queryPlansByHint(client, hint, allowedForwarderIds);
    matchedByHint.push({ hint, count: rows.length, shipmentNos: rows.map(r => r.shipment_no).filter(Boolean) });
    for (const row of rows) byId.set(row.id, row);
  }

  return res.status(200).json({
    success: true,
    ocrFields: fields,
    candidates: [...byId.values()].map(candidateView),
    matchedByHint,
  });
}

async function confirm(req, res, client, body) {
  const selectedIds = Array.isArray(body.selectedShipmentIds) ? body.selectedShipmentIds : [];
  if (selectedIds.length < 1) {
    return res.status(400).json({ success: false, error: "selectedShipmentIds required" });
  }

  const plans = await queryPlansByIds(client, selectedIds);
  if (plans.length !== uniqStrings(selectedIds.map(String)).length) {
    return res.status(404).json({ success: false, error: "selected shipment not found" });
  }

  if (isLogistics(req.user)) {
    const allowed = await logisticsCompanyIds(client, req.user);
    if (!allowed.length) return res.status(403).json({ success: false, error: "logistics company binding missing" });
    const allowedSet = new Set(allowed.map(Number));
    const bad = plans.find(p => !allowedSet.has(Number(p.forwarder_company_id)));
    if (bad) return res.status(403).json({ success: false, error: "shipment not owned by caller" });
  } else if (!isInternal(req.user)) {
    return res.status(403).json({ success: false, error: "internal or logistics role required" });
  }

  const ossUrl = clean(body.ossUrl || body.oss_url, 1000);
  const fileName = clean(body.fileName || body.file_name || "invoice", 300);
  const buyerCode = clean(body.buyerCode || body.buyer_code, 80).toUpperCase();
  const amount = money(body.amount);
  if (!ossUrl) return res.status(400).json({ success: false, error: "ossUrl required" });
  if (!buyerCode) return res.status(400).json({ success: false, error: "buyerCode required" });
  if (!(amount > 0)) return res.status(400).json({ success: false, error: "amount required" });

  const contractNos = uniqStrings(plans.flatMap(contractNosFromPlan));
  if (!contractNos.length) return res.status(409).json({ success: false, error: "selected shipments have no contract_nos" });

  const buyer = (await client.query(
    `SELECT name_cn, tax_id FROM companies WHERE code = $1 LIMIT 1`,
    [buyerCode]
  )).rows[0] || {};
  const attach = JSON.stringify([{ url: ossUrl, name: fileName, uploaded_at: new Date().toISOString() }]);
  const raw = JSON.stringify({
    matchedShipmentIds: plans.map(p => p.id),
    ocrSource: true,
    selectedShipmentIds,
    planRefs: plans.map(p => ({ id: p.id, shipment_no: p.shipment_no || null, contract_nos: contractNosFromPlan(p) })),
  });

  await client.query("BEGIN");
  const ins = await client.query(
    `INSERT INTO finance_invoices_in
       (invoice_no, invoice_type, seller_name,
        buyer_name, buyer_tax_id, buyer_company_code,
        amount_incl_tax, currency, contract_nos,
        source, review_status, attachments, raw, created_at, updated_at)
     VALUES
       ($1, '增值税专用发票', $2,
        $3, $4, $5,
        $6, $7, $8::text[],
        'smart_upload', 'pending', $9::jsonb, $10::jsonb, NOW(), NOW())
     RETURNING id`,
    [
      clean(body.invoiceNo || body.invoice_no, 80) || null,
      clean(body.sellerName || body.seller_name, 200) || null,
      buyer.name_cn || null,
      buyer.tax_id || null,
      buyerCode,
      amount,
      clean(body.currency, 20).toUpperCase() || null,
      contractNos,
      attach,
      raw,
    ]
  );
  await client.query("COMMIT");

  return res.status(200).json({
    success: true,
    id: ins.rows[0].id,
    matchedContractNos: contractNos,
    matchedShipmentCount: plans.length,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });
  if (!requireAuth(req, res)) return;

  const body = req.body || {};
  const phase = clean(body.phase, 20);
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (phase === "detect") return await detect(req, res, client, body);
    if (phase === "confirm") return await confirm(req, res, client, body);
    return res.status(400).json({ success: false, error: "phase must be detect or confirm" });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[smart-invoice-upload] error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error" });
  } finally {
    client.release();
  }
}
