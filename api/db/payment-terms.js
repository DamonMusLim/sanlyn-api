import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/payment-terms — manage payment_term per order
//
// GET    ?order_id=<id>            — current term + history
// GET    ?status=pending           — list orders awaiting term agreement
// POST   { order_id, term, note }  — factory/trader proposes a term
// POST   { order_id, action: 'approve'|'reject', note }  — admin decision
//
// Side effects (full automation):
//   PROPOSE  → INSERT thread_event (price_change · payment_term_proposed)
//   APPROVE  → INSERT thread_event + UPDATE finance_records.due_date
//              (computed from term's dueOffsetDays)
//   REJECT   → INSERT thread_event
// ═══════════════════════════════════════════════════════════════

var VALID_TERMS = [
  'tt_30_70', 'tt_full', 'tt_balance_bl',
  'monthly_30', 'monthly_60',
  'invoice_30', 'invoice_60',
  'cod', 'lc_at_sight', 'custom',
];

// Mirror of frontend paymentTerms.js — keep in sync
var TERM_OFFSET_DAYS = {
  tt_30_70: 0, tt_full: 0, tt_balance_bl: 7,
  monthly_30: 30, monthly_60: 60,
  invoice_30: 30, invoice_60: 60,
  cod: 0, lc_at_sight: 0, custom: null,
};

var TERM_LABEL = {
  tt_30_70: 'TT 30/70', tt_full: 'TT 100% advance', tt_balance_bl: 'Deposit + B/L',
  monthly_30: '月结 30', monthly_60: '月结 60',
  invoice_30: '票结 30', invoice_60: '票结 60',
  cod: 'COD', lc_at_sight: 'L/C at sight', custom: 'Custom',
};

const SANLYN_COMPANY_ID = 27;

// Insert a thread_event tied to this order's company + counterparty
async function _writeThreadEvent(pool, order, type, title, detail, actorLabel, metadata) {
  try {
    const cust = await pool.query(
      `SELECT id FROM customers WHERE company_code = $1 LIMIT 1`,
      [order.company_code]
    );
    const counterpartyId = cust.rowCount ? cust.rows[0].id : null;
    if (!counterpartyId) return;
    await pool.query(
      `INSERT INTO thread_events
        (company_id, counterparty_id, type, title, detail, related_order_no,
         actor_label, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        SANLYN_COMPANY_ID, counterpartyId,
        type, title, detail || '',
        order.contract_no || order.order_no || '',
        actorLabel || 'system',
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (e) {
    console.warn("[payment-terms] thread_event write failed:", e.message);
    /* non-fatal */
  }
}

// On approve: update finance_records due_date based on term offset
async function _updateFinanceDueDate(pool, order) {
  const offset = TERM_OFFSET_DAYS[order.payment_term];
  if (offset == null) return; // 'custom' or unknown — skip auto-calc
  try {
    const orderNo = order.contract_no || order.order_no;
    if (!orderNo) return;
    // Compute due date = order.created_at + offset days (or NOW + offset for safety)
    await pool.query(
      `UPDATE finance_records
       SET due_date = COALESCE(invoice_date, NOW())::date + $1::int,
           updated_at = NOW()
       WHERE order_no = $2 AND due_date IS NULL`,
      [offset, orderNo]
    );
  } catch (e) {
    console.warn("[payment-terms] due_date update failed:", e.message);
    /* non-fatal — finance_records may not have this column / order_no */
  }
}

// Close any open task for this order's payment-term confirmation
async function _closeTermTask(pool, orderId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `WITH candidates AS (
         SELECT id, status
           FROM tasks
          WHERE owner_object_type = 'order'
            AND owner_object_id = $1
            AND task_type = 'payment_term_confirm'
            AND status = 'open'
          FOR UPDATE
       ), event_rows AS (
         INSERT INTO task_events (
           task_id, event_type, actor_type, actor_id,
           from_status, to_status, note, metadata, created_at
         )
         SELECT id, 'done', 'system', 'payment-terms',
                status, 'done',
                '付款条款确认通过,自动关闭付款条款确认任务 order_id=' || $1,
                jsonb_build_object('order_id', $1::text, 'task_type', 'payment_term_confirm'),
                NOW()
           FROM candidates
         RETURNING task_id
       )
       UPDATE tasks t
          SET status = 'done', closed_at = NOW(), updated_at = NOW()
         FROM event_rows e
        WHERE t.id = e.task_id`,
      [String(orderId)]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(function() {});
    /* non-fatal */
  } finally {
    client.release();
  }
}

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
                   RETURNING id, contract_no, order_no, company_code, company_name_en,
                             payment_term, payment_term_status, payment_term_note`;
        var r = await pool.query(sql, [newStatus, note || '', user_id || null, parseInt(order_id)]);
        if (!r.rowCount) return res.status(404).json({ success: false, error: "order not found" });
        const updated = r.rows[0];

        const termLabel = TERM_LABEL[updated.payment_term] || updated.payment_term;
        if (action === "approve") {
          await _writeThreadEvent(pool, updated,
            'price_change',
            `✓ Payment term approved: ${termLabel}`,
            note || `Sanlyn approved payment term: ${termLabel}`,
            'Sanlyn admin',
            { event: 'payment_term_approved', term: updated.payment_term, status: 'approved' });
          await _updateFinanceDueDate(pool, updated);
          await _closeTermTask(pool, updated.id);
        } else {
          await _writeThreadEvent(pool, updated,
            'price_change',
            `✗ Payment term rejected: ${termLabel}`,
            note || `Sanlyn rejected payment term — please re-propose`,
            'Sanlyn admin',
            { event: 'payment_term_rejected', term: updated.payment_term, status: 'rejected' });
        }
        return res.status(200).json({ success: true, data: updated });
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
                  RETURNING id, contract_no, order_no, company_code, company_name_en,
                            payment_term, payment_term_status`;
      var r2 = await pool.query(sql2, [term, note || '', user_id || null, parseInt(order_id)]);
      if (!r2.rowCount) return res.status(404).json({ success: false, error: "order not found" });
      const proposed = r2.rows[0];
      const termLabel = TERM_LABEL[proposed.payment_term] || proposed.payment_term;
      await _writeThreadEvent(pool, proposed,
        'price_change',
        `✋ Payment term proposed: ${termLabel}`,
        note || `Factory/trader proposed: ${termLabel}. Awaiting Sanlyn approval.`,
        'Factory',
        { event: 'payment_term_proposed', term: proposed.payment_term, status: 'proposed' });
      return res.status(200).json({ success: true, data: proposed });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[payment-terms] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
