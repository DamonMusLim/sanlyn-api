// order-tasks.js — CRUD for order_tasks (v3.2 §6.2)
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

function getCompanyCodes(req, res) {
  const role = req.user?.role;
  if (role === "admin" || role === "system") return null;
  const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
  if (!codes || codes.length === 0) {
    res.status(403).json({ error: "Account scope missing — please log out and log in again." });
    return false;
  }
  return codes;
}

async function orderBelongsToCaller(pool, order_id, codes, res) {
  if (codes === null) return true;
  const r = await pool.query(
    `SELECT 1 FROM orders WHERE id = $1
      AND (company_code = ANY($2::text[])
           OR raw->>'companyCode' = ANY($2::text[])
           OR raw->>'factoryCompanyCode' = ANY($2::text[]))
     LIMIT 1`,
    [order_id, codes]
  );
  if (r.rowCount === 0) {
    res.status(403).json({ error: "Forbidden: order not in your account scope." });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req); // populate req.user if authMiddleware hasn't run (serverless path)

  const pool = getPool();
  const codes = getCompanyCodes(req, res);
  if (codes === false) return;

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const { action, order_id, assigned_to } = req.query;

      if (!action || action === "list") {
        // Require at least one filter to prevent unbounded scans
        if (!order_id && !assigned_to) {
          return res.status(400).json({ error: "order_id or assigned_to required" });
        }
        if (order_id && !(await orderBelongsToCaller(pool, order_id, codes, res))) return;

        // Always join to orders so company scope is enforced at the query level
        const params = [];
        let extraWhere = "";

        if (order_id) {
          params.push(order_id);
          extraWhere += ` AND ot.order_id = $${params.length}`;
        }

        // assigned_to=ME: filter by caller's uid and role
        if (assigned_to === "ME" && req.user) {
          const uid  = req.user.uid?.toString();
          const role = req.user.role;
          params.push(uid);
          params.push(role);
          extraWhere += ` AND (ot.assigned_user_id = $${params.length - 1} OR ot.assigned_role = $${params.length})`;
        } else if (assigned_to && assigned_to !== "ME") {
          params.push(assigned_to);
          extraWhere += ` AND ot.assigned_user_id = $${params.length}`;
        }

        // Company scope: join to orders and filter — admins get all
        let scopeJoin = "";
        if (codes !== null) {
          params.push(codes);
          scopeJoin = `JOIN orders o ON o.id = ot.order_id
                         AND (o.company_code = ANY($${params.length}::text[])
                              OR o.raw->>'companyCode' = ANY($${params.length}::text[])
                              OR o.raw->>'factoryCompanyCode' = ANY($${params.length}::text[]))`;
        }

        const r = await pool.query(
          `SELECT ot.* FROM order_tasks ot ${scopeJoin}
            WHERE 1=1 ${extraWhere}
            ORDER BY ot.due_at ASC NULLS LAST, ot.id ASC`,
          params
        );
        return res.status(200).json({ data: r.rows, count: r.rowCount });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    // ── POST — create task ─────────────────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.order_id)      return res.status(400).json({ error: "order_id required" });
      if (!(await orderBelongsToCaller(pool, b.order_id, codes, res))) return;
      if (!b.task_key)      return res.status(400).json({ error: "task_key required" });
      if (!b.assigned_role) return res.status(400).json({ error: "assigned_role required" });

      const r = await pool.query(
        `INSERT INTO order_tasks
           (order_id, task_key, assigned_role, assigned_company_id, assigned_user_id,
            due_at, status, source_event_id, action_route, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          b.order_id,
          b.task_key,
          b.assigned_role,
          b.assigned_company_id || null,
          b.assigned_user_id    || null,
          b.due_at              || null,
          b.status              || "open",
          b.source_event_id     || null,
          b.action_route        || null,
          b.meta ? JSON.stringify(b.meta) : null,
        ]
      );
      return res.status(201).json({ data: r.rows[0] });
    }

    // ── PATCH — status change + optional reassign ──────────────────────────
    if (req.method === "PATCH") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });

      // Verify ownership via the task's order
      if (codes !== null) {
        const tk = await pool.query(`SELECT order_id FROM order_tasks WHERE id = $1`, [id]);
        if (tk.rowCount === 0) return res.status(404).json({ error: "task not found" });
        if (!(await orderBelongsToCaller(pool, tk.rows[0].order_id, codes, res))) return;
      }

      const b = req.body || {};
      const sets = [];
      const vals = [];

      const allowed_statuses = ["open", "in_progress", "done", "cancelled", "blocked"];
      if (b.status) {
        if (!allowed_statuses.includes(b.status)) {
          return res.status(400).json({ error: `status must be one of: ${allowed_statuses.join(", ")}` });
        }
        vals.push(b.status);
        sets.push(`status = $${vals.length}`);
      }
      if (b.assigned_user_id !== undefined) {
        vals.push(b.assigned_user_id);
        sets.push(`assigned_user_id = $${vals.length}`);
      }
      if (b.assigned_company_id !== undefined) {
        vals.push(b.assigned_company_id);
        sets.push(`assigned_company_id = $${vals.length}`);
      }
      if (b.due_at !== undefined) {
        vals.push(b.due_at);
        sets.push(`due_at = $${vals.length}`);
      }

      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });

      vals.push(id);
      const r = await pool.query(
        `UPDATE order_tasks SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "task not found" });
      return res.status(200).json({ data: r.rows[0] });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
