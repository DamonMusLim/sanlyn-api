import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 供应商资料 —— 从果冻橙拉来的 162 家。
//
// 🔴 付款资料红线:bank_no / opening_name / open_bank_name / tax_no / invoice_header
//    在库里,但【一律不出接口】。供应商的银行账号是打钱用的,跟成本同级。
//    页面上那几列会如实空着。
//
// 🩸 实测:162 家里只有 1 家有联系电话、0 家有银行账号 ——
//    果冻橙那边的供应商资料也基本是空的。这正是「让供应商自己补」要解决的问题。
const SETTLE = Object.assign(Object.create(null), {
  0: "未设置", 1: "货到付款", 2: "月结", 3: "预付", 4: "账期",
});

function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }

async function list(q) {
  const page = Math.max(1, Number(q?.page) || 1);
  const pageSize = Math.min(300, Math.max(1, Number(q?.pageSize) || 20));
  const sql = `
    WITH filtered AS (
      SELECT s.supplier_code, s.supplier_name, s.stream_type, s.channel,
             s.settlement_type, s.month_settle_day, s.total_counts,
             s.contact_name, s.contact_phone, s.address, s.remark,
             s.enable, s.state_flag, s.is_default, s.all_qual_valid,
             s.delivery_pct, s.rebate_pct, s.create_time, s.update_time,
             -- ⛔ bank_no / opening_name / open_bank_name / tax_no / invoice_header
             --    故意不 SELECT:那是打钱用的付款资料
             CASE s.stream_type WHEN 1 THEN '客户' ELSE '供应商' END AS stream_label,
             CASE WHEN s.enable = 0 AND s.state_flag = 0 THEN '正常' ELSE '停用' END AS status_label,
             -- 资料齐不齐:能不能联系上,是「同时发送」的硬前置
             (btrim(COALESCE(s.contact_phone, '')) <> '') AS has_phone,
             (btrim(COALESCE(s.contact_name, '')) <> '')  AS has_contact,
             -- 我们这边有没有跟它发生过采购(和补货那条线对上)
             (SELECT COUNT(*)::int FROM public.petstore_gdc_suggest g
               WHERE g.supplier_code = s.supplier_code) AS suggest_cnt
        FROM public.petstore_gdc_suppliers s
       WHERE ($1::int IS NULL OR s.stream_type = $1)
         AND ($2::text IS NULL OR s.supplier_name ILIKE '%' || $2 || '%'
              OR s.supplier_code ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL
              OR ($3 = 'no_phone'  AND btrim(COALESCE(s.contact_phone,'')) = '')
              OR ($3 = 'has_phone' AND btrim(COALESCE(s.contact_phone,'')) <> ''))
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY total_counts DESC NULLS LAST, supplier_code) AS __rn
        FROM filtered ORDER BY total_counts DESC NULLS LAST, supplier_code
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.supplier_code IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const st = q?.stream_type != null && q.stream_type !== "" ? Number(q.stream_type) : null;
  const r = await getPool().query(sql, [
    Number.isInteger(st) ? st : null, clean(q?.q, 60), clean(q?.filter, 20),
    pageSize, (page - 1) * pageSize,
  ]);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize, settle_labels: SETTLE };
}

// 资料完整度 —— 「同时发送」能不能做，看的就是这个
async function summary() {
  const r = await getPool().query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE stream_type = 0)::int AS suppliers,
            COUNT(*) FILTER (WHERE stream_type = 1)::int AS customers,
            COUNT(*) FILTER (WHERE btrim(COALESCE(contact_phone,'')) <> '')::int AS has_phone,
            COUNT(*) FILTER (WHERE btrim(COALESCE(contact_name,''))  <> '')::int AS has_contact,
            COUNT(*) FILTER (WHERE total_counts > 0)::int AS has_products
       FROM public.petstore_gdc_suppliers`);
  const s = r.rows[0] || {};
  return {
    rows: [{ ...s, no_phone: (s.total || 0) - (s.has_phone || 0),
             hint: "没有联系方式就发不出订货单 —— 这是「一次发多家」的硬前置" }],
    total: 1,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    if (String(req.query?.scope ?? "") === "summary") return json(res, 200, await summary());
    return json(res, 200, await list(req.query || {}));
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
