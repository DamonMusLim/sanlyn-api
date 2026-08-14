// 订单主表 · 数据管理密网格 API(只读)
// ⚖️ Damon 0812 拿 jdy 数据管理截图点名:「这是真正的表格」「订单主表先做成熟」。
//    forge 假完成被查实(零提交零部署) → Claude 接管。
// 铁律:真源 postgres 只读;订单域行项目就取 order_line_items(OLI 禁令只限退税计算);
//      空就是空,不在 SQL 里补 0。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadOrdersMasterGrid(pool, q = {}) {
  const from = String(q.from || "2026-01-01").trim();
  const sql = `
WITH pbar AS MATERIALIZED (
  -- 0813 性能修复:原来两段 LEFT JOIN LATERAL 对 products 做**逐行全表扫**
  -- (1326 行项目 x 1939 products x 2 = 510 万次正则,EXPLAIN 实测 18.2s)。
  -- 改成先把 products 扫**一次**、正则只跑 1939 次,聚合成两张对照表再等值 JOIN。
  -- ⚖️ 匹配规则一个字没改(仍是严格两条路 + 条码必须 8-14 位纯数字),只改执行方式。
  -- 0813 审核补强(codex 提):归一化后可能变成空串(纯中文/纯符号品名)。空串会互相相等,
  -- 一旦哪天有个纯中文名带条码的产品进 products,order_line_items 里 33 条空 key 的行会集体串到它头上。
  -- 用 NULLIF 把空串变 NULL,配合下面 IS NOT NULL 直接排除。今天 products 侧空 key 为 0 行,改动不影响现有结果(已对拍)。
  SELECT p.barcode, NULLIF(upper(btrim(p.sku)),'') AS k_sku,
         NULLIF(regexp_replace(upper(btrim(p.product_name)),'[^A-Z0-9]','','g'),'') AS k_name
  FROM products p
  WHERE p.barcode ~ '^[0-9]{8,14}$'
), psku AS MATERIALIZED (
  SELECT k_sku, min(barcode) AS barcode FROM pbar WHERE k_sku IS NOT NULL GROUP BY k_sku
), pname AS MATERIALIZED (
  SELECT k_name, min(barcode) AS barcode FROM pbar WHERE k_name IS NOT NULL GROUP BY k_name
)
SELECT o.id, o.order_no, o.contract_no, o.customer_po, o.status,
  COALESCE(NULLIF(o.company_name_en,''), NULLIF(o.customer,'')) AS customer,
  COALESCE(NULLIF(o.factory,''),(SELECT c.name_cn FROM companies c WHERE c.id = o.factory_company_id LIMIT 1)) AS factory,
  o.total_amount, o.customer_amount, o.currency,
  to_char(o.created_at,'YYYY-MM-DD') AS created,
  o.bl_no,
  COALESCE((
    SELECT json_agg(json_build_object(
      -- ⚖️ Damon 0812:「JERKYTIME 都有条码的」—— 他对。行项目 286 条空条码里,
      --    136 条的条码就躺在 products 表(同一产品的另一条记录/或 SKU 写在品名开头)。
      --    ⛔ 只走两条**严格**的路,并标出来源,绝不猜:
      --      ① 品名开头的 SKU(如 "DD-02H  WANPY ...")→ products.sku
      --      ② 品名归一化后全等 → products.product_name
      --    ⛔ 条码必须 8-14 位纯数字(库里有 'clm' 这种垃圾值);前缀模糊匹配一律不用
      --      (0812 实测会把「鸡肉鳕鱼粒」配成「宠力美豆腐猫砂」——松匹配的老坑)
      'barcode', COALESCE(NULLIF(l.barcode,''), bsk.barcode, bcn.barcode),
      'barcode_src', CASE WHEN COALESCE(l.barcode,'')<>'' THEN 'oli'
                          WHEN bsk.barcode IS NOT NULL THEN 'sku'
                          WHEN bcn.barcode IS NOT NULL THEN 'name' END,
      'sku', l.sku, 'name', l.product_name,
      'size', l.size, 'qty', l.qty_ctn, 'price', l.unit_price,
      'subtotal', l.subtotal, 'nw', l.nw_ctn, 'gw', l.gw_ctn
    ) ORDER BY l.sort_order, l.id)
    FROM order_line_items l
    LEFT JOIN psku  bsk ON bsk.k_sku  = NULLIF(upper((regexp_match(btrim(l.product_name),'^([A-Z]{2,4}-[0-9]{2,3}[A-Z]?)'))[1]),'')
    LEFT JOIN pname bcn ON bcn.k_name = NULLIF(regexp_replace(upper(btrim(l.product_name)),'[^A-Z0-9]','','g'),'')
    WHERE l.order_id = o.id
  ), '[]'::json) AS items
FROM orders o
WHERE o.deleted_at IS NULL AND o.order_date >= $1
  -- 0813 更正:原来这里写 created_at 并注释「created_at 就是下单日」—— 是错的。
  -- created_at 是记录建库时间;脚本补录的老单 created_at 全是 2026-08-05/06,
  -- 按它筛/排会把 2025 年的单当成新单。真下单日是 order_date(153/153 有值)。
ORDER BY o.order_date DESC NULLS LAST`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadOrdersMasterGrid(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
