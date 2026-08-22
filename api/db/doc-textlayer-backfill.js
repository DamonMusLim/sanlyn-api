// api/db/doc-textlayer-backfill.js
// Controlled, manual/cron-friendly backfill runner for historical PDF text layers.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { processDoc } from "./doc-textlayer.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function authUser(req, auth) {
  return auth && typeof auth === "object" ? auth : (req.user || req.auth || req.session?.user || {});
}

function rolesOf(user) {
  const roles = [];
  for (const key of ["role", "user_role", "account_role"]) {
    if (user && user[key]) roles.push(user[key]);
  }
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  if (Array.isArray(user?.permissions)) roles.push(...user.permissions);
  return roles.map(v => text(v).toLowerCase()).filter(Boolean);
}

function canReview(user) {
  if (user?.is_admin === true || user?.admin === true) return true;
  return rolesOf(user).some(r => r === "admin" || r === "finance" || r === "finance_admin" || r === "accounting");
}

function limitOf(v) {
  if (v == null || v === "") return 10;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    const err = new Error("limit_must_be_1_to_50");
    err.status = 400;
    throw err;
  }
  return n;
}

async function stats(pool) {
  const totalsQ = await pool.query(
    `SELECT
        COUNT(*)::int AS pdf_total,
        COUNT(*) FILTER (WHERE ocr_raw->'textlayer' IS NOT NULL)::int AS textlayer_done,
        COUNT(*) FILTER (
          WHERE ocr_raw->'textlayer' IS NULL
            AND COALESCE(url,'') NOT ILIKE 'file://%'
        )::int AS pending,
        COUNT(*) FILTER (
          WHERE ocr_raw->'textlayer' IS NULL
            AND COALESCE(url,'') ILIKE 'file://%'
        )::int AS legacy_file_url_pending
       FROM document_uploads
      WHERE mime='application/pdf' OR url ILIKE '%.pdf'`
  );
  const statusQ = await pool.query(
    `SELECT
        CASE
          WHEN ocr_raw->'textlayer'->>'status' IS NOT NULL THEN ocr_raw->'textlayer'->>'status'
          WHEN COALESCE(url,'') ILIKE 'file://%' THEN 'legacy_file_url'
          ELSE 'missing_textlayer'
        END AS status,
        COUNT(*)::int AS count
       FROM document_uploads
      WHERE mime='application/pdf' OR url ILIKE '%.pdf'
      GROUP BY 1
      ORDER BY count DESC, status ASC`
  );
  const byStatus = {};
  for (const row of statusQ.rows) byStatus[row.status] = row.count;
  return { success: true, ...totalsQ.rows[0], status_counts: byStatus };
}

async function run(pool, rawLimit) {
  const limit = limitOf(rawLimit);
  const q = await pool.query(
    `SELECT id
       FROM document_uploads
      WHERE (mime='application/pdf' OR url ILIKE '%.pdf')
        AND ocr_raw->'textlayer' IS NULL
        AND COALESCE(url,'') NOT ILIKE 'file://%'
      ORDER BY uploaded_at ASC NULLS FIRST, id ASC
      LIMIT $1`,
    [limit]
  );

  const results = [];
  const statusCounts = {};
  for (const row of q.rows) {
    const result = await processDoc(pool, { doc_upload_id: row.id });
    results.push(result);
    const status = result.status || result.textlayer?.status || result.skipped || result.error || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  return {
    success: true,
    requested_limit: limit,
    selected: q.rows.length,
    processed: results.length,
    status_counts: statusCounts,
    results,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  let auth = null;
  try {
    auth = requireAuth(req, res);
    if (auth === false || res.headersSent) return;
  } catch (e) {
    return send(res, e.status || 401, { success: false, error: e.message || "unauthorized" });
  }
  const user = authUser(req, auth);
  if (!canReview(user)) return send(res, 403, { success: false, error: "finance_or_admin_required" });

  const pool = getPool();
  try {
    if (req.method === "GET") {
      if (req.query?.action !== "stats") return send(res, 400, { success: false, error: "unknown_action" });
      return send(res, 200, await stats(pool));
    }
    if (req.method !== "POST") return send(res, 405, { success: false, error: "method_not_allowed" });

    const body = req.body || {};
    if (body.action === "run") return send(res, 200, await run(pool, body.limit));
    return send(res, 400, { success: false, error: "unknown_action" });
  } catch (e) {
    return send(res, e.status || 500, { success: false, error: e.message || "server_error" });
  }
}
