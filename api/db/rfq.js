import { getPool, setCors } from "../db.js";
import {
  generateRawToken,
  hashToken,
  isInternalRole,
  roleFromAuth,
  sendError,
} from "../lib/viewmodel-adapter.js";
import {
  invalidNumberResponse,
  normalizeRfqFeeNumbers,
  normalizeRfqQuoteNumbers,
  normalizeRfqSignature,
  RfqNumberValidationError,
} from "./lib/rfq-number-guard.js";
import { insertRfqQuoteRevision } from "./lib/rfq-quote-revisions.js";

const APP_BASE_URL = "https://api.sanlyn.cn";
const DEFAULT_TTL_HOURS = 168;
const MAX_TTL_HOURS = 336;
const QUOTE_COLS = [
  "supplier_company_code", "supplier_item_code", "supplier_spec_text",
  "quote_date", "valid_until", "price_incl_tax", "price_ex_tax", "tax_pct",
  "is_freight_included", "moq", "lead_time_days", "currency", "status", "note",
  "signed_by_name", "signature_data",
];
const PM_COLS = ["unit_cost", "price_ex_tax", "tax_point", "quote_date", "quote_valid_until", "moq", "lead_time_days"];
const EVIDENCE_REQUIRED_MESSAGE = "我方代录必须至少给一样凭据：手写签名，或报价单文件名";

function clean(v, n = 500) {
  return String(v == null ? "" : v).trim().slice(0, n);
}
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intVal(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function userName(req) {
  return req.user?.username || req.user?.email || req.user?.uid || req.user?.id || "internal";
}
function pathPart(req, index) {
  const parts = String(req.path || "").split("/").filter(Boolean);
  return parts[index] || "";
}
function routeId(req) {
  return intVal(req.params?.id || pathPart(req, 3) || req.query?.id);
}
function requestSignatureMeta(req) {
  return {
    signed_ip: clean(req.headers["x-forwarded-for"] || req.socket?.remoteAddress, 120) || null,
    signed_user_agent: clean(req.headers["user-agent"], 500) || null,
  };
}
function quoteEvidence(body, req) {
  const source_file_name = clean(body.source_file_name, 500) || null;
  const hasSignature = clean(body.signed_by_name, 160) && clean(body.signature_data, 200 * 1024);
  if (hasSignature) {
    return {
      ...normalizeRfqSignature(body),
      ...requestSignatureMeta(req),
      source_file_name,
    };
  }
  if (source_file_name) {
    return {
      signed_by_name: null,
      signature_data: null,
      signed_ip: null,
      signed_user_agent: null,
      source_file_name,
    };
  }
  throw new RfqNumberValidationError("source_file_name", "", "evidence_required", {
    message: EVIDENCE_REQUIRED_MESSAGE,
  });
}
function quotePayload(body, req) {
  const out = {};
  for (const c of QUOTE_COLS) if (body[c] !== undefined) out[c] = body[c];
  const numbers = normalizeRfqQuoteNumbers(out, "internal");
  const evidence = quoteEvidence(body, req);
  out.supplier_company_code = clean(out.supplier_company_code, 80);
  out.currency = clean(out.currency || "CNY", 12) || "CNY";
  out.status = clean(out.status || "received", 20) || "received";
  out.is_freight_included = out.is_freight_included === true;
  Object.assign(out, numbers);
  for (const c of ["supplier_item_code", "supplier_spec_text", "quote_date", "valid_until", "note"]) {
    out[c] = clean(out[c], c === "supplier_spec_text" || c === "note" ? 1000 : 160) || null;
  }
  out.valid_until = clean(body.valid_until, 20) || null;
  Object.assign(out, evidence);
  return out;
}
function feePayload(fee) {
  const numbers = normalizeRfqFeeNumbers(fee);
  return {
    fee_type: clean(fee.fee_type || "plate", 20),
    plate_position: clean(fee.plate_position || "", 20) || null,
    unit_price: numbers.unit_price,
    color_count: numbers.color_count,
    amount: numbers.amount,
    refundable: fee.refundable === true,
    refund_threshold_qty: numbers.refund_threshold_qty,
    note: clean(fee.note, 500) || null,
  };
}

async function loadDetail(pool, id) {
  const rfq = (await pool.query("SELECT * FROM rfq WHERE id=$1", [id])).rows[0];
  if (!rfq) return null;
  const quotes = (await pool.query(
    `SELECT q.*, COALESCE(f.fees, '[]'::json) AS fees,
            COALESCE(f.fee_total, 0) AS fee_total
       FROM rfq_quotes q
       LEFT JOIN LATERAL (
         SELECT json_agg(row_to_json(x) ORDER BY x.id) AS fees,
                SUM(x.amount) AS fee_total
           FROM (SELECT * FROM rfq_quote_fees WHERE quote_id=q.id ORDER BY id) x
       ) f ON TRUE
      WHERE q.rfq_id=$1
      ORDER BY q.id`,
    [id]
  )).rows;
  return { ...rfq, quotes };
}

async function createRfq(req, res, pool) {
  const b = req.body || {};
  const itemDesc = clean(b.item_desc || b.itemDesc, 1000);
  if (!itemDesc) return sendError(res, 400, "item_desc_required");
  const row = (await pool.query(
    `INSERT INTO rfq(item_desc, need_qty, need_by, status, created_by, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [itemDesc, num(b.need_qty), clean(b.need_by, 20) || null,
     clean(b.status || "draft", 20), userName(req), clean(b.note, 1000) || null]
  )).rows[0];
  return res.status(201).json({ ok: true, data: row });
}

async function addQuote(req, res, pool, id) {
  const b = req.body || {};
  let q;
  let fees;
  try {
    q = quotePayload(b, req);
    fees = Array.isArray(b.fees) ? b.fees.map(feePayload) : [];
  } catch (err) {
    if (err instanceof RfqNumberValidationError && err.code === "evidence_required") {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    if (err instanceof RfqNumberValidationError) return invalidNumberResponse(res, err);
    throw err;
  }
  if (!q.supplier_company_code) return sendError(res, 400, "supplier_company_code_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rfq = await client.query("SELECT id FROM rfq WHERE id=$1 FOR UPDATE", [id]);
    if (!rfq.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "rfq_not_found");
    }
    const co = await client.query("SELECT code FROM companies WHERE code=$1", [q.supplier_company_code]);
    if (!co.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "supplier_company_code_not_found");
    }
    const quote = await insertRfqQuoteRevision(client, id, q);
    if (q.source_file_name) {
      await client.query(
        `INSERT INTO rfq_quote_files
          (quote_id, file_name, file_url, uploaded_by, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [quote.id, q.source_file_name, null, userName(req)]
      );
    }
    for (const f of fees) {
      await client.query(
        `INSERT INTO rfq_quote_fees
          (quote_id, fee_type, plate_position, unit_price, color_count,
           refundable, refund_threshold_qty, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [quote.id, f.fee_type, f.plate_position, f.unit_price, f.color_count,
         f.refundable, f.refund_threshold_qty, f.note]
      );
    }
    await client.query("UPDATE rfq SET status='quoting', updated_at=NOW() WHERE id=$1 AND status IN ('draft','sent','quoting')", [id]);
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, data: await loadDetail(pool, id) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function invite(req, res, pool, id) {
  const code = clean(req.body?.supplier_company_code, 80);
  if (!code) return sendError(res, 400, "supplier_company_code_required");
  const rfq = (await pool.query("SELECT id, rfq_no, item_desc, need_qty, need_by FROM rfq WHERE id=$1", [id])).rows[0];
  if (!rfq) return sendError(res, 404, "rfq_not_found");
  const co = await pool.query("SELECT code FROM companies WHERE code=$1", [code]);
  if (!co.rows.length) return sendError(res, 400, "supplier_company_code_not_found");
  const ttl = Math.min(parseInt(req.body?.ttl_hours, 10) || DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
  const raw = generateRawToken(32);
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttl * 3600 * 1000).toISOString();
  const ins = await pool.query(
    `INSERT INTO driver_assignments
       (driver_id, collab_sheet_table, collab_sheet_id, order_id, task_type,
        status, magic_token_hash, expires_at, assigned_by, notes, supplier_company_code)
     VALUES (NULL, 'rfq', $1, NULL, 'rfq_supplier_fill',
        'pending', $2, $3, $4, $5, $6)
     RETURNING id, collab_sheet_table, collab_sheet_id, task_type, status,
               expires_at, created_at, assigned_by, supplier_company_code`,
    [id, tokenHash, expiresAt, userName(req), clean(req.body?.notes, 1000) || null, code]
  );
  const token = encodeURIComponent(raw);
  return res.status(201).json({
    ok: true,
    data: {
      assignment: ins.rows[0],
      raw_token: raw,
      magic_link_url: `${APP_BASE_URL}/public/rfq-fill.html?token=${token}`,
      api_url: `${APP_BASE_URL}/api/db/rfq-fill?token=${token}`,
      rfq,
    },
  });
}

async function convert(req, res, pool, id) {
  const quoteId = intVal(req.body?.selected_quote_id || req.body?.quote_id);
  const sku = clean(req.body?.sku_code, 100);
  if (!quoteId) return sendError(res, 400, "selected_quote_id_required");
  if (!sku) return sendError(res, 400, "sku_code_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const quote = (await client.query("SELECT * FROM rfq_quotes WHERE id=$1 AND rfq_id=$2 FOR UPDATE", [quoteId, id])).rows[0];
    if (!quote) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "quote_not_found");
    }
    const pm = (await client.query(`SELECT ${PM_COLS.join(", ")} FROM packaging_materials WHERE sku_code=$1 FOR UPDATE`, [sku])).rows[0];
    if (!pm) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "packaging_material_not_found");
    }
    const before = {};
    for (const c of PM_COLS) before[c] = pm[c] == null ? null : pm[c];
    const after = {
      unit_cost: quote.price_incl_tax,
      price_ex_tax: quote.price_ex_tax,
      tax_point: quote.tax_pct,
      quote_date: quote.quote_date,
      quote_valid_until: quote.valid_until,
      moq: quote.moq,
      lead_time_days: quote.lead_time_days,
    };
    await client.query(
      `UPDATE packaging_materials
          SET unit_cost=$1, price_ex_tax=$2, tax_point=$3, quote_date=$4,
              quote_valid_until=$5, moq=$6, lead_time_days=$7, updated_at=NOW()
        WHERE sku_code=$8`,
      [after.unit_cost, after.price_ex_tax, after.tax_point, after.quote_date,
       after.quote_valid_until, after.moq, after.lead_time_days, sku]
    );
    await client.query("UPDATE rfq_quotes SET status=CASE WHEN id=$1 THEN 'selected' ELSE 'rejected' END, updated_at=NOW() WHERE rfq_id=$2", [quoteId, id]);
    const note = JSON.stringify({ packaging_material_sku: sku, before, after });
    const decision = (await client.query(
      `INSERT INTO rfq_decisions
        (rfq_id, selected_quote_id, reason, decided_by, converted_to_order, converted_ref, note)
       VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING *`,
      [id, quoteId, clean(req.body?.reason, 1000) || null, userName(req), sku, note]
    )).rows[0];
    await client.query("UPDATE rfq SET status='decided', updated_at=NOW() WHERE id=$1", [id]);
    await client.query("COMMIT");
    return res.status(200).json({ ok: true, data: { decision, before, after } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const role = roleFromAuth(req);
  if (!isInternalRole(role)) return sendError(res, 403, "admin_only");
  const pool = getPool();
  try {
    const id = routeId(req);
    const sub = pathPart(req, 4);
    if (req.method === "GET" && !id) {
      const rows = (await pool.query("SELECT * FROM rfq ORDER BY created_at DESC LIMIT 200")).rows;
      return res.status(200).json({ ok: true, data: rows, count: rows.length });
    }
    if (req.method === "GET" && id) {
      const data = await loadDetail(pool, id);
      return data ? res.status(200).json({ ok: true, data }) : sendError(res, 404, "rfq_not_found");
    }
    if (req.method === "POST" && !id) return createRfq(req, res, pool);
    if (req.method === "POST" && id && sub === "quotes") return addQuote(req, res, pool, id);
    if (req.method === "POST" && id && sub === "invite") return invite(req, res, pool, id);
    if (req.method === "POST" && id && sub === "convert") return convert(req, res, pool, id);
    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[rfq]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
