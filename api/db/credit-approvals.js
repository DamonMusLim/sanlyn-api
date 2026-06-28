// ──────────────────────────────────────────────────────────────
// credit-approvals.js — admin review queue for over-limit orders
//
// GET:  list orders with raw.credit.creditApprovalStatus = 'pending'
// POST: action = "approve" | "reject"
//        body: { orderNo, action, note? }
//        - approve: sets creditApprovalStatus='approved' + records admin
//        - reject:  sets creditApprovalStatus='rejected'  + records admin + note
//                   and sets status='cancelled' so it won't enter production
//
// Auth: admin only
// ──────────────────────────────────────────────────────────────

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { rows } = await pool.query(`
        SELECT order_no, contract_no, company_code,
               company_name_cn, company_name_en,
               total_amount, currency, status,
               created_at, raw
        FROM orders
        WHERE raw->'credit'->>'creditApprovalStatus' = 'pending'
        ORDER BY created_at DESC
        LIMIT 200
      `);
      return res.status(200).json({ ok: true, data: rows });
    } catch (e) {
      console.error("[credit-approvals GET]", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { orderNo, action, note } = req.body || {};
      if (!orderNo)                             return res.status(400).json({ error: "orderNo required" });
      if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve|reject" });

      const q = await pool.query("SELECT raw, status FROM orders WHERE order_no = $1", [orderNo]);
      if (!q.rows.length) return res.status(404).json({ error: "order not found" });

      const raw = q.rows[0].raw || {};
      const credit = raw.credit || {};
      if (credit.creditApprovalStatus !== "pending") {
        return res.status(409).json({ error: "order is not pending credit approval", currentStatus: credit.creditApprovalStatus });
      }

      const now = new Date().toISOString();
      const newCredit = Object.assign({}, credit, {
        creditApprovalStatus: action === "approve" ? "approved" : "rejected",
        creditApprovalBy:     req.user.username || req.user.id || "admin",
        creditApprovalAt:     now,
        creditApprovalNote:   note || null,
      });
      const newRaw = Object.assign({}, raw, { credit: newCredit });

      if (action === "reject") {
        await pool.query(
          "UPDATE orders SET raw = $1, status = 'cancelled' WHERE order_no = $2",
          [JSON.stringify(newRaw), orderNo]
        );
      } else {
        await pool.query(
          "UPDATE orders SET raw = $1 WHERE order_no = $2",
          [JSON.stringify(newRaw), orderNo]
        );
      }

      return res.status(200).json({ ok: true, orderNo, action, credit: newCredit });
    } catch (e) {
      console.error("[credit-approvals POST]", e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
