// 退税主表 · 以报关单为准（只读）
// 铁律：逐项 HS/品名/数量/净重/金额/税率 一律取自 customs_declaration_items（海关报关单），
//       禁用 order_line_items(OLI)。工厂/PO 仅作归属标注，来自 orders，不参与任何计算。
//       退税率只有 9%(HS 2309*) 与 13%；任一行算不出，整票 est_rebate 返回 null，不给半截数。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadTaxRebateMaster(pool, q = {}) {
  const from = String(q.from || "2026-01-01").trim();
  const sql = `
WITH decl AS (
  SELECT f.customs_no, f.export_date, f.contract_no, f.fob_cny,
    f.fob_foreign, f.currency, f.exchange_rate,
    COALESCE(f.rebate_lifecycle_status, f.status) AS status,
    f.raw->'tax_declare'->>'batch' AS batch,
    f.raw->'tax_declare'->>'apply_date' AS apply_date,
    f.raw->'tax_declare'->>'flow_status' AS flow_status,
    f.raw->'tax_declare'->>'batch_total' AS batch_total,
    f.rebate_expected, f.rebate_received, to_char(f.rebate_date,'YYYY-MM-DD') AS rebate_date,
    f.raw->'order_nos' AS raw_order_nos,
    cd.id AS decl_id,
    COALESCE(NULLIF(array_to_string(cd.container_nos, '/'), ''),
             NULLIF(replace(sp.container_no, ',', '/'), '')) AS containers,
    sp.container_qty, sp.container_type,
    sp.bl_no, sp.mbl_no, sp.hbl_no, sp.so_no, sp.vessel, sp.voyage,
    to_char(sp.etd, 'YYYY-MM-DD') AS etd
  FROM finance_export_rebates f
  LEFT JOIN customs_declarations cd ON cd.declaration_no = f.customs_no
  LEFT JOIN shipping_plans sp ON sp._id = cd.shipping_plan_id
  WHERE f.export_date >= $1
),
inv AS (
  -- 进项票挂到票上有两条路：customs_nos 直挂，或 contract_nos 对上合同号。
  -- 只走 customs_nos 会漏掉大量只填了合同号的票（0811 实测漏 1 张 ¥38,121）。
  SELECT DISTINCT d.customs_no, i.invoice_no, i.seller_name, i.amount_incl_tax, i.remark, i.issue_date
  FROM decl d
  JOIN finance_invoices_in i
    ON i.customs_nos @> ARRAY[d.customs_no]::varchar[]
    OR (i.contract_nos IS NOT NULL AND d.contract_no <> '' AND EXISTS (
          SELECT 1 FROM unnest(i.contract_nos) c
          WHERE c <> '' AND d.contract_no LIKE '%'||c||'%'))
),
-- 税局出口退税联（finance_rebate_ckts_lines）是最高权威口径：
-- 它是税局认的逐项，HS/数量/人民币离岸价都以它为准；有它就不用报关单PDF那一层。
ckts AS (
  SELECT d.customs_no, c.item_no, c.hs_code, c.goods_name, c.qty, c.unit,
    c.amount_cny, c.declared_flag,
    (c.raw::jsonb->>'region') AS source_region,
    (c.raw::jsonb->>'nw_total') AS nw_total,
    -- 退税联的「法定数量」单位是千克时，它就是该行净重
    CASE WHEN c.raw::jsonb->>'legal_unit' = '千克'
         THEN (c.raw::jsonb->>'legal_qty')::numeric END AS line_nw,
    CASE WHEN c.hs_code LIKE '2309%' THEN 0.09
         WHEN c.hs_code IS NULL OR c.hs_code = '' THEN NULL
         ELSE 0.13 END AS rate,
    (SELECT v.invoice_no FROM inv v WHERE v.customs_no = d.customs_no
       AND (v.amount_incl_tax = c.amount_cny
            OR (c.goods_name <> '' AND v.remark ILIKE '%'||c.goods_name||'%'))
     ORDER BY (v.amount_incl_tax = c.amount_cny) DESC LIMIT 1) AS invoice_no,
    -- 行级工厂证据链（Damon 0812：工厂必须从我们自己的库带；
    -- 货源地是「整票一个值」，一票多厂时贴到行上必然全错，已停用）
    --  ① 进项票逐行明细：品名+箱数命中
    --  ② 进项票金额 = 该行报关金额（±1元）
    --  ③ 我们的订单行 order_line_items：按报关品名匹配，且这些行只指向唯一一家工厂
    --  ④ 票备注含品名
    COALESCE(
      (SELECT i2.seller_name FROM finance_invoices_in i2, jsonb_array_elements(i2.line_items) li
        WHERE i2.customs_nos @> ARRAY[d.customs_no]::varchar[] AND i2.line_items IS NOT NULL
          AND (li->>'nm') = c.goods_name AND (li->>'qty')::numeric = c.qty LIMIT 1),
      (SELECT v.seller_name FROM inv v WHERE v.customs_no = d.customs_no
          AND abs(v.amount_incl_tax - c.amount_cny) < 1 LIMIT 1),
      (SELECT CASE WHEN count(DISTINCT o.factory) = 1 THEN max(o.factory) END
         FROM order_line_items l JOIN orders o ON o.id = l.order_id
        WHERE o.factory IS NOT NULL AND o.factory <> '' AND l.declaration_name = c.goods_name
          AND (o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))
               OR (d.contract_no <> '' AND o.contract_no <> '' AND d.contract_no LIKE '%'||o.contract_no||'%'))),
      (SELECT v.seller_name FROM inv v WHERE v.customs_no = d.customs_no
          AND c.goods_name <> '' AND v.remark ILIKE '%'||c.goods_name||'%' LIMIT 1),
      -- ⑤ 整票的订单只指向唯一一家工厂 → 每一行都是这家（无歧义，Damon 0812：按公司分开除重）
      (SELECT CASE WHEN count(DISTINCT o.factory) = 1 THEN max(o.factory) END
         FROM orders o WHERE o.factory IS NOT NULL AND o.factory <> ''
          AND (o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))
               OR (d.contract_no <> '' AND o.contract_no <> '' AND d.contract_no LIKE '%'||o.contract_no||'%')))
    ) AS line_factory
  FROM decl d JOIN finance_rebate_ckts_lines c ON c.customs_no = d.customs_no
),
ckts_agg AS (
  SELECT customs_no, count(*) n,
    count(*) FILTER (WHERE rate IS NULL OR amount_cny IS NULL) bad,
    bool_or(declared_flag = 'N') AS ckts_declarable,
    round(sum(amount_cny), 2) AS line_amt_sum,
    CASE WHEN count(*) FILTER (WHERE rate IS NULL OR amount_cny IS NULL) > 0 THEN NULL
         ELSE round(sum(amount_cny * rate), 2) END AS est_rebate,
    json_agg(json_build_object(
      'item_no', item_no, 'hs', hs_code, 'name', goods_name, 'qty', qty, 'unit', unit,
      'nw', line_nw, 'amt', amount_cny, 'rate', rate,
      'invoice_no', invoice_no, 'factory', line_factory,
      'region', source_region,
      'region_name', (SELECT a.area_name FROM customs_source_area a WHERE a.area_code = source_region),
      'region_factory', NULL,
      'line_rebate', CASE WHEN rate IS NOT NULL AND amount_cny IS NOT NULL
                          THEN round(amount_cny * rate, 2) END
    ) ORDER BY item_no) AS items
  FROM ckts GROUP BY customs_no
),
line AS (
  SELECT d.customs_no, ci.sort_order AS item_no, ci.hs_code,
    ci.declaration_name_cn AS name, ci.qty, ci.unit,
    ci.net_weight_kg AS nw, ci.declaration_amount AS amt, ci.source_region,
    CASE WHEN ci.hs_code LIKE '2309%' THEN 0.09
         WHEN ci.hs_code IS NULL OR ci.hs_code = '' THEN NULL
         ELSE 0.13 END AS rate,
    -- 行级工厂/发票：真源是进项票（销方=工厂）。只有证据确凿才落到行上：
    --   ① 票面含税金额 = 该行报关金额（精确命中）
    --   ② 票备注含该行品名
    --   ③ 整票只有一个销方（无歧义，可下沉）
    -- 都不满足 → 留空，由上层标「待分」，绝不猜。
    COALESCE(
      (SELECT v.seller_name FROM inv v WHERE v.customs_no = d.customs_no
        AND (v.amount_incl_tax = ci.declaration_amount
             OR (ci.declaration_name_cn <> '' AND v.remark ILIKE '%'||ci.declaration_name_cn||'%'))
      ORDER BY (v.amount_incl_tax = ci.declaration_amount) DESC LIMIT 1),
      (SELECT CASE WHEN count(DISTINCT o.factory) = 1 THEN max(o.factory) END
         FROM order_line_items l JOIN orders o ON o.id = l.order_id
        WHERE o.factory IS NOT NULL AND o.factory <> '' AND l.declaration_name = ci.declaration_name_cn
          AND (o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))
               OR (d.contract_no <> '' AND o.contract_no <> '' AND d.contract_no LIKE '%'||o.contract_no||'%'))),
      -- ⑤ 整票的订单只指向唯一一家工厂 → 每一行都是这家（无歧义，Damon 0812：按公司分开除重）
      (SELECT CASE WHEN count(DISTINCT o.factory) = 1 THEN max(o.factory) END
         FROM orders o WHERE o.factory IS NOT NULL AND o.factory <> ''
          AND (o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))
               OR (d.contract_no <> '' AND o.contract_no <> '' AND d.contract_no LIKE '%'||o.contract_no||'%')))
    ) AS line_factory,
    (SELECT v.invoice_no FROM inv v WHERE v.customs_no = d.customs_no
        AND (v.amount_incl_tax = ci.declaration_amount
             OR (ci.declaration_name_cn <> '' AND v.remark ILIKE '%'||ci.declaration_name_cn||'%'))
      ORDER BY (v.amount_incl_tax = ci.declaration_amount) DESC LIMIT 1) AS invoice_no
  FROM decl d
  JOIN customs_declaration_items ci
    ON ci.declaration_id = d.decl_id AND ci.deleted_at IS NULL
),
agg AS (
  SELECT customs_no, count(*) AS n,
    count(*) FILTER (WHERE rate IS NULL OR amt IS NULL) AS bad,
    count(*) FILTER (WHERE nw IS NULL) AS no_nw,
    round(sum(amt), 2) AS line_amt_sum,
    CASE WHEN count(*) FILTER (WHERE rate IS NULL OR amt IS NULL) > 0 THEN NULL
         ELSE round(sum(amt * rate), 2) END AS est_rebate,
    json_agg(json_build_object(
      'item_no', item_no, 'hs', hs_code, 'name', name, 'qty', qty, 'unit', unit,
      'nw', nw, 'amt', amt, 'rate', rate, 'invoice_no', invoice_no,
      'factory', line_factory, 'region', source_region,
      'region_name', (SELECT a.area_name FROM customs_source_area a WHERE a.area_code = source_region),
      'region_factory', NULL,
      'line_rebate', CASE WHEN rate IS NOT NULL AND amt IS NOT NULL
                          THEN round(amt * rate, 2) END
    ) ORDER BY item_no) AS items
  FROM line GROUP BY customs_no
)
SELECT d.customs_no, to_char(d.export_date,'YYYY-MM-DD') AS export_date,
  d.status, d.batch, d.apply_date, d.flow_status, d.batch_total,
  d.rebate_expected, d.rebate_received, d.rebate_date,
  d.contract_no, d.containers,
  -- 同一条提单上还有哪几张报关单（多张报关单共用同一批柜子时，避免把柜数重复计算）
  -- 同提单兄弟报关单：必须是 18 位正规报关单号 且 在退税台账里有票，
  -- 否则会把「提单号当 declaration_no 存」的模版行当成兄弟单（0812 实测 878686 自己跟自己比）
  (SELECT string_agg(c2.declaration_no, '/') FROM customs_declarations c2
     WHERE c2.shipping_plan_id = (SELECT c3.shipping_plan_id FROM customs_declarations c3
                                    WHERE c3.declaration_no = d.customs_no)
       AND c2.declaration_no <> d.customs_no
       AND c2.declaration_no ~ '^[0-9]{18}$'
       AND EXISTS (SELECT 1 FROM finance_export_rebates f3 WHERE f3.customs_no = c2.declaration_no)) AS bl_siblings, d.container_qty, d.container_type,
  d.bl_no, d.mbl_no, d.hbl_no, d.so_no, d.vessel, d.voyage, d.etd,
  d.fob_cny, d.fob_foreign, d.currency, d.exchange_rate,
  COALESCE(k.n, a.n, 0) AS item_count, COALESCE(k.bad, a.bad, 0) AS bad_lines,
  COALESCE(k.est_rebate, a.est_rebate) AS est_rebate, a.no_nw,
  COALESCE(k.line_amt_sum, a.line_amt_sum) AS line_amt_sum,
  k.ckts_declarable,
  -- 数据等级：报关单级 = 逐项都有净重 且 逐项金额合计与报关额吻合；否则是模版/预估，不能当退税依据
  CASE WHEN k.n IS NOT NULL THEN 'ckts'
       WHEN a.n IS NULL THEN 'none'
       -- 从 i.chinaport 出口退税联(decDetail/preview) 抓来的，等同税局口径
       WHEN EXISTS (SELECT 1 FROM customs_declarations c4
                     WHERE c4.declaration_no = d.customs_no
                       AND c4.source_system = 'chinaport-rtx-decDetail-0812') THEN 'ckts'
       WHEN COALESCE(a.no_nw,0) = 0 AND a.line_amt_sum IS NOT NULL
            AND abs(a.line_amt_sum - d.fob_cny) < 1.00 THEN 'customs'
       ELSE 'template' END AS data_grade,
  COALESCE(k.items, a.items, '[]'::json) AS items,
  COALESCE(k.n, a.n, 0) AS ckts_or_customs_n,
  -- 订单归属三条链路，缺一都会造成「工厂未知」：
  --   ① 台账 raw->order_nos 直接存着订单号（34/59 票有，最准）
  --   ② 合同号模糊匹配 orders.contract_no
  --   ③ 提单号反查 orders.bl_no
  COALESCE(
    (SELECT string_agg(DISTINCT o.order_no, '/') FROM orders o
       WHERE o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))),
    -- ②合同号匹配：同一合同下常挂多张订单（一船多柜各报一张），
    --   必须排除已被别的报关单 raw->order_nos 明确认领的订单，否则会把兄弟单的订单也贴上来。
    (SELECT string_agg(DISTINCT o.order_no, '/') FROM orders o
       WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> ''
         AND NOT EXISTS (
           SELECT 1 FROM finance_export_rebates f2
           WHERE f2.customs_no <> d.customs_no
             AND f2.raw->'order_nos' IS NOT NULL
             AND o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((f2.raw->'order_nos')::jsonb))))),
    (SELECT string_agg(DISTINCT o.order_no, '/') FROM orders o
       WHERE o.bl_no <> '' AND o.bl_no = d.bl_no)
  ) AS order_nos,
  COALESCE(
    (SELECT string_agg(DISTINCT o.factory, '/') FROM orders o
       WHERE o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))),
    (SELECT string_agg(DISTINCT o.factory, '/') FROM orders o
       WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> ''
         AND NOT EXISTS (
           SELECT 1 FROM finance_export_rebates f2
           WHERE f2.customs_no <> d.customs_no
             AND f2.raw->'order_nos' IS NOT NULL
             AND o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((f2.raw->'order_nos')::jsonb))))),
    (SELECT string_agg(DISTINCT o.factory, '/') FROM orders o
       WHERE o.bl_no <> '' AND o.bl_no = d.bl_no)
  ) AS order_factories,
  -- ④订单号编码：<客户号>-<厂码>-<PO号>，厂码可直接译出工厂（order_code_map，Damon 0812 说明）
  (SELECT string_agg(DISTINCT mp.value_cn, '/') FROM order_code_map mp
     WHERE mp.kind = 'factory' AND mp.is_primary
       AND mp.code = ANY(ARRAY(
         SELECT split_part(x, '-', 2) FROM unnest(string_to_array(
           COALESCE(
             (SELECT string_agg(DISTINCT o.order_no, ',') FROM orders o
                WHERE o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))),
             (SELECT string_agg(DISTINCT o.order_no, ',') FROM orders o
                WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> '')
           ), ',')) AS x))) AS code_factories,
  (SELECT string_agg(DISTINCT mp.value_cn, '/') FROM order_code_map mp
     WHERE mp.kind = 'cust' AND mp.is_primary
       AND mp.code = ANY(ARRAY(
         SELECT split_part(x, '-', 1) FROM unnest(string_to_array(
           COALESCE(
             (SELECT string_agg(DISTINCT o.order_no, ',') FROM orders o
                WHERE o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))),
             (SELECT string_agg(DISTINCT o.order_no, ',') FROM orders o
                WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> '')
           ), ',')) AS x))) AS code_customer,
  COALESCE(
    (SELECT string_agg(DISTINCT o.customer, '/') FROM orders o
       WHERE o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text((d.raw_order_nos)::jsonb)))),
    (SELECT string_agg(DISTINCT o.customer, '/') FROM orders o
       WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> ''),
    (SELECT string_agg(DISTINCT o.customer, '/') FROM orders o
       WHERE o.bl_no <> '' AND o.bl_no = d.bl_no)
  ) AS customer,
  (SELECT string_agg(DISTINCT v.seller_name, '/') FROM inv v
     WHERE v.customs_no = d.customs_no AND v.seller_name IS NOT NULL) AS factories,
  (SELECT count(DISTINCT v.seller_name) FROM inv v
     WHERE v.customs_no = d.customs_no AND v.seller_name IS NOT NULL) AS seller_count,
  (SELECT string_agg(v.invoice_no, ',' ORDER BY v.issue_date) FROM inv v
     WHERE v.customs_no = d.customs_no) AS invoices,
  (SELECT round(sum(v.amount_incl_tax), 2) FROM inv v
     WHERE v.customs_no = d.customs_no) AS invoice_amt
FROM decl d
LEFT JOIN agg a ON a.customs_no = d.customs_no
LEFT JOIN ckts_agg k ON k.customs_no = d.customs_no
ORDER BY d.export_date DESC, d.customs_no`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadTaxRebateMaster(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
