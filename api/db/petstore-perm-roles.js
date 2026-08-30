import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paging(query) {
  const page = positiveInt(query?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(query?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function json(res, status, data) {
  return res.status(status).json(data);
}

async function roleMenus(roleId) {
  const result = await getPool().query(
    `SELECT menu_path
       FROM petstore_role_menus
      WHERE role_id = $1
      ORDER BY menu_path`,
    [roleId],
  );
  return result.rows.map((row) => row.menu_path);
}

async function listRows(req) {
  const roleId = positiveInt(req.query?.role_id, 0);
  if (roleId > 0) {
    const rows = await roleMenus(roleId);
    return { rows, total: rows.length, page: 1, pageSize: rows.length };
  }

  const { page, pageSize, offset } = paging(req.query || {});
  const sql = `
    WITH counted AS (
      SELECT r.id, r.role_key, r.role_name, r.description, r.is_builtin,
             r.is_active, r.created_at, r.updated_at,
             COUNT(m.id)::int AS menu_count
        FROM petstore_roles r
        LEFT JOIN petstore_role_menus m ON m.role_id = r.id
       GROUP BY r.id
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM counted
    ), page_rows AS (
      SELECT *
        FROM counted
       ORDER BY is_builtin DESC, id
       LIMIT $1 OFFSET $2
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.id IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;
  const result = await getPool().query(sql, [pageSize, offset]);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { rows: first.rows, total: first.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
