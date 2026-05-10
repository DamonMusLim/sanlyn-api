// order-events.js — CRUD for order_events (v3.2 §6.1)
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

// Returns null if caller is admin/system (full access), else returns the
// company_code array for the authenticated user. Responds 403 if scope missing.
function getCompanyCodes(req, res) {
  const role = req.user?.role;
  if (role === "admin" || role === "system") return null; // skip scoping
  const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
  if (!codes || codes.length === 0) {
    res.status(403).json({ error: "Account scope missing — please log out and log in again." });
    return false;
  }
  return codes;
}

// Verifies that an order_id belongs to the caller's company (for non-admin).
// Returns true if allowed, false if forbidden (response already sent).
async function orderBelongsToCaller(pool, order_id, codes, res) {
  if (codes === null) return true; // admin bypass
  // Match the same scope as the main orders list: company_code, raw.companyCode, raw.factoryCompanyCode
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
  if (codes === false) return; // 403 already sent

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const { action, order_id, stage_key, event_group } = req.query;

      if (!action || action === "list") {
        if (!order_id) return res.status(400).json({ error: "order_id required" });
        if (!(await orderBelongsToCaller(pool, order_id, codes, res))) return;

        let sql = `
          SELECT * FROM order_events
          WHERE order_id = $1
        `;
        const params = [order_id];

        // Factory portal users only see milestone/logistics/negotiation events —
        // not finance, customs, or ocean events that expose BL/vessel data.
        // 'production' is not a valid event_group per §6.1 CHECK constraint; use milestone.
        if (req.user?.role === "factory") {
          params.push(["milestone", "logistics", "negotiation"]);
          sql += ` AND (event_group = ANY($${params.length}::text[]) OR event_group IS NULL)`;
        }

        if (stage_key) {
          params.push(stage_key);
          sql += ` AND stage_key = $${params.length}`;
        }
        if (event_group) {
          params.push(event_group);
          sql += ` AND event_group = $${params.length}`;
        }

        sql += ` ORDER BY occurred_at ASC, id ASC`;

        const r = await pool.query(sql, params);
        return res.status(200).json({ data: r.rows, count: r.rowCount });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    // ── POST — create event ────────────────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.order_id) return res.status(400).json({ error: "order_id required" });
      if (!b.stage_key) return res.status(400).json({ error: "stage_key required" });
      if (!b.occurred_at) return res.status(400).json({ error: "occurred_at required" });
      if (!(await orderBelongsToCaller(pool, b.order_id, codes, res))) return;

      const actor_role       = b.actor_role       || req.user?.role        || null;
      const actor_company_id = b.actor_company_id || req.user?.companyCode || null;
      const actor_user_id    = b.actor_user_id    || req.user?.uid?.toString() || null;
      const event_group      = b.event_group      || null;
      const sequence_no      = b.sequence_no      || 1;

      // For negotiation events: flip previous is_current=false and insert atomically
      // so a failed insert never leaves the order with no current negotiation event.
      const insertVals = [
        b.order_id, b.stage_key, event_group, sequence_no,
        b.is_current !== undefined ? b.is_current : true,
        b.occurred_at, actor_role, actor_company_id, actor_user_id,
        b.source || "manual",
        b.visibility_scope ? JSON.stringify(b.visibility_scope) : null,
        b.confidence || null,
        b.status || "active",
        b.meta ? JSON.stringify(b.meta) : null,
      ];
      let newRow;
      if (event_group === "negotiation") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE order_events SET is_current = FALSE
               WHERE order_id = $1 AND stage_key = $2 AND is_current = TRUE AND event_group = 'negotiation'`,
            [b.order_id, b.stage_key]
          );
          const ins = await client.query(
            `INSERT INTO order_events
               (order_id, stage_key, event_group, sequence_no, is_current,
                occurred_at, actor_role, actor_company_id, actor_user_id,
                source, visibility_scope, confidence, status, meta)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING *`,
            insertVals
          );
          await client.query("COMMIT");
          newRow = ins.rows[0];
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      } else {
        const ins = await pool.query(
          `INSERT INTO order_events
             (order_id, stage_key, event_group, sequence_no, is_current,
              occurred_at, actor_role, actor_company_id, actor_user_id,
              source, visibility_scope, confidence, status, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          insertVals
        );
        newRow = ins.rows[0];
      }
      return res.status(201).json({ data: newRow });
    }

    // ── PATCH — status change only (active → corrected/superseded/revoked) ─
    if (req.method === "PATCH") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });

      // Verify caller owns the order this event belongs to
      if (codes !== null) {
        const ev = await pool.query(`SELECT order_id FROM order_events WHERE id = $1`, [id]);
        if (ev.rowCount === 0) return res.status(404).json({ error: "event not found" });
        if (!(await orderBelongsToCaller(pool, ev.rows[0].order_id, codes, res))) return;
      }

      const b = req.body || {};
      const allowed = ["corrected", "revoked", "superseded"];
      if (!b.status || !allowed.includes(b.status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
      }

      const r = await pool.query(
        `UPDATE order_events SET status = $1 WHERE id = $2 RETURNING *`,
        [b.status, id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "event not found" });
      return res.status(200).json({ data: r.rows[0] });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
