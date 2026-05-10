// api/db/reconciliation.js
// GET /api/db/reconciliation — monthly statement with payment matching
// Query params:
//   company_code (required) — customer identifier
//   year + month (optional, default = current month)
//   format — "json" (default) or "summary"

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  try {
    const {
      company_code,
      year,
      month,
      format = "json",
    } = req.query;

    if (!company_code) {
      return res.status(400).json({ error: "company_code is required" });
    }

    // Non-admin users may only query their own company scope
    if (req.user?.role !== "admin") {
      const userCodes =
        req.user?.companyCodes ||
        (req.user?.companyCode ? [req.user.companyCode] : null);
      if (!userCodes?.length) {
        return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
      }
      if (!userCodes.includes(company_code)) {
        return res.status(403).json({ error: "Access denied for this company_code." });
      }
    }

    // ── Resolve company_code → canonical CN-XXXXX format ─────────
    // Accepts either CN-XXXXX directly, or a short name/keyword that
    // gets looked up in the customers table.
    let resolvedCompanyCode = company_code;
    let resolvedCompanyName = null;

    if (!company_code.match(/^CN-\d+$/i)) {
      // Try to resolve by name_en, name, or short_code ILIKE match
      const lookup = await pool.query(
        `SELECT company_code, name, name_en FROM customers
         WHERE name_en ILIKE $1 OR name ILIKE $1 OR short_code ILIKE $1
         LIMIT 1`,
        [`%${company_code}%`]
      );
      if (lookup.rows.length > 0) {
        resolvedCompanyCode = lookup.rows[0].company_code;
        resolvedCompanyName = lookup.rows[0].name_en || lookup.rows[0].name;
      } else {
        // Fall back to using the value as-is (may match customer column directly)
        resolvedCompanyCode = company_code;
      }
    } else {
      // Look up the name for display
      const lookup = await pool.query(
        `SELECT name_en, name FROM customers WHERE company_code = $1 LIMIT 1`,
        [company_code]
      );
      if (lookup.rows.length > 0) {
        resolvedCompanyName = lookup.rows[0].name_en || lookup.rows[0].name;
      }
    }

    // ── Determine period ──────────────────────────────────────────
    const now = new Date();
    const targetYear  = parseInt(year  || now.getFullYear(), 10);
    const targetMonth = parseInt(month || now.getMonth() + 1, 10);

    if (targetMonth < 1 || targetMonth > 12) {
      return res.status(400).json({ error: "month must be 1–12" });
    }

    const periodStart = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const periodEnd   = new Date(Date.UTC(targetYear, targetMonth, 1)); // exclusive
    const periodLabel = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;

    // ── 1. Fetch orders for this company in the period ────────────
    // Match by company_code (CN-XXXXX) OR customer name (for legacy data).
    // Include orders whose ETD, delivery_date, or created_at falls in the period.
    const ordersResult = await pool.query(
      `SELECT
         -- Use the human-readable contract_no (FS20260223060) as the match key.
         -- finance_payments.contract_no stores FS-style values, NOT the MongoDB _id.
         -- Fall back to _id only if contract_no is missing (very old records).
         COALESCE(NULLIF(contract_no,''), _id) AS contract_no,
         order_no,
         company_code,
         customer,
         status,
         customer_amount,
         factory_amount,
         margin_amount,
         margin_pct,
         seller_code,
         currency,
         etd,
         delivery_date,
         created_at,
         raw
       FROM orders
       WHERE (company_code = $1 OR (company_code IS NULL AND customer ILIKE $4))
         AND status != 'cancelled'
         AND (
           (etd            >= $2 AND etd            < $3)
           OR (delivery_date  >= $2 AND delivery_date  < $3)
           OR (created_at     >= $2 AND created_at     < $3)
         )
       ORDER BY COALESCE(etd, delivery_date, created_at) ASC`,
      [resolvedCompanyCode, periodStart.toISOString(), periodEnd.toISOString(),
       `%${company_code}%`]
    );

    const orders = ordersResult.rows;

    if (orders.length === 0) {
      // Return empty but valid response
      return res.json({
        success: true,
        period: periodLabel,
        company_code: resolvedCompanyCode,
        company_name: resolvedCompanyName,
        generated_at: new Date().toISOString(),
        summary: {
          total_orders: 0,
          total_receivable: 0,
          total_paid: 0,
          outstanding: 0,
          currency: "USD",
          platform_fee_total: 0,
          platform_fee_unit: 50,
        },
        orders: [],
        disputed_items: [],
      });
    }

    // ── 2. Fetch all payments for this company ────────────────────
    // Match by contract_no OR order_no (fallback for legacy payments where
    // contract_no = FS-style string and order_no = short '40-CA-1' style).
    const contractNos = orders.map(o => o.contract_no).filter(Boolean);
    const orderNos    = orders.map(o => o.order_no).filter(Boolean);

    let paymentsResult;
    if (contractNos.length > 0 || orderNos.length > 0) {
      // Build dynamic IN lists for both contract_no and order_no
      const allKeys   = [...new Set([...contractNos, ...orderNos])];
      const phs       = allKeys.map((_, i) => `$${i + 2}`).join(", ");
      paymentsResult  = await pool.query(
        `SELECT
           id,
           contract_no,
           order_no,
           _id,
           amount,
           paid_amount,
           bank_ref,
           currency,
           direction,
           pay_type,
           status,
           tt_slip_url,
           payment_date,
           paid_date,
           created_at,
           updated_at,
           raw,
           raw->>'companyCode'    AS company_code_raw,
           raw->>'paidDate'       AS paid_date_raw,
           raw->>'paymentDate'    AS payment_date_raw,
           raw->>'type'           AS type_raw,
           raw->>'payType'        AS pay_type_raw,
           raw->>'receivedAmount' AS received_amount_raw,
           raw->>'bankRef'        AS bank_ref_raw,
           raw->>'note'           AS note_raw
         FROM finance_payments
         WHERE contract_no IN (${phs})
            OR order_no    IN (${phs})
            OR raw->>'companyCode' = $1
         ORDER BY COALESCE(payment_date, paid_date, created_at) ASC`,
        [company_code, ...allKeys]
      );
    } else {
      paymentsResult = await pool.query(
        `SELECT
           id, contract_no, order_no, _id, amount, paid_amount, bank_ref, currency,
           direction, pay_type, status, tt_slip_url, payment_date, paid_date,
           created_at, updated_at, raw,
           raw->>'companyCode'    AS company_code_raw,
           raw->>'paidDate'       AS paid_date_raw,
           raw->>'paymentDate'    AS payment_date_raw,
           raw->>'type'           AS type_raw,
           raw->>'payType'        AS pay_type_raw,
           raw->>'receivedAmount' AS received_amount_raw,
           raw->>'bankRef'        AS bank_ref_raw,
           raw->>'note'           AS note_raw
         FROM finance_payments
         WHERE raw->>'companyCode' = $1
         ORDER BY COALESCE(payment_date, paid_date, created_at) ASC`,
        [company_code]
      );
    }

    const allPayments = paymentsResult.rows;

    // ── 3. Build per-order enriched records ──────────────────────
    const PLATFORM_FEE_UNIT = 50;
    const disputed_items = [];

    const enrichedOrders = orders.map(order => {
      const cno = order.contract_no;
      const ono = order.order_no;

      // AR predicate — Codex P1 (round 3):
      // Reconciliation = customer receivable view. Must include only AR
      // payments (money IN from customer). AP rows that share an order_no
      // (supplier/forwarder payouts) would otherwise reduce the customer's
      // outstanding balance incorrectly.
      const isAR = (p) => {
        const d = (p.direction || "").toString();
        return d === "AR" || d === "收款" || d === "in";
      };

      // Match payments to this order:
      //  - Primary:  finance_payments.contract_no = orders.contract_no (FS-style)
      //  - Fallback: finance_payments.order_no    = orders.order_no    (40-CA-1 style)
      //  - AND      payment direction is AR (no AP leakage into receivables)
      const orderPayments = allPayments.filter(p =>
        isAR(p) &&
        ((cno && p.contract_no === cno) ||
         (ono && p.order_no    === ono))
      );

      // Sum paid amounts — prefer paid_amount column, fallback to raw->receivedAmount, then amount
      const paidTotal = orderPayments.reduce((sum, p) => {
        const v =
          p.paid_amount != null   ? parseFloat(p.paid_amount) :
          p.received_amount_raw   ? parseFloat(p.received_amount_raw) :
          p.amount != null        ? parseFloat(p.amount) : 0;
        return sum + (isNaN(v) ? 0 : v);
      }, 0);

      const customerAmount = parseFloat(order.customer_amount) || 0;
      const outstanding    = Math.max(0, customerAmount - paidTotal);

      // payment_status
      let payment_status;
      if (outstanding <= 0.01) {
        payment_status = "paid";
      } else if (paidTotal > 0.01) {
        payment_status = "partial";
      } else {
        payment_status = "unpaid";
      }

      // disputed: completed order, has payments, but outstanding > ¥1 (rounding tolerance)
      const disputed =
        Math.abs(outstanding) > 1 &&
        order.status === "completed" &&
        paidTotal > 0;

      // Build clean payment list
      // Codex P2 fix: payments[].type fallback now includes the native
      // pay_type column. Order: raw->>type → raw->>payType → native
      // pay_type. raw->>type wins to preserve existing UI behaviour.
      const payments = orderPayments.map(p => ({
        id:          p.id,
        paid_date:   p.payment_date || p.paid_date || p.paid_date_raw || p.payment_date_raw || p.created_at,
        this_amount: p.paid_amount != null ? parseFloat(p.paid_amount)
                   : p.received_amount_raw ? parseFloat(p.received_amount_raw)
                   : p.amount != null      ? parseFloat(p.amount) : null,
        type:        p.type_raw || p.pay_type_raw || p.pay_type || null,
        bank_ref:    p.bank_ref || p.bank_ref_raw || null,
        direction:   p.direction || null,
        currency:    p.currency  || order.currency || "USD",
        slip_url:    p.tt_slip_url || null,
        note:        p.note_raw || null,
      }));

      const result = {
        contract_no:     cno,
        status:          order.status,
        customer_amount: customerAmount,
        currency:        order.currency || "USD",
        etd:             order.etd,
        delivery_date:   order.delivery_date,
        seller_code:     order.seller_code,
        product_name:    order.raw?.productName || order.raw?.products?.[0]?.name || null,
        bl_no:           order.raw?.blNo || null,
        vessel:          order.raw?.vessel || null,
        payments,
        paid_total:      Math.round(paidTotal * 100) / 100,
        outstanding:     Math.round(outstanding * 100) / 100,
        payment_status,
        disputed,
      };

      if (disputed) disputed_items.push(result);
      return result;
    });

    // ── 4. Aggregate summary ──────────────────────────────────────
    const dominantCurrency = (() => {
      const freq = {};
      orders.forEach(o => { const c = o.currency || "USD"; freq[c] = (freq[c] || 0) + 1; });
      return Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || "USD";
    })();

    const totalReceivable = enrichedOrders.reduce((s, o) => s + o.customer_amount, 0);
    const totalPaid       = enrichedOrders.reduce((s, o) => s + o.paid_total, 0);
    const totalOutstanding = enrichedOrders.reduce((s, o) => s + o.outstanding, 0);

    const summary = {
      total_orders:       enrichedOrders.length,
      total_receivable:   Math.round(totalReceivable  * 100) / 100,
      total_paid:         Math.round(totalPaid        * 100) / 100,
      outstanding:        Math.round(totalOutstanding * 100) / 100,
      currency:           dominantCurrency,
      platform_fee_total: enrichedOrders.length * PLATFORM_FEE_UNIT,
      platform_fee_unit:  PLATFORM_FEE_UNIT,
    };

    // ── 5. summary-only format ────────────────────────────────────
    if (format === "summary") {
      return res.json({
        success:       true,
        period:        periodLabel,
        company_code:  resolvedCompanyCode,
        company_name:  resolvedCompanyName,
        generated_at:  new Date().toISOString(),
        summary,
      });
    }

    // ── 6. Full JSON response ─────────────────────────────────────
    return res.json({
      success:        true,
      period:         periodLabel,
      company_code:   resolvedCompanyCode,
      company_name:   resolvedCompanyName,
      generated_at:   new Date().toISOString(),
      summary,
      orders:         enrichedOrders,
      disputed_items,
    });

  } catch (err) {
    console.error("[reconciliation] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
