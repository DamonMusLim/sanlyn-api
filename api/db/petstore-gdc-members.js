import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 300;
const CARD_TYPE_TIMES = "times";
const CARD_TYPE_VALUE = "value";

function json(res, status, data) {
  return res.status(status).json(data);
}

function clean(value, max = 80) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveInt(value, fallback, max = 100000) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function paging(query) {
  const page = positiveInt(query?.page ?? query?.pageNum, DEFAULT_PAGE);
  const pageSize = positiveInt(query?.pageSize ?? query?.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function list(query) {
  const { page, pageSize, offset } = paging(query || {});
  const storeCode = clean(query?.store_code, 32);
  const q = clean(query?.q, 80);
  const status = clean(query?.status, 40);

  const sql = `
    WITH filtered AS (
      SELECT store_code, member_no, member_name, member_status,
             balance, integral, accum_amount, accum_qty, accum_integral,
             gdc_id, gdc_create_time, gdc_update_time, pulled_at
        FROM public.petstore_gdc_members
       WHERE ($1::text IS NULL OR store_code = $1)
         AND ($2::text IS NULL OR member_no ILIKE '%' || $2 || '%'
              OR member_name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR member_status = $3)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT f.*,
             string_agg(DISTINCT CONCAT_WS(':', mc.card_no, mc.remaining_times::text), ',')
               FILTER (WHERE ct.card_type = $6) AS card_summary,
             string_agg(DISTINCT CONCAT_WS(':', mc.card_no, mc.remaining_times::text), ',')
               FILTER (WHERE ct.card_type = $7) AS secondary_card_summary,
             string_agg(DISTINCT p.name, ',')
               FILTER (WHERE p.name IS NOT NULL AND p.name <> '') AS pet_summary,
             ROW_NUMBER() OVER (
               ORDER BY f.gdc_create_time DESC NULLS LAST, f.member_no
             ) AS __rn
        FROM filtered f
        LEFT JOIN member_cards mc ON mc.owner_phone = f.member_no
        LEFT JOIN card_templates ct ON ct.id = mc.template_id
        LEFT JOIN pet_profiles p ON p.owner_phone = f.member_no
       GROUP BY f.store_code, f.member_no, f.member_name, f.member_status,
                f.balance, f.integral, f.accum_amount, f.accum_qty, f.accum_integral,
                f.gdc_id, f.gdc_create_time, f.gdc_update_time, f.pulled_at
       ORDER BY f.gdc_create_time DESC NULLS LAST, f.member_no
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.member_no IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;

  const result = await getPool().query(sql, [
    storeCode, q, status, pageSize, offset, CARD_TYPE_VALUE, CARD_TYPE_TIMES
  ]);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { ok: true, rows: first.rows, total: first.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "method_not_allowed" });
    }
    return json(res, 200, await list(req.query || {}));
  } catch {
    return json(res, 500, { ok: false, error: "query_failed" });
  }
}
