import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/seed-payment-term-tasks — backfill tasks for orders
// that don't yet have a payment_term agreed.
//
// Idempotent: skips orders that already have an open task of
// task_type='payment_term_confirm'.
//
// Run via: curl -X POST https://api.sanlyn.cn/api/db/seed-payment-term-tasks
// Or via cron daily so new orders get tasks created automatically.
// ═══════════════════════════════════════════════════════════════

function _genTaskId() {
  return "t-pt-" + Math.random().toString(36).slice(2, 10);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();

    // Find orders needing a payment-term task
    const candidates = await pool.query(`
      SELECT o.id, o.contract_no, o.order_no, o.customer_po, o.company_code,
             o.company_name_en, o.company_name_cn,
             o.payment_term, o.payment_term_status,
             o.raw->>'factory_code' AS factory_code
      FROM orders o
      WHERE (o.payment_term IS NULL OR o.payment_term_status = 'rejected')
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.owner_object_type = 'order'
            AND t.owner_object_id = o.id::text
            AND t.task_type = 'payment_term_confirm'
            AND t.status = 'open'
        )
      LIMIT 500
    `);

    let created = 0;
    const errors = [];
    for (const o of candidates.rows) {
      try {
        const orderNo = o.contract_no || o.order_no || `Order #${o.id}`;
        const customerName = o.company_name_en || o.company_name_cn || o.company_code || "Customer";
        const taskId = _genTaskId();
        await pool.query(`
          INSERT INTO tasks (
            id, title, task_type, level, status, risk_level,
            owner_object_type, owner_object_id, owner_object_label,
            related_order_no, related_po_no, company_code, factory_company_code,
            mode, due_at, reason, raw
          ) VALUES (
            $1, $2, 'payment_term_confirm', 'order', 'open', 'mid',
            'order', $3, $4,
            $5, $6, $7, $8,
            'owned', NOW() + INTERVAL '3 days', $9, $10::jsonb
          )
        `, [
          taskId,
          `Confirm payment term · ${orderNo}`,
          String(o.id),
          orderNo,
          orderNo, o.customer_po || '', o.company_code || '',
          o.factory_code || null,
          `Order created without an agreed payment term. Factory or trader needs to propose one (TT 30/70, monthly 30, etc.).`,
          JSON.stringify({
            customer: customerName,
            order_id: o.id,
            workflow: 'payment_term',
            cta: { label: 'Propose payment term', open_payment_term_modal: true },
          }),
        ]);
        created++;
      } catch (e) {
        errors.push({ order_id: o.id, error: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      candidates: candidates.rowCount,
      tasks_created: created,
      errors,
      hint: "Re-run anytime; idempotent skips existing open tasks.",
    });
  } catch (err) {
    console.error("[seed-payment-term-tasks] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
