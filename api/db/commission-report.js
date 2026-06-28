// ═══════════════════════════════════════════════════════════════
// commission-report.js — MEMO / STUB, NOT DEPLOYED
// ═══════════════════════════════════════════════════════════════
// Monthly commission rebate report for reseller accounts.
// Activate when Sanlyn starts onboarding proxy-buyer salespeople.
//
// Trigger:  GET /api/db/commission-report?month=2026-04
// Auth:     admin / finance only
//
// Input:
//   month  — "YYYY-MM" (defaults to last month)
//
// Output:
//   rows: [{
//     username, company,
//     commissionRate,
//     paidOrderCount,
//     paidSales,          // sum of settled order totals in the window
//     commissionDue,      // paidSales * commissionRate
//     currency,
//     orders: [{ orderNo, totalAmount, settledAt }]
//   }]
//
// ═══════════════════════════════════════════════════════════════
// OPEN QUESTIONS — resolve before activating
// ═══════════════════════════════════════════════════════════════
//
// 1. Rate snapshotting
//    If an account's commissionRate changes mid-period, do we use
//    the rate at order creation, at settlement, or at report time?
//    Simplest: rate at report time. Safest: snapshot to orders.raw
//    at creation time.
//
// 2. "Settled" definition
//    - For prepay_100:              settledAt = payment received
//    - For prepay_30_balance_bl:    settledAt = final 70% received
//    - For cod_on_arrival / net_30: settledAt = full payment received
//    Stored on orders.raw.paymentSettledAt (not yet populated).
//
// 3. Account → Orders join key
//    Current schema: accounts.raw.companyCode  ←→  orders.company_code
//    Works for 1 salesperson : 1 companyCode. Breaks when one
//    salesperson resells to multiple end customers under different
//    codes. In that case we need orders.raw.resellerAccount field
//    on every order, set at creation time.
//
// 4. Currency
//    Commission payable in which currency? Orders may be USD/CNY/MYR.
//    Decision needed: pay commission in (a) order currency, or
//    (b) converted to reseller's preferred currency using month-end FX.
//
// 5. Clawback on refunds / overdue
//    If an order is later refunded or marked overdue, commission
//    already paid must be clawed back. Report needs a
//    "adjustments" section for prior-month corrections.
//
// ═══════════════════════════════════════════════════════════════
// REFERENCE SQL (to adapt when activating)
// ═══════════════════════════════════════════════════════════════
/*
SELECT
  a.username,
  a.company,
  (a.raw->>'commissionRate')::numeric           AS rate,
  COUNT(o.id)                                    AS paid_order_count,
  SUM(o.total_amount)                            AS paid_sales,
  SUM(o.total_amount * (a.raw->>'commissionRate')::numeric) AS commission_due,
  o.currency
FROM accounts a
JOIN orders o ON o.company_code = a.raw->>'companyCode'
WHERE (a.raw->>'isReseller')::boolean = true
  AND o.raw->>'paymentStatus' = 'paid'
  AND (o.raw->>'paymentSettledAt')::timestamp >= $1::timestamp
  AND (o.raw->>'paymentSettledAt')::timestamp <  $2::timestamp
GROUP BY a.username, a.company, a.raw, o.currency
HAVING SUM(o.total_amount * (a.raw->>'commissionRate')::numeric) > 0
ORDER BY commission_due DESC;
*/

export default async function handler(req, res) {
  return res.status(501).json({
    error: "not implemented yet",
    memo:  "See comments in api/db/commission-report.js for schema, open questions, and reference SQL. Activate when resellers onboard.",
  });
}
