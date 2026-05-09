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
    // Include orders whose ETD, delivery_date, or created_at falls in the period,
    // or orders that are active (not cancelled) and were created earlier (outstanding).
    const ordersResult = await pool.query(
      `SELECT
         _id              AS contract_no,
         company_code,
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
       WHERE company_code = $1
         AND status != 'cancelled'
         AND (
           (etd            >= $2 AND etd            < $3)
           OR (delivery_date  >= $2 AND delivery_date  < $3)
           OR (created_at     >= $2 AND created_at     < $3)
         )
       ORDER BY COALESCE(etd, delivery_date, created_at) ASC`,
      [company_code, periodStart.toISOString(), periodEnd.toISOString()]
    );

    const orders = ordersResult.rows;

    if (orders.length === 0) {
      // Return empty but valid response
      return res.json({
        success: true,
        period: periodLabel,
        company_code,
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
    // Match by contract_no (canonical) or via raw->>'companyCode' scoped
    const contractNos = orders.map(o => o.contract_no).filter(Boolean);
    const placeholders = contractNos.map((_, i) => `$${i + 2}`).join(", ");

    let paymentsResult;
    if (contractNos.length > 0) {
      paymentsResult = await pool.query(
        `SELECT
           id,
           contract_no,
           _id,
           amount,
           paid_amount,
           bank_ref,
           currency,
           direction,
           status,
           tt_slip_url,
           created_at,
           updated_at,
           raw,
           -- raw sub-fields commonly used
           raw->>'companyCode'   AS company_code_raw,
           raw->>'paidDate'      AS paid_date_raw,
           raw->>'paymentDate'   AS payment_date_raw,
           raw->>'type'          AS type_raw,
           raw->>'payType'       AS pay_type_raw,
           raw->>'receivedAmount'AS received_amount_raw,
           raw->>'bankRef'       AS bank_ref_raw,
           raw->>'note'          AS note_raw
         FROM finance_payments
         WHERE contract_no IN (${placeholders})
            OR raw->>'companyCode' = $1
         ORDER BY created_at ASC`,
        [company_code, ...contractNos]
      );
    } else {
      paymentsResult = await pool.query(
        `SELECT
           id, contract_no, _id, amount, paid_amount, bank_ref, currency, direction,
           status, tt_slip_url, created_at, updated_at, raw,
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
         ORDER BY created_at ASC`,
        [company_code]
      );
    }

    const allPayments = paymentsResult.rows;

    // ── 3. Build per-order enriched records ──────────────────────
    const PLATFORM_FEE_UNIT = 50;
    const disputed_items = [];

    const enrichedOrders = orders.map(order => {
      const cno = order.contract_no;

      // Match payments to this order by contract_no
      const orderPayments = allPayments.filter(p => p.contract_no === cno);

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
      const payments = orderPayments.map(p => ({
        id:          p.id,
        paid_date:   p.paid_date_raw || p.payment_date_raw || p.created_at,
        this_amount: p.paid_amount != null ? parseFloat(p.paid_amount)
                   : p.received_amount_raw ? parseFloat(p.received_amount_raw)
                   : p.amount != null      ? parseFloat(p.amount) : null,
        type:        p.type_raw || p.pay_type_raw || null,
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
        company_code,
        generated_at:  new Date().toISOString(),
        summary,
      });
    }

    // ── 6. Full JSON response ─────────────────────────────────────
    return res.json({
      success:        true,
      period:         periodLabel,
      company_code,
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
