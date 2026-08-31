import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 商品详情(编辑页用) —— 一个商品的全貌:主档 + 全部条码 + 标签 + 供应商条款 + 库存状态。
// 🔴 一品多码是零售常态:进口货有「原装厂商码」+「店内自编码」两个,都能扫都是对的。
// ⛔ 源表有 cost_price/gross_margin/supplier,逐列取,一个都不返回。
//    (供应商条款里的 in_price 也不返回;supplier_name 允许——这是单据/资料类。)
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, m = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function json(res, s, d) { return res.status(s).json(d); }

async function detail(code) {
  const sql = `
    SELECT s.product_code, s.product_name, s.category, s.spec,
           s.out_price, s.stock_num, s.month_sale, s.shelf_list, s.own_brand,
           s.no_sale_months, s.snapshot_date,
           c.product_status, c.shelf_no, c.store_code, c.last_changed_at,
           sup.shelf_life_days, sup.brand, sup.pet_type, sup.compliance_status,
           (SELECT jsonb_agg(jsonb_build_object(
                     'barcode', b.barcode, 'kind', b.code_kind,
                     'is_primary', b.is_primary, 'source', b.source,
                     -- 一品多码照果冻橙的语义:一个条码=一种包装规格
                     -- ⛔ box_in_price(箱进价)是成本,存库可以,接口不许返回
                     'pack_type', b.pack_type, 'pack_qty', b.pack_qty,
                     'box_out_price', b.box_out_price)
                   ORDER BY b.is_primary DESC, b.pack_qty, b.id)
              FROM public.petstore_product_barcodes b
             WHERE b.product_code = s.product_code)                       AS barcodes,
           (SELECT jsonb_agg(jsonb_build_object('tag_code', t.tag_code, 'tag_name', g.tag_name,
                                                'source', t.source, 'confidence', t.confidence))
              FROM public.petstore_product_tags t
              LEFT JOIN public.petstore_tags g ON g.tag_code = t.tag_code
             WHERE t.product_code = s.product_code)                       AS tags,
           (SELECT jsonb_agg(jsonb_build_object('supplier', p.supplier_name,
                     'min_order', p.min_order, 'order_multiple', NULLIF(p.order_multiple,1),
                     'arrival_days', p.arrival_days, 'is_primary', p.is_primary_supplier))
              FROM public.gdc_product_supplier_terms p
             WHERE p.product_code = s.product_code)                       AS supplier_terms
      FROM public.petstore_skus s
      LEFT JOIN public.petstore_product_status_current c ON c.product_code = s.product_code
      LEFT JOIN public.petstore_sku_supp sup ON sup.product_code = s.product_code
     WHERE s.product_code = $1
     LIMIT 1`;
  const r = await getPool().query(sql, [code]);
  return r.rows[0] || null;
}

// 按条码反查商品 —— 收银/盘点扫码用,一品多码在这里体现价值
async function byBarcode(bc) {
  const r = await getPool().query(`
    SELECT b.barcode, b.code_kind, b.is_primary, b.product_code,
           b.pack_type, b.pack_qty, b.box_out_price,   -- ⛔ 不返回 box_in_price(成本)
           s.product_name, s.spec, s.out_price, s.stock_num,
           -- 扫整箱码时该收多少:有箱售价用箱售价,没有就单价×装箱数
           COALESCE(b.box_out_price, s.out_price * COALESCE(b.pack_qty,1)) AS scan_price
      FROM public.petstore_product_barcodes b
      LEFT JOIN public.petstore_skus s ON s.product_code = b.product_code
     WHERE b.barcode = $1
     ORDER BY b.is_primary DESC`, [bc]);
  return { rows: r.rows, total: r.rows.length };
}

// 一品多码清单
async function multi(req) {
  const page = positiveInt(req.query?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(req.query?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const r = await getPool().query(`
    WITH m AS (
      SELECT product_code, COUNT(*)::int AS code_count,
             jsonb_agg(jsonb_build_object('barcode', barcode, 'kind', code_kind,
                                          'is_primary', is_primary, 'pack_qty', pack_qty,
                                          'box_out_price', box_out_price)
                       ORDER BY is_primary DESC, pack_qty, id) AS barcodes
        FROM public.petstore_product_barcodes
       GROUP BY product_code HAVING COUNT(*) > 1
    ), total_count AS (SELECT COUNT(*)::int AS total FROM m)
    SELECT (SELECT total FROM total_count) AS total,
           COALESCE(jsonb_agg(x ORDER BY x->>'product_code'), '[]'::jsonb) AS rows
      FROM (SELECT to_jsonb(m) || jsonb_build_object('product_name', s.product_name,
                                                     'spec', s.spec) AS x
              FROM m LEFT JOIN public.petstore_skus s USING(product_code)
             ORDER BY m.code_count DESC, m.product_code
             LIMIT $1 OFFSET $2) t`, [pageSize, (page - 1) * pageSize]);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const bc = cleanText(req.query?.barcode, 60);
    if (bc) return json(res, 200, await byBarcode(bc));
    const scope = String(req.query?.scope ?? "").trim();
    if (scope === "multi") return json(res, 200, await multi(req));
    const code = cleanText(req.query?.product_code, 60);
    if (!code) return json(res, 400, { ok: false, error: "product_code_required" });
    const d = await detail(code);
    if (!d) return json(res, 404, { ok: false, error: "not_found" });
    return json(res, 200, { rows: [d], total: 1 });
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
