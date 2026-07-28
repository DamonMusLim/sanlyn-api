// api/db/vendor-invoice-upload.js
// POST /api/db/vendor-invoice-upload
//
// A logistics vendor records the invoice they issued to a Sanlyn entity for a
// freight BL. Closes the loop the bare OSS upload did not: writes a PENDING
// inbound-invoice row to finance_invoices_in.
//
// Finance-safe by construction (post codex review):
//   - logistics-only; JWT companyCode scoping identical to freight-supplier-bills.js
//   - BL ownership verified against freight_supplier_bills (cannot bill a BL
//     that is not the caller's supplier_company_code)
//   - amount/currency RECOMPUTED from real bill rows, never trusted from client
//   - buyer (Sanlyn entity) resolved from companies table (authoritative)
//   - additive-only: an already-reviewed row is NEVER overwritten; re-upload
//     after review inserts a fresh pending row, preserving finance history
//   - race-safe: transaction + advisory lock serializes concurrent same-key
//     uploads so no duplicate finance rows are created
//   - the ONLY UPDATE path touches the caller's own still-pending row

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const BUYER = { BABI: { taxRate: 0.06, ccy: "CNY" }, OCEANBABY: { taxRate: 0, ccy: "USD" } };

// Stable 64-bit-ish key for pg_advisory_xact_lock from the dedupe tuple.
function lockKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res))   return;

  // Logistics-only: this endpoint exists solely for the vendor billing board.
  if (req.user?.role !== "logistics")
    return res.status(403).json({ error: "logistics role required" });

  const sellerCode = req.user?.companyCode
    || (Array.isArray(req.user?.companyCodes) && req.user.companyCodes[0])
    || null;
  if (!sellerCode)
    return res.status(403).json({ error: "logistics user missing companyCode binding" });

  const b         = req.body || {};
  const blNo      = String(b.bl_no || "").trim();
  const buyerCode = String(b.buyer_code || "").trim().toUpperCase();
  const ossUrl    = String(b.oss_url || "").trim();
  const fileName  = String(b.file_name || "").trim() || "invoice";

  if (!blNo)             return res.status(400).json({ error: "bl_no required" });
  if (!ossUrl)           return res.status(400).json({ error: "oss_url required" });
  if (!BUYER[buyerCode]) return res.status(400).json({ error: "buyer_code must be BABI or OCEANBABY" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    // 1. Verify BL belongs to this vendor + recompute real amount from bills.
    const billRes = await client.query(
      // Intentional raw-table read: vendor upload verifies rows under the vendor account; voided rows are excluded explicitly.
      `SELECT currency, amount, supplier, supplier_company_code
         FROM freight_supplier_bills
        WHERE bl_no = $1 AND supplier_company_code = $2
          AND COALESCE(rebill_status, '') <> 'voided'`,
      [blNo, sellerCode]
    );
    if (billRes.rowCount === 0) {
      client.release();
      return res.status(404).json({ error: "No freight bills found for this BL under your account" });
    }

    let usd = 0, cny = 0, sellerName = null, sellerCC = null;
    for (const r of billRes.rows) {
      const amt = Number(r.amount) || 0;
      if (/usd/i.test(String(r.currency || ""))) usd += amt; else cny += amt;
      if (!sellerName) { sellerName = r.supplier; sellerCC = r.supplier_company_code; }
    }
    const meta   = BUYER[buyerCode];
    const amount = meta.ccy === "USD" ? usd : cny;
    if (!(amount > 0)) {
      client.release();
      return res.status(409).json({ error: `No ${meta.ccy} charges on this BL for ${buyerCode} invoicing` });
    }
    const amountEx = meta.taxRate > 0 ? Number((amount / (1 + meta.taxRate)).toFixed(2)) : amount;
    const totalTax = Number((amount - amountEx).toFixed(2));
    const sellerStore = sellerCC || sellerCode;

    // 2. Resolve buyer (Sanlyn entity) from companies table — authoritative.
    const buyRes = await client.query(
      `SELECT name_cn, tax_id FROM companies WHERE code = $1 LIMIT 1`,
      [buyerCode]
    );
    const buyer = buyRes.rows[0] || {};

    const attach = JSON.stringify([
      { url: ossUrl, name: fileName, uploaded_at: new Date().toISOString() },
    ]);
    const rawJson = JSON.stringify({
      bl_no: blNo, oss_url: ossUrl, buyer_code: buyerCode,
      uploaded_by_uid: req.user?.uid || req.user?.id || null,
      note: "vendor self-submitted invoice — pending finance verification",
    });

    // 3. Serialize concurrent same-key uploads, then additive-only dedupe.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      lockKey(`${sellerStore}|${buyerCode}|${blNo}`),
    ]);

    const existing = await client.query(
      `SELECT id, review_status FROM finance_invoices_in
        WHERE source = 'vendor_upload'
          AND seller_company_code = $1
          AND buyer_company_code  = $2
          AND $3 = ANY(contract_nos)
        ORDER BY id DESC LIMIT 1`,
      [sellerStore, buyerCode, blNo]
    );

    let id, deduped = false;
    if (existing.rowCount > 0 && existing.rows[0].review_status === "pending") {
      // Caller's own not-yet-reviewed submission — safe to refresh in place.
      id = existing.rows[0].id;
      deduped = true;
      await client.query(
        `UPDATE finance_invoices_in
            SET attachments = $1::jsonb, raw = $2::jsonb,
                amount_incl_tax = $3, amount_ex_tax = $4, total_tax = $5,
                updated_at = NOW()
          WHERE id = $6 AND source = 'vendor_upload' AND review_status = 'pending'`,
        [attach, rawJson, amount, amountEx, totalTax, id]
      );
    } else {
      // No prior row, OR prior row already reviewed → never overwrite finance
      // history; insert a fresh pending re-submission.
      const ins = await client.query(
        `INSERT INTO finance_invoices_in
           (invoice_type, seller_name, seller_company_code,
            buyer_name, buyer_tax_id, buyer_company_code,
            amount_ex_tax, total_tax, amount_incl_tax, tax_rate, currency,
            contract_nos, source, review_status, attachments, raw,
            created_at, updated_at)
         VALUES
           ('增值税专用发票', $1, $2,
            $3, $4, $5,
            $6, $7, $8, $9, $10,
            ARRAY[$11]::varchar[], 'vendor_upload', 'pending', $12::jsonb, $13::jsonb,
            NOW(), NOW())
         RETURNING id`,
        [
          sellerName, sellerStore,
          buyer.name_cn || null, buyer.tax_id || null, buyerCode,
          amountEx, totalTax, amount, meta.taxRate, meta.ccy,
          blNo, attach, rawJson,
        ]
      );
      id = ins.rows[0].id;
    }

    await client.query("COMMIT");
    client.release();
    return res.status(200).json({
      ok: true, id, deduped, amount, currency: meta.ccy, review_status: "pending",
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    client.release();
    console.error("[vendor-invoice-upload] error:", err.message);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
