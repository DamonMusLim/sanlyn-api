import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/payment-terms — manage payment_term per order
//
// GET    ?order_id=<id>            — current term + history (from raw)
// GET    ?status=pending           — list orders awaiting term agreement
// POST   { order_id, term, note }  — factory/trader proposes a term
// POST   { order_id, action: 'approve'|'reject', note }  — admin decision
// ═══════════════════════════════════════════════════════════════

var VALID_TERMS = [
  'tt_30_70', 'tt_full', 'tt_balance_bl',
  'monthly_30', 'monthly_60',
  'invoice_30', 'invoice_60',
  'cod', 'lc_at_sight', 'custom',
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();

    if (req.method === "GET") {
      var { order_id, status, company_code, limit = 100 } = req.query;
      var conds = [], params = [];
      if (order_id)     { params.push(parseInt(order_id)); conds.push("id = $" + params.length); }
      if (status)       { params.push(status); conds.push("payment_term_status = $" + params.length); }
      if (company_code) { params.push(company_code); conds.push("company_code = $" + params.length); }
      var sql = `SELECT id, contract_no, customer_po, company_code, company_name_en,
                        payment_term, payment_term_status, payment_term_note,
                        payment_term_proposed_by, payment_term_proposed_at,
                        payment_term_approved_by, payment_term_approved_at
                 FROM orders`;
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      sql += " ORDER BY payment_term_proposed_at DESC NULLS LAST, id DESC";
      params.push(parseInt(limit));
      sql += " LIMIT $" + params.length;
      var result = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }

    if (req.method === "POST") {
      var body = req.body || {};
      var { order_id, term, note, action, user_id } = body;
      if (!order_id) return res.status(400).json({ success: false, error: "order_id required" });

      // Admin approval/rejection path
      if (action === "approve" || action === "reject") {
        var newStatus = action === "approve" ? "approved" : "rejected";
        var sql = `UPDATE orders SET
                     payment_term_status = $1,
                     payment_term_note = COALESCE(NULLIF($2, ''), payment_term_note),
                     payment_term_approved_by = $3,
                     payment_term_approved_at = NOW(),
                     updated_at = NOW()
                   WHERE id = $4
                   RETURNING id, payment_term, payment_term_status`;
        var r = await pool.query(sql, [newStatus, note || '', user_id || null, parseInt(order_id)]);
        return res.status(200).json({ success: true, data: r.rows[0] });
      }

      // Factory/trader proposal path
      if (!term || !VALID_TERMS.includes(term)) {
        return res.status(400).json({ success: false, error: "term must be one of " + VALID_TERMS.join(",") });
      }
      var sql2 = `UPDATE orders SET
                    payment_term = $1,
                    payment_term_status = 'proposed',
                    payment_term_note = $2,
                    payment_term_proposed_by = $3,
                    payment_term_proposed_at = NOW(),
                    payment_term_approved_by = NULL,
                    payment_term_approved_at = NULL,
                    updated_at = NOW()
                  WHERE id = $4
                  RETURNING id, payment_term, payment_term_status`;
      var r2 = await pool.query(sql2, [term, note || '', user_id || null, parseInt(order_id)]);
      if (!r2.rowCount) return res.status(404).json({ success: false, error: "order not found" });
      return res.status(200).json({ success: true, data: r2.rows[0] });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[payment-terms] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
