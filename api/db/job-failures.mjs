import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { resolvePerson } from "./authz.js";
import { reportFailure } from "./lib/report-failure.mjs";

const VIEW_CAPS = new Set(["ops.failures.view", "store.dashboard.view", "boss.dashboard.view"]);

async function canView(req, pool) {
  if (["admin", "boss", "system"].includes(req.user?.role)) return true;
  const person = await resolvePerson(req, { pool, audit: false });
  return !!person?.caps?.some((cap) => VIEW_CAPS.has(cap));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  try {
    if (req.method === "POST") {
      await reportFailure(req.body?.source, new Error(req.body?.error || "failure"), req.body?.context || {}, { pool });
      return res.status(200).json({ success: true });
    }

    if (!(await canView(req, pool))) {
      return res.status(403).json({ success: false, error: "权限不足" });
    }

    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      const status = String(req.body?.status || "");
      if (!id || !["acknowledged", "resolved"].includes(status)) {
        return res.status(400).json({ success: false, error: "id + status required" });
      }
      const actor = req.user?.username || req.user?.account || req.user?.sub || "unknown";
      const r = await pool.query(
        `UPDATE job_failures
            SET status=$2,
                acknowledged_at=CASE WHEN $2='acknowledged' THEN now() ELSE acknowledged_at END,
                acknowledged_by=CASE WHEN $2='acknowledged' THEN $3 ELSE acknowledged_by END
          WHERE id=$1 RETURNING *`,
        [id, status, actor]
      );
      return res.status(r.rowCount ? 200 : 404).json({ success: !!r.rowCount, data: r.rows[0] || null });
    }

    if (req.method === "GET") {
      const status = String(req.query?.status || "open");
      const lim = Math.min(Number(req.query?.limit) || 50, 200);
      const r = await pool.query(
        `SELECT id, source, impact, error_name, error_message, context, status,
                first_seen_at, last_seen_at, seen_count, acknowledged_at, acknowledged_by
           FROM job_failures
          WHERE ($1='' OR status=$1)
          ORDER BY last_seen_at DESC LIMIT $2`,
        [status === "all" ? "" : status, lim]
      );
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    }

    return res.status(405).json({ success: false, error: "GET/POST/PATCH only" });
  } catch (err) {
    await reportFailure("job-failures.endpoint", err, { impact: "失败看板接口不可用", method: req.method }, { pool });
    return res.status(500).json({ success: false, error: err.message });
  }
}
