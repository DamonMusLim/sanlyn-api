// api/db/slip-ocr.js
// Water slip: slip_uploads → MiniMax M3 OCR → bank_slips pending review
// 2026-06-13
import {
  linkCanonicalDocument,
  markCanonicalDocumentFailed,
  sha256Hex
} from "./canonical-document-registry.js";
import { ocrPaymentAdvice } from "./slip-core.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..", "..");

function num2(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return parseFloat(n.toFixed(2));
}

function safeDate(v) {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : v.slice(0, 10);
}

async function markUploadFailed(pool, uploadId, fileSha256, message) {
  await markCanonicalDocumentFailed(pool, "bank_slip", fileSha256);
  await pool.query(
    `UPDATE slip_uploads SET note = COALESCE(note,'') || $1 WHERE id=$2`,
    [` OCR_FAIL: ${message}`.slice(0, 300), uploadId]
  );
}

function extractShipmentNos(parsed) {
  const text = [
    parsed?.beneficiary_reference,
    parsed?.remark_details
  ].filter(Boolean).join(" ");
  const seen = new Set();
  const out = [];
  const re = /\bCY\d+\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const shipmentNo = m[0].toUpperCase();
    if (!seen.has(shipmentNo)) {
      seen.add(shipmentNo);
      out.push(shipmentNo);
    }
  }
  return out;
}

export async function matchShipmentCandidates(pool, parsed) {
  const shipmentNos = extractShipmentNos(parsed);
  if (!shipmentNos.length) return [];

  const candidates = await lookupShipmentCandidatesByNos(pool, shipmentNos);
  return candidates.map(c => ({ ...c, matched_by: "ocr_extracted" }));
}

export async function lookupShipmentCandidatesByNos(pool, shipmentNos, matchedBy = null) {
  const cleanNos = [...new Set((Array.isArray(shipmentNos) ? shipmentNos : [])
    .map(v => String(v || "").trim().toUpperCase())
    .filter(Boolean))]
    .slice(0, 50);
  if (!cleanNos.length) return [];

  const plans = await pool.query(
    `SELECT id, shipment_no, customer, customer_cn, customer_en,
            freight_total_cny, order_nos, bl_no, container_no
       FROM shipping_plans
      WHERE shipment_no = ANY($1::text[])
      ORDER BY array_position($1::text[], shipment_no)`,
    [cleanNos]
  );
  const candidates = [];
  for (const plan of plans.rows) {
    const orderNos = Array.isArray(plan.order_nos) ? plan.order_nos.filter(Boolean) : [];
    let contractNos = [];
    let issuingCompany = null;
    if (orderNos.length) {
      const orders = await pool.query(
        `SELECT order_no, contract_no,
                raw->>'issuingCompanyEN' AS issuing_en,
                raw->>'issuingCompany' AS issuing
           FROM orders
          WHERE order_no = ANY($1::text[])
          ORDER BY array_position($1::text[], order_no)`,
        [orderNos]
      );
      contractNos = [...new Set(orders.rows.map(r => r.contract_no).filter(Boolean))].sort();
      const issuing = orders.rows
        .map(r => r.issuing_en || r.issuing)
        .find(v => String(v || "").trim());
      issuingCompany = issuing ? String(issuing).trim() : null;
    }
    const cb = await pool.query(
      `SELECT container_no
         FROM container_bookings
        WHERE shipping_plan_id = $1
          AND container_no IS NOT NULL
          AND container_no <> ''
        ORDER BY container_no`,
      [plan.id]
    );
    let containerNos = cb.rows.map(r => r.container_no).filter(Boolean);
    if (!containerNos.length && plan.container_no) {
      containerNos = String(plan.container_no).split(",").map(s => s.trim()).filter(Boolean);
    }
    candidates.push({
      shipment_no: plan.shipment_no,
      shipping_plan_id: plan.id,
      customer: plan.customer || plan.customer_cn || plan.customer_en || null,
      customer_cn: plan.customer_cn || null,
      customer_en: plan.customer_en || null,
      freight_total_cny: plan.freight_total_cny == null ? null : Number(plan.freight_total_cny),
      order_nos: orderNos,
      contract_nos: contractNos,
      container_nos: containerNos,
      bl_no: plan.bl_no || null,
      issuing_company: issuingCompany,
      ...(matchedBy ? { matched_by: matchedBy } : {})
    });
  }
  return candidates;
}

export async function searchCustomerShipments(pool, customer, q = "", limit = 30) {
  const customerTerm = String(customer || "").trim();
  if (!customerTerm) {
    const err = new Error("customer参数必填");
    err.status = 400;
    throw err;
  }
  const searchTerm = String(q || "").trim();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 50));
  const params = [`%${customerTerm}%`, safeLimit];
  let qFilter = "";
  if (searchTerm) {
    params.splice(1, 0, `%${searchTerm}%`);
    qFilter = `AND (
      shipment_no ILIKE $2 OR bl_no ILIKE $2 OR container_no ILIKE $2
      OR EXISTS (
        SELECT 1
          FROM orders o
         WHERE o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
           AND (o.order_no ILIKE $2 OR o.contract_no ILIKE $2)
      )
    )`;
  }
  const limitParam = params.length;
  const r = await pool.query(
    `SELECT sp.id, sp.shipment_no, sp.customer, sp.customer_cn, sp.customer_en,
            sp.freight_total_cny, sp.order_nos, sp.bl_no, sp.container_no,
            COALESCE(sp.etd, sp.created_at)::timestamptz AS sort_at,
            COALESCE((
              SELECT array_agg(DISTINCT o.contract_no ORDER BY o.contract_no)
                FROM orders o
               WHERE o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
                 AND o.contract_no IS NOT NULL
                 AND o.contract_no <> ''
            ), ARRAY[]::text[]) AS contract_nos
       FROM shipping_plans sp
      WHERE (sp.customer ILIKE $1 OR sp.customer_cn ILIKE $1 OR sp.customer_en ILIKE $1)
        ${qFilter}
      ORDER BY sort_at DESC NULLS LAST, sp.id DESC
      LIMIT $${limitParam}`,
    params
  );
  return r.rows.map(row => ({
    shipment_no: row.shipment_no,
    shipping_plan_id: row.id,
    customer: row.customer || row.customer_cn || row.customer_en || null,
    customer_cn: row.customer_cn || null,
    customer_en: row.customer_en || null,
    freight_total_cny: row.freight_total_cny == null ? null : Number(row.freight_total_cny),
    order_nos: Array.isArray(row.order_nos) ? row.order_nos.filter(Boolean) : [],
    contract_nos: Array.isArray(row.contract_nos) ? row.contract_nos.filter(Boolean) : [],
    bl_no: row.bl_no || null
  }));
}

async function mergeCustomerSelectedCandidates(pool, baseCandidates, selectedShipmentNos) {
  const merged = [...(Array.isArray(baseCandidates) ? baseCandidates : [])];
  const seen = new Set(merged.map(c => String(c?.shipment_no || "").toUpperCase()).filter(Boolean));
  const extra = await lookupShipmentCandidatesByNos(pool, selectedShipmentNos, "customer_selected");
  for (const candidate of extra) {
    const key = String(candidate.shipment_no || "").toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

export async function processSlipUpload(pool, uploadRow) {
  const absPath = path.join(BASE_DIR, uploadRow.stored_path);
  if (!fs.existsSync(absPath)) throw new Error(`slip file not found: ${absPath}`);

  const fileBytes = fs.readFileSync(absPath);
  const fileSha256 = uploadRow.file_sha256 || sha256Hex(fileBytes);
  let parsed, rawText;
  try {
    ({ parsed, rawText } = await ocrPaymentAdvice(
      fileBytes,
      uploadRow.filename || uploadRow.stored_path,
      absPath,
      process.env.MINIMAX_API_KEY
    ));
  } catch (ocrErr) {
    await markUploadFailed(pool, uploadRow.id, fileSha256, ocrErr.message);
    throw ocrErr;
  }

  // validate required fields
  const amountNum = num2(parsed.amount);
  const paymentDate = safeDate(parsed.payment_date);
  if (amountNum === null) {
    await markUploadFailed(pool, uploadRow.id, fileSha256, "OCR: amount missing or invalid");
    throw new Error("OCR: amount missing or invalid");
  }
  if (!paymentDate) {
    await markUploadFailed(pool, uploadRow.id, fileSha256, "OCR: payment_date missing or invalid");
    throw new Error("OCR: payment_date missing or invalid");
  }

  // deduplicate on bank_reference_no
  const bankRef = String(parsed.bank_reference_no || "").trim();
  if (bankRef) {
    const existing = await pool.query("SELECT id FROM bank_slips WHERE bank_reference_no=$1 LIMIT 1", [bankRef]);
    if (existing.rows.length) {
      await pool.query(
        "UPDATE slip_uploads SET processed=TRUE, slip_id=$1 WHERE id=$2",
        [existing.rows[0].id, uploadRow.id]
      );
      await linkCanonicalDocument(pool, {
        domain: "bank_slip",
        file_sha256: fileSha256,
        linked_table: "bank_slips",
        linked_id: existing.rows[0].id
      });
      return { slip_id: existing.rows[0].id, skipped: true, reason: "duplicate bank_reference_no" };
    }
  }

  const matchCandidates = await mergeCustomerSelectedCandidates(
    pool,
    await matchShipmentCandidates(pool, parsed),
    uploadRow.customer_selected_shipments
  );
  const raw = {
    ocr_raw: rawText,
    ocr_model: "MiniMax-M3",
    upload_id: uploadRow.id,
    match_candidates: matchCandidates
  };

  const slipRes = await pool.query(
    `INSERT INTO bank_slips (
       bank_source, bank_reference_no, txn_ref,
       sender_name, sender_bank, sender_country,
       beneficiary_name, beneficiary_bank, beneficiary_account_masked,
       amount, currency, indicative_amount, indicative_currency, exchange_rate,
       cable_charge, commission_charge, sst_charge, charge_currency,
       purpose_code, remark_details, beneficiary_reference,
       payment_date, bank_processing_date,
       file_url, status, raw, created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,$18,
       $19,$20,$21,
       $22,$23,
       $24,$25,$26,$27
     ) RETURNING id`,
    [
      String(parsed.bank_source || "").slice(0, 20) || null,
      bankRef || null,
      String(parsed.txn_ref || "").trim() || null,
      String(parsed.sender_name || "").trim() || null,
      String(parsed.sender_bank || "").trim() || null,
      String(parsed.sender_country || "").slice(0, 50) || null,
      String(parsed.beneficiary_name || "").trim() || null,
      String(parsed.beneficiary_bank || "").trim() || null,
      String(parsed.beneficiary_account_masked || "").trim() || null,
      amountNum,
      String(parsed.currency || "").slice(0, 3).toUpperCase() || null,
      num2(parsed.indicative_amount),
      String(parsed.indicative_currency || "").slice(0, 3).toUpperCase() || null,
      num2(parsed.exchange_rate),
      num2(parsed.cable_charge),
      num2(parsed.commission_charge),
      num2(parsed.sst_charge),
      String(parsed.charge_currency || "").slice(0, 3).toUpperCase() || null,
      String(parsed.purpose_code || "").trim() || null,
      String(parsed.remark_details || "").trim() || null,
      String(parsed.beneficiary_reference || "").trim() || null,
      paymentDate,
      safeDate(parsed.bank_processing_date),
      uploadRow.stored_path,
      "pending_review",
      JSON.stringify(raw),
      "slip_ocr_auto"
    ]
  );
  const slipId = slipRes.rows[0].id;

  // ensure updated_at column exists
  await pool.query(
    `ALTER TABLE slip_uploads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`
  );
  await pool.query(
    "UPDATE slip_uploads SET processed=TRUE, slip_id=$1, updated_at=now() WHERE id=$2",
    [slipId, uploadRow.id]
  );

  await linkCanonicalDocument(pool, {
    domain: "bank_slip",
    file_sha256: fileSha256,
    linked_table: "bank_slips",
    linked_id: slipId
  });

  return { slip_id: slipId, status: "pending_review", candidates: matchCandidates.length };
}
