// LuvSome payment slip OCR pipeline.
import {
  linkCanonicalDocument,
  markCanonicalDocumentFailed,
  sha256Hex
} from "./canonical-document-registry.js";
import { ocrPaymentAdvice } from "./slip-core.js";
import { searchRead } from "../odoo.js";
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

// Damon拍板(2026-07-08): sale_order(小程序线上单)优先，pos_order(门店POS)兜底。
// pos_order目前0条数据(功能装了未启用)，查询留活，等门店POS真正启用后自动生效。
export async function matchPetOrderCandidates(pool, parsed) {
  const candidates = [];
  const amount = parseFloat(parsed.amount);
  if (!isFinite(amount)) return candidates;

  const rawName = String(parsed.sender_name || "").trim();
  const remark = String(parsed.remark_details || "");
  const phoneMatch = (remark + " " + rawName).match(/1[3-9]\d{9}/);

  let partners = [];
  if (phoneMatch) {
    partners = await searchRead("res.partner", [["phone", "=", phoneMatch[0]]], ["id", "name", "phone"], { limit: 5 });
  }
  if (!partners.length && rawName) {
    partners = await searchRead("res.partner", [["name", "ilike", rawName]], ["id", "name", "phone"], { limit: 5 });
  }
  if (!partners.length) return candidates;

  const partnerIds = partners.map((p) => p.id);
  const tolerance = Math.max(1, amount * 0.02);
  const amountLow = Math.round((amount - tolerance) * 100) / 100;
  const amountHigh = Math.round((amount + tolerance) * 100) / 100;

  const saleOrders = await searchRead(
    "sale.order",
    [["partner_id", "in", partnerIds], ["amount_total", ">=", amountLow], ["amount_total", "<=", amountHigh]],
    ["name", "partner_id", "amount_total", "date_order", "state"],
    { limit: 10, order: "date_order desc" }
  );
  for (const o of saleOrders) {
    candidates.push({
      source: "sale_order",
      id: o.id,
      order_no: o.name,
      partner: Array.isArray(o.partner_id) ? o.partner_id[1] : null,
      amount: o.amount_total,
      date: o.date_order,
      state: o.state
    });
  }

  // pos_order兜底：只在sale_order没命中时查，容错(模型未安装/未启用不阻断OCR主流程)
  if (!candidates.length) {
    try {
      const posOrders = await searchRead(
        "pos.order",
        [["partner_id", "in", partnerIds], ["amount_total", ">=", amountLow], ["amount_total", "<=", amountHigh]],
        ["name", "partner_id", "amount_total", "date_order", "state"],
        { limit: 10, order: "date_order desc" }
      );
      for (const o of posOrders) {
        candidates.push({
          source: "pos_order",
          id: o.id,
          order_no: o.name,
          partner: Array.isArray(o.partner_id) ? o.partner_id[1] : null,
          amount: o.amount_total,
          date: o.date_order,
          state: o.state
        });
      }
    } catch (e) {
      // pos.order model may not exist yet on this Odoo instance — non-fatal.
    }
  }

  return candidates;
}

export async function processPetSlipUpload(pool, uploadRow, options = {}) {
  const absPath = path.join(BASE_DIR, uploadRow.stored_path);
  if (!fs.existsSync(absPath)) throw new Error(`pet slip file not found: ${absPath}`);

  const fileBytes = fs.readFileSync(absPath);
  const fileSha256 = uploadRow.file_sha256 || sha256Hex(fileBytes);
  let parsed, rawText;
  try {
    ({ parsed, rawText } = await ocrPaymentAdvice(
      fileBytes,
      uploadRow.filename || uploadRow.stored_path,
      absPath,
      options.minimaxApiKey || process.env.MINIMAX_API_KEY
    ));
  } catch (ocrErr) {
    await markCanonicalDocumentFailed(pool, "pet_slip", fileSha256);
    await pool.query(
      `UPDATE pet_slip_uploads SET note = COALESCE(note,'') || $1 WHERE id=$2`,
      [` OCR_FAIL: ${ocrErr.message}`.slice(0, 300), uploadRow.id]
    );
    throw ocrErr;
  }

  const amountNum = num2(parsed.amount);
  const paymentDate = safeDate(parsed.payment_date);
  if (amountNum === null) {
    await markCanonicalDocumentFailed(pool, "pet_slip", fileSha256);
    throw new Error("OCR: amount missing or invalid");
  }
  if (!paymentDate) {
    await markCanonicalDocumentFailed(pool, "pet_slip", fileSha256);
    throw new Error("OCR: payment_date missing or invalid");
  }

  const bankRef = String(parsed.bank_reference_no || "").trim();
  if (bankRef) {
    const existing = await pool.query("SELECT id FROM pet_slip_payments WHERE bank_reference_no=$1 LIMIT 1", [bankRef]);
    if (existing.rows.length) {
      await pool.query(
        "UPDATE pet_slip_uploads SET processed=TRUE, slip_id=$1, updated_at=now() WHERE id=$2",
        [existing.rows[0].id, uploadRow.id]
      );
      await linkCanonicalDocument(pool, {
        domain: "pet_slip",
        file_sha256: fileSha256,
        linked_table: "pet_slip_payments",
        linked_id: existing.rows[0].id
      });
      return { slip_id: existing.rows[0].id, skipped: true, reason: "duplicate bank_reference_no" };
    }
  }

  const matchCandidates = await matchPetOrderCandidates(pool, parsed);
  const raw = {
    ocr_raw: rawText,
    ocr_model: "MiniMax-M3",
    upload_id: uploadRow.id,
    match_candidates: matchCandidates
  };

  const slipRes = await pool.query(
    `INSERT INTO pet_slip_payments (
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
      "pet_slip_ocr_auto"
    ]
  );
  const slipId = slipRes.rows[0].id;

  await pool.query(
    "UPDATE pet_slip_uploads SET processed=TRUE, slip_id=$1, updated_at=now() WHERE id=$2",
    [slipId, uploadRow.id]
  );
  await linkCanonicalDocument(pool, {
    domain: "pet_slip",
    file_sha256: fileSha256,
    linked_table: "pet_slip_payments",
    linked_id: slipId
  });

  return { slip_id: slipId, status: "pending_review", candidates: matchCandidates.length };
}
