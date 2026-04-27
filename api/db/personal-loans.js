// api/db/personal-loans.js
// 个人借款 CRUD + 批量导入

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  var pool = getPool();
  var owner = "damon";

  // ── GET: 拉取借款 + 收款明细 + 汇总 ────────────────────
  if (req.method === "GET") {
    var { rows: loans } = await pool.query(
      `SELECT * FROM personal_loans WHERE owner = $1 ORDER BY start_date DESC`,
      [owner]
    );

    var { rows: payments } = await pool.query(
      `SELECT * FROM personal_loan_payments
       WHERE loan_id IN (SELECT id FROM personal_loans WHERE owner = $1)
       ORDER BY expected_date DESC`,
      [owner]
    );

    // 按借款人聚合
    var byBorrower = {};
    loans.forEach(l => {
      var pmts = payments.filter(p => p.loan_id === l.id);
      var received = pmts.filter(p => p.status === "received");
      var overdue  = pmts.filter(p => p.status === "overdue");
      var pending  = pmts.filter(p => p.status === "pending");

      byBorrower[l.borrower_name] = {
        loan: l,
        total_payments: pmts.length,
        received_count: received.length,
        overdue_count: overdue.length,
        pending_count: pending.length,
        received_total: received.reduce((s,p) => s + parseFloat(p.received_amount||p.expected_amount||0), 0),
        overdue_total: overdue.reduce((s,p) => s + parseFloat(p.expected_amount||0), 0),
      };
    });

    return res.status(200).json({ ok: true, loans, payments, byBorrower });
  }

  // ── POST: 批量导入 ─────────────────────────────────────
  if (req.method === "POST" && req.query.action === "bulk-import") {
    var { loans } = req.body || {};
    if (!Array.isArray(loans)) return res.status(400).json({ error: "loans array required" });

    var inserted = 0;
    for (var L of loans) {
      // Upsert loan
      var { rows: [loan] } = await pool.query(
        `INSERT INTO personal_loans
           (owner, borrower_name, principal, monthly_interest, monthly_cost,
            monthly_net, start_date, due_date, bank_source, bank_repay_day, status, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [owner, L.borrower_name, L.principal, L.monthly_interest,
         L.monthly_cost, L.monthly_net, L.start_date, L.due_date,
         L.bank_source || null, L.bank_repay_day || null,
         L.status || "active", L.note || ""]
      );

      // 如果没有返回（已存在），重新查一次拿 id
      if (!loan) {
        var { rows: [existing] } = await pool.query(
          `SELECT id FROM personal_loans
           WHERE owner = $1 AND borrower_name = $2 AND principal = $3`,
          [owner, L.borrower_name, L.principal]
        );
        loan = existing;
      }
      if (!loan) continue;
      inserted++;

      // 插入收款明细
      if (Array.isArray(L.payments)) {
        for (var p of L.payments) {
          await pool.query(
            `INSERT INTO personal_loan_payments
               (loan_id, expected_date, expected_amount, cost, net_profit,
                received_date, received_amount, status, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING`,
            [loan.id, p.expected_date, p.expected_amount, p.cost || 0,
             p.net_profit || 0, p.received_date || null,
             p.received_amount || null, p.status || "pending", p.note || ""]
          );
        }
      }
    }

    return res.status(200).json({ ok: true, inserted });
  }

  // ── POST: 新建单笔借款 ─────────────────────────────────
  if (req.method === "POST") {
    var b = req.body || {};
    var { rows: [row] } = await pool.query(
      `INSERT INTO personal_loans
         (owner, borrower_name, principal, monthly_interest, monthly_cost,
          monthly_net, start_date, due_date, bank_source, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [owner, b.borrower_name, b.principal, b.monthly_interest,
       b.monthly_cost, b.monthly_net, b.start_date, b.due_date || null,
       b.bank_source || null, b.status || "active", b.note || ""]
    );
    return res.status(201).json({ ok: true, data: row });
  }

  // ── PATCH: 更新付款状态（标记已收 / 逾期 等） ──────────
  if (req.method === "PATCH" && req.query.payment_id) {
    var b = req.body || {};
    var { rows: [row] } = await pool.query(
      `UPDATE personal_loan_payments
         SET status = COALESCE($2, status),
             received_date = COALESCE($3, received_date),
             received_amount = COALESCE($4, received_amount),
             note = COALESCE($5, note),
             updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.query.payment_id, b.status, b.received_date, b.received_amount, b.note]
    );
    return res.status(200).json({ ok: true, data: row });
  }

  return res.status(405).end();
}
