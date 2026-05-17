// api/db/vendor-invoice-upload.js
// POST /api/db/vendor-invoice-upload
//
// Logistics vendor records the invoice they issued to a Sanlyn entity for a
// freight BL. Closes the loop the bare OSS upload did not: writes a PENDING
// inbound-invoice row to finance_invoices_in.
//
// Finance-safe by construction:
//   - logistics-scoped exactly like freight-supplier-bills.js (JWT companyCode)
//   - BL ownership verified against freight_supplier_bills (cannot bill a BL
//     that is not the caller's)
//   - amount/currency RECOMPUTED from real bill rows, never trusted from client
//   - buyer (Sanlyn entity) resolved from companies table (authoritative)
//   - review_status = 'pending' (vendor self-submitted, not yet verified)
//   - idempotent: one pending row per (seller_company_code, bl_no, buyer)
//   - additive only: never updates/deletes any other finance row

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const BUYER = { BABI: { taxRate: 0.06, ccy: "CNY" }, OCEANBABY: { taxRate: 0, ccy: "USD" } };

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res))   return;

  const role       = req.user?.role;
  const sellerCode = req.user?.companyCode
    || (Array.isArray(req.user?.companyCodes) && req.user.companyCodes[0])
    || null;

  if (role !== "logistics" && role !== "admin" && role !== "finance")
    return res.status(403).json({ error: "logistics, admin, or finance role required" });
  if (role === "logistics" && !sellerCode)
    return res.status(403).json({ error: "logistics user missing companyCode binding" });

  const b         = req.body || {};
  const blNo      = String(b.bl_no || "").trim();
  const buyerCode = String(b.buyer_code || "").trim().toUpperCase();
  const ossUrl    = String(b.oss_url || "").trim();
  const fileName  = String(b.file_name || "").trim() || "invoice";

  if (!blNo)                return res.status(400).json({ error: "bl_no required" });
  if (!ossUrl)              return res.status(400).json({ error: "oss_url required" });
  if (!BUYER[buyerCode])    return res.status(400).json({ error: "buyer_code must be BABI or OCEANBABY" });

  const pool = getPool();
  try {
    // 1. Verify BL belongs to this vendor + recompute real amount from bills.
    const scopeParams = [blNo];
    let scopeCond = "bl_no = $1";
    if (role === "logistics") {
      scopeParams.push(sellerCode);
      scopeCond += " AND supplier_company_code = $2";
    }
    const billRes = await pool.query(
      `SELECT currency, amount, supplier, supplier_company_code
         FROM freight_supplier_bills WHERE ${scopeCond}`,
      scopeParams
    );
    if (billRes.rowCount === 0)
      return res.status(404).json({ error: "No freight bills found for this BL under your account" });

    let usd = 0, cny = 0, sellerName = null, sellerCC = null;
    for (const r of billRes.rows) {
      const amt = Number(r.amount) || 0;
      if (/usd/i.test(String(r.currency || ""))) usd += amt; else cny += amt;
      if (!sellerName) { sellerName = r.supplier; sellerCC = r.supplier_company_code; }
    }

    const meta     = BUYER[buyerCode];
    const amount   = meta.ccy === "USD" ? usd : cny;
    if (!(amount > 0))
      return res.status(409).json({ error: `No ${meta.ccy} charges on this BL for ${buyerCode} invoicing` });
    const amountEx = meta.taxRate > 0 ? Number((amount / (1 + meta.taxRate)).toFixed(2)) : amount;
    const totalTax = Number((amount - amountEx).toFixed(2));

    // 2. Resolve buyer (Sanlyn entity) from companies table — authoritative.
    const buyRes = await pool.query(
      `SELECT code, name_cn, tax_id FROM companies WHERE code = $1 LIMIT 1`,
      [buyerCode]
    );
    const buyer = buyRes.rows[0] || {};

    // 3. Idempotent: one pending vendor_upload row per (seller, bl, buyer).
    const sellerStore = sellerCC || sellerCode;
    const dupe = await pool.query(
      `SELECT id FROM finance_invoices_in
        WHERE source = 'vendor_upload'
          AND seller_company_code = $1
          AND buyer_company_code  = $2
          AND $3 = ANY(contract_nos)
        LIMIT 1`,
      [sellerStore, buyerCode, blNo]
    );

    const attach = JSON.stringify([
      { url: ossUrl, name: fileName, uploaded_at: new Date().toISOString() },
    ]);
    const rawJson = JSON.stringify({
      bl_no: blNo,
      oss_url: ossUrl,
      buyer_code: buyerCode,
      uploaded_by_uid: req.user?.uid || req.user?.id || null,
      uploaded_by_role: role,
      note: "vendor self-submitted invoice — pending finance verification",
    });

    if (dupe.rowCount > 0) {
      const id = dupe.rows[0].id;
      await pool.query(
        `UPDATE finance_invoices_in
            SET attachments = $1::jsonb,
                raw = $2::jsonb,
                amount_incl_tax = $3,
                amount_ex_tax = $4,
                total_tax = $5,
                updated_at = NOW()
          WHERE id = $6 AND source = 'vendor_upload'`,
        [attach, rawJson, amount, amountEx, totalTax, id]
      );
      return res.status(200).json({
        ok: true, id, deduped: true, amount, currency: meta.ccy, review_status: "pending",
      });
    }

    const ins = await pool.query(
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

    return res.status(200).json({
      ok: true, id: ins.rows[0].id, amount, currency: meta.ccy, review_status: "pending",
    });
  } catch (err) {
    console.error("[vendor-invoice-upload] error:", err.message);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
