import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

// Driver reviews — STRICTLY private per rater_company_id.
//
// POST /api/db/driver-reviews
//   body: { driver_id, rating, comment, flags?, order_id? }
//   • rater_role  = req.user.role
//   • rater_company_id = req.user.companyId  ← server-side, NOT from body
//
// GET  /api/db/driver-reviews?driver_id=N
//   → only returns reviews where rater_company_id = caller's companyId.
//   → admin sees ALL reviews for the driver (audit/compliance).
//
// Rule: a customer never sees the factory's reviews of a driver, and
// vice versa. Each company sees only its own reviews. This is enforced
// in SQL WHERE clause (server-side), not UI.

function callerCompanyId(req) {
  // Try multiple shapes (depending on JWT payload conventions in this codebase)
  const u = req?.user || {};
  return u.companyId || u.company_id || u.companyCode || u.company_code || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  const cid = callerCompanyId(req);
  const pool = getPool();
  const isAdmin = isInternalRole(role);

  try {
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.driver_id || !b.rating) return sendError(res, 400, "driver_id_and_rating_required");
      const rating = parseInt(b.rating);
      if (!(rating >= 1 && rating <= 5)) return sendError(res, 400, "rating_out_of_range");
      if (!isAdmin && !cid) return sendError(res, 400, "no_company_context");

      const flags = Array.isArray(b.flags) ? b.flags : [];
      const order_id = b.order_id != null ? parseInt(b.order_id) : null;

      const ins = await pool.query(
        `INSERT INTO driver_reviews
           (driver_id, rater_role, rater_company_id, order_id, rating, comment, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
         RETURNING id, driver_id, rater_role, order_id, rating, comment, flags, created_at`,
        [parseInt(b.driver_id), role, cid, order_id, rating, b.comment || null, flags]
      );

      // Recompute aggregates for the driver (cheap; small dataset)
      // Internal sees aggregates from ALL reviews; for fairness we also recompute total here.
      await pool.query(
        `UPDATE drivers
            SET rating_avg   = sub.avg_r,
                rating_count = sub.cnt
           FROM (SELECT AVG(rating)::NUMERIC(3,2) AS avg_r, COUNT(*)::INT AS cnt
                   FROM driver_reviews WHERE driver_id = $1) sub
          WHERE drivers.id = $1`,
        [parseInt(b.driver_id)]
      );

      return res.status(201).json({ data: ins.rows[0] });
    }

    if (req.method === "GET") {
      const driver_id = req.query?.driver_id;
      if (!driver_id) return sendError(res, 400, "driver_id_required");

      let sql, vals;
      if (isAdmin) {
        // Admin sees everything
        sql = `SELECT id, driver_id, rater_role, rater_company_id, order_id, rating, comment, flags, created_at
                 FROM driver_reviews
                WHERE driver_id = $1
                ORDER BY created_at DESC LIMIT 200`;
        vals = [parseInt(driver_id)];
      } else {
        if (!cid) return sendError(res, 400, "no_company_context");
        // External callers: STRICT same-company filter — never see other companies' reviews
        sql = `SELECT id, driver_id, rater_role, order_id, rating, comment, flags, created_at
                 FROM driver_reviews
                WHERE driver_id = $1 AND rater_company_id = $2
                ORDER BY created_at DESC LIMIT 200`;
        vals = [parseInt(driver_id), cid];
      }
      const r = await pool.query(sql, vals);
      return res.status(200).json({ data: r.rows });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[driver-reviews] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
