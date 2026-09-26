import { getPool, setCors } from "../db.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";
import {
  invalidNumberResponse,
  normalizeRfqFeeNumbers,
  normalizeRfqQuoteNumbers,
  normalizeRfqSignature,
  RfqNumberValidationError,
} from "./lib/rfq-number-guard.js";
import { insertRfqQuoteRevision } from "./lib/rfq-quote-revisions.js";

const ALLOWED_TABLE = "rfq";

function clean(v, n = 500) {
  return String(v == null ? "" : v).trim().slice(0, n);
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
function requestSignatureMeta(req) {
  return {
    signed_ip: clean(req.headers["x-forwarded-for"] || req.socket?.remoteAddress, 120) || null,
    signed_user_agent: clean(req.headers["user-agent"], 500) || null,
  };
}
function requiredText(body, field, n = 160) {
  const value = clean(body[field], n);
  if (!value) throw new RfqNumberValidationError(field, body[field], "required");
  return value;
}
function quotePayload(body, supplierCode, req) {
  const numbers = normalizeRfqQuoteNumbers({
    price_incl_tax: body.price_incl_tax,
    price_ex_tax: body.price_ex_tax,
    tax_pct: body.tax_pct,
    moq: body.moq,
    lead_time_days: body.lead_time_days,
  });
  const signature = normalizeRfqSignature(body);
  const uploads = {
    image_url: clean(body.image_url, 500) || null,
    quote_file_url: clean(body.quote_file_url, 500) || null,
  };
  const noteText = clean(body.note, 800);
  const uploadNote = uploads.image_url || uploads.quote_file_url
    ? `\n附件: ${JSON.stringify(uploads)}`
    : "";
  return {
    supplier_company_code: supplierCode,
    supplier_item_code: clean(body.supplier_item_code, 160) || null,
    supplier_spec_text: clean(body.supplier_spec_text, 1000) || null,
    quote_date: clean(body.quote_date, 20) || new Date().toISOString().slice(0, 10),
    valid_until: requiredText(body, "valid_until", 20),
    price_incl_tax: numbers.price_incl_tax,
    price_ex_tax: numbers.price_ex_tax,
    tax_pct: numbers.tax_pct,
    is_freight_included: body.is_freight_included === true,
    moq: numbers.moq,
    lead_time_days: numbers.lead_time_days,
    currency: clean(body.currency || "CNY", 12) || "CNY",
    status: "received",
    note: (noteText + uploadNote).trim() || null,
    ...signature,
    ...requestSignatureMeta(req),
  };
}

async function assignment(pool, rawToken) {
  const { rows } = await pool.query(
    `SELECT da.id AS assignment_id, da.collab_sheet_table, da.collab_sheet_id,
            da.task_type, da.status, da.expires_at, da.revoked_at,
            da.supplier_company_code
       FROM driver_assignments da
      WHERE da.magic_token_hash=$1
        AND da.expires_at > NOW()
        AND da.revoked_at IS NULL
      LIMIT 1`,
    [hashToken(rawToken)]
  );
  return rows[0] || null;
}

async function publicRfq(pool, rfqId) {
  return (await pool.query(
    `SELECT id, rfq_no, item_desc, need_qty, need_by, status
       FROM rfq WHERE id=$1`,
    [rfqId]
  )).rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const rawToken = req.method === "GET" ? req.query?.token : req.body?.token || req.query?.token;
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 16) {
    return sendError(res, 400, "token_required");
  }
  const pool = getPool();
  try {
    const asm = await assignment(pool, rawToken);
    if (!asm) return sendError(res, 401, "invalid_or_expired_link");
    if (asm.collab_sheet_table !== ALLOWED_TABLE) return sendError(res, 403, "token_not_for_rfq");
    if (!asm.supplier_company_code) return sendError(res, 400, "supplier_company_code_missing");
    const rfq = await publicRfq(pool, asm.collab_sheet_id);
    if (!rfq) return sendError(res, 404, "rfq_not_found");

    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        assignment: {
          assignment_id: asm.assignment_id,
          task_type: asm.task_type,
          expires_at: asm.expires_at,
          supplier_company_code: asm.supplier_company_code,
        },
        rfq,
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      let q;
      let fees;
      try {
        q = quotePayload(b, asm.supplier_company_code, req);
        fees = Array.isArray(b.fees) ? b.fees.map(feePayload) : [];
      } catch (err) {
        if (err instanceof RfqNumberValidationError) return invalidNumberResponse(res, err);
        throw err;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const quote = await insertRfqQuoteRevision(client, rfq.id, q);
        for (const f of fees) {
          await client.query(
            `INSERT INTO rfq_quote_fees
              (quote_id, fee_type, plate_position, unit_price, color_count,
               refundable, refund_threshold_qty, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [quote.id, f.fee_type, f.plate_position, f.unit_price,
             f.color_count, f.refundable, f.refund_threshold_qty, f.note]
          );
        }
        await client.query("UPDATE rfq SET status='quoting', updated_at=NOW() WHERE id=$1", [rfq.id]);
        await client.query("UPDATE driver_assignments SET used_at=COALESCE(used_at, NOW()), status='submitted' WHERE id=$1", [asm.assignment_id]);
        await client.query("COMMIT");
        return res.status(201).json({ ok: true, quote_id: quote.id });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[rfq-fill]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
