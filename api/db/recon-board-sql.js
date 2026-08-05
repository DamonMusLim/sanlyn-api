import { INVOICE_CONFIRM_SQL } from "./recon-board-invoice-confirm.js";

// 对账作战台主查询 SQL(从 recon-board.js 拆出,守 500 行铁律)。
// orderFilter/shipmentFilter 由调用方按搜索词注入(已参数化 $1);argsLen = LIMIT 的占位符序号。
export function buildBoardSql({ orderFilter = "", shipmentFilter = "", argsLen = 1 } = {}) {
  const limitPh = `$${argsLen}`;
  return `WITH selected_orders AS (
  SELECT o.* FROM orders o
   WHERE o.deleted_at IS NULL AND COALESCE(o.status, '') <> 'cancelled' ${orderFilter}
   ORDER BY COALESCE(o.status_updated_at, o.updated_at, o.created_at) DESC NULLS LAST, o.id DESC
   LIMIT ${limitPh}
),
payments AS (
  SELECT so.order_no, so.contract_no,
         COALESCE(SUM(COALESCE(fp.this_amount, fp.amount)) FILTER (WHERE fp.direction='out'),0) AS paid,
         COALESCE(SUM(COALESCE(fp.this_amount, fp.amount)) FILTER (WHERE fp.direction='in'),0) AS received
    FROM selected_orders so
    LEFT JOIN finance_payments fp ON ((so.contract_no IS NOT NULL AND fp.contract_no=so.contract_no) OR (so.order_no IS NOT NULL AND fp.order_no=so.order_no))
   GROUP BY so.order_no, so.contract_no
),
drafts AS (
  SELECT so.order_no, so.contract_no, d.status AS invoice_status, d.currency AS invoice_currency,
         COALESCE(d.amount_invoice, d.amount_declared, d.amount_order) AS invoice_amount
    FROM selected_orders so LEFT JOIN finance_invoice_drafts d ON d.contract_no=so.contract_no
),
slips AS (
  SELECT so.order_no, so.contract_no,
         COUNT(DISTINCT bsl.id) FILTER (WHERE bsl.contract_no=so.contract_no OR bsl.order_no=so.order_no) AS customer_slip_count,
         COUNT(DISTINCT bsl.id) FILTER (WHERE fp.id IS NOT NULL) AS factory_slip_count
    FROM selected_orders so
    LEFT JOIN bank_slip_links bsl ON bsl.contract_no=so.contract_no OR bsl.order_no=so.order_no OR bsl.payment_id IS NOT NULL
    LEFT JOIN finance_payments fp ON fp.id=bsl.payment_id AND fp.direction='out'
      AND ((fp.contract_no=so.contract_no AND so.contract_no IS NOT NULL) OR (fp.order_no=so.order_no AND so.order_no IS NOT NULL))
   GROUP BY so.order_no, so.contract_no
),
-- 客户应收锚定源 = finance_export_rebates.fob_cny(报关销售额,唯一真源;绝不用 orders.total/OLI)。
-- 按 contract_no 聚合前先去重 selected_orders(先 DISTINCT contract_no 再 JOIN fer),
-- 避免同一 contract_no 命中多张兄弟订单时 JOIN 扇出导致 SUM 被重复累加(2026-07-15 修复,曾致应收翻倍)。
-- 无 fer 行 → receivable_anchor=NULL → orderFact 里 anchored=false → 前端显"待报关"。
-- 报关单常一票管多单,fer.contract_no 存成斜杠拼接(如 'FS20260220049/FS20260220051/FS20260220057/FS20260220058'),
-- 精确等值匹配会让这些单全判"待报关"。这里拆开拼接号建索引,再按各订单销售额占比把报关总额分摊到单。
-- 报关总额是真值,只做分摊不造数;单号独占一张报关单时占比=100% 与原逻辑等价。
decl_expanded AS (
  SELECT r.customs_no, r.currency, r.fob_cny,
         BTRIM(part) AS one_contract,
         COUNT(*) OVER (PARTITION BY r.customs_no) AS parts_in_decl
    FROM finance_export_rebates r
    CROSS JOIN LATERAL regexp_split_to_table(r.contract_no, '\\s*/\\s*') AS part
   WHERE NULLIF(BTRIM(part),'') IS NOT NULL
),
decl_share AS (
  SELECT de.customs_no, de.currency, de.fob_cny, de.one_contract,
         COALESCE(SUM(ABS(o2.sale)) OVER (PARTITION BY de.customs_no), 0) AS decl_sale_total,
         COALESCE(ABS(o2.sale), 0) AS one_sale,
         de.parts_in_decl
    FROM decl_expanded de
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(o.customer_amount, o.total_amount, 0)), 0) AS sale
        FROM orders o
       WHERE o.deleted_at IS NULL AND COALESCE(o.status,'') <> 'cancelled'
         AND o.contract_no = de.one_contract
    ) o2 ON TRUE
),
anchor_from_fer AS (
  SELECT dc.contract_no,
         SUM(CASE WHEN ds.decl_sale_total > 0 THEN ds.fob_cny * (ds.one_sale / ds.decl_sale_total)
                  ELSE ds.fob_cny / NULLIF(ds.parts_in_decl,0) END) AS amt,
         MIN(ds.currency) AS cur,
         COUNT(*) AS n
    FROM (SELECT DISTINCT contract_no FROM selected_orders WHERE contract_no IS NOT NULL) dc
    JOIN decl_share ds ON ds.one_contract = dc.contract_no
   GROUP BY dc.contract_no
),
-- 第二来源:报关单主表 customs_declarations,经 shipping_plans.order_nos 关联到订单。
-- fer(退税表)是首选真值;这里只补 fer 没覆盖到的单(报关了但还没进退税流程)。同样按销售额占比拆到单。
anchor_from_cd AS (
  SELECT o.contract_no,
         SUM(CASE WHEN pt.plan_sale > 0 THEN cd.total_declaration_amount * (ABS(COALESCE(o.customer_amount,o.total_amount,0)) / pt.plan_sale)
                  ELSE cd.total_declaration_amount / NULLIF(pt.plan_orders,0) END) AS amt,
         COUNT(*) AS n
    FROM customs_declarations cd
    JOIN shipping_plans sp ON sp._id = cd.shipping_plan_id AND sp.deleted_at IS NULL
    CROSS JOIN LATERAL unnest(COALESCE(sp.order_nos,'{}'::text[])) AS ord(order_no)
    JOIN orders o ON o.order_no = ord.order_no AND o.deleted_at IS NULL AND COALESCE(o.status,'') <> 'cancelled'
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(ABS(COALESCE(o3.customer_amount,o3.total_amount,0))),0) AS plan_sale,
             COUNT(*) AS plan_orders
        FROM unnest(COALESCE(sp.order_nos,'{}'::text[])) AS u(order_no)
        JOIN orders o3 ON o3.order_no = u.order_no AND o3.deleted_at IS NULL AND COALESCE(o3.status,'') <> 'cancelled'
    ) pt
   WHERE cd.deleted_at IS NULL AND COALESCE(cd.total_declaration_amount,0) > 0
     AND o.contract_no IS NOT NULL
   GROUP BY o.contract_no
),
receivable_anchor AS (
  SELECT dc.contract_no,
         COALESCE(f.amt, cdx.amt) AS receivable_anchor,
         COALESCE(f.cur, 'CNY') AS anchor_currency,
         COALESCE(f.n, cdx.n) AS anchor_decl_count,
         (f.amt IS NULL AND cdx.amt IS NOT NULL) AS anchor_from_declaration
    FROM (SELECT DISTINCT contract_no FROM selected_orders WHERE contract_no IS NOT NULL) dc
    LEFT JOIN anchor_from_fer f USING (contract_no)
    LEFT JOIN anchor_from_cd cdx USING (contract_no)
   WHERE COALESCE(f.amt, cdx.amt) IS NOT NULL
),
-- 客户发票号:finance_invoices_out.contract_nos 数组重叠匹配(排除作废/红冲/草稿)。
customer_invoices AS (
  SELECT so.contract_no,
         (array_agg(DISTINCT fio.invoice_no) FILTER (WHERE fio.invoice_no IS NOT NULL))[1] AS invoice_no
    FROM selected_orders so
    JOIN finance_invoices_out fio
      ON so.contract_no = ANY(COALESCE(fio.contract_nos::text[], '{}'::text[]))
     AND so.contract_no IS NOT NULL
     AND COALESCE(fio.void_status,'') <> 'void'
     AND COALESCE(fio.review_status,'') NOT IN ('void','red_ink')
     AND COALESCE(fio.invoice_no,'') NOT LIKE 'CI-DRAFT%'
   GROUP BY so.contract_no
),
-- 客户水单:file_url + 分摊金额 + 有无回单文件。⚠ 方向甄别:sender=我方主体(巴匕/洋宝宝)的水单是"我们付出去"的
-- (如 slip36 巴匕→中宠人工确认记录),绝不能算作客户已收 → 单列 ap_alloc 并置 direction_warn,前端显警示不计已收。
customer_slip_file AS (
  SELECT so.contract_no, so.order_no,
         (array_agg(bs.file_url ORDER BY bs.created_at DESC) FILTER (WHERE bs.file_url IS NOT NULL))[1] AS slip_file_url,
         SUM(bsl.amount_alloc) FILTER (WHERE NOT (bs.sender_name ILIKE '%巴匕%' OR bs.sender_name ILIKE '%洋宝%')) AS slip_alloc,
         SUM(bsl.amount_alloc) FILTER (WHERE bs.sender_name ILIKE '%巴匕%' OR bs.sender_name ILIKE '%洋宝%') AS slip_ap_alloc,
         COUNT(*) FILTER (WHERE bs.file_url IS NOT NULL) AS receipt_count,
         MIN(bsl.alloc_currency) AS slip_currency
    FROM selected_orders so
    JOIN bank_slip_links bsl ON (bsl.contract_no=so.contract_no AND so.contract_no IS NOT NULL)
                             OR (bsl.order_no=so.order_no AND so.order_no IS NOT NULL)
    JOIN bank_slips bs ON bs.id = bsl.slip_id
   GROUP BY so.contract_no, so.order_no
),
-- 订单运输信息:按 order_no 在 shipping_plans.order_nos 数组里找;一订单多柜取最新 etd。
order_shipment AS (
  SELECT DISTINCT ON (so.order_no)
         so.order_no,
         sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
         sp.customer AS consignee
    FROM selected_orders so
    JOIN shipping_plans sp ON sp.deleted_at IS NULL
     AND so.order_no = ANY(COALESCE(sp.order_nos, '{}'::text[]))
   ORDER BY so.order_no, sp.etd DESC NULLS LAST
),
selected_shipments AS (
  SELECT sp.* FROM shipping_plans sp
   WHERE sp.deleted_at IS NULL AND NULLIF(BTRIM(COALESCE(sp.shipment_no, '')), '') IS NOT NULL ${shipmentFilter}
),
bill_rows AS (
  SELECT sp.id AS plan_id, fsb.* FROM selected_shipments sp
    LEFT JOIN active_freight_supplier_bills fsb ON fsb.link_plan_id=sp._id OR (sp.bl_no IS NOT NULL AND (fsb.bl_no=sp.bl_no OR fsb.link_plan_id=sp.bl_no))
),
bill_groups AS (
  SELECT br.plan_id,
         COALESCE(br.supplier_company_code, br.supplier) AS party_key,
         MAX(br.supplier_company_code) AS supplier_company_code,
         MAX(br.supplier) AS supplier_name,
         MAX(br.payer_company_code) AS payer_company_code,
         COALESCE(br.currency_norm, br.currency, 'CNY') AS currency,
         COALESCE(SUM(br.amount),0) AS ap_total,
         COALESCE(SUM(br.ap_paid_amount),0) AS ap_paid,
         COALESCE(SUM(br.sale_amount),0) AS ar_total,
         COALESCE(SUM(br.ar_paid_amount),0) AS ar_paid,
         COALESCE(jsonb_agg(jsonb_build_object('ap_status', br.ap_status, 'ar_status', br.ar_status)) FILTER (WHERE br.id IS NOT NULL), '[]'::jsonb) AS bills
    FROM bill_rows br
   WHERE br.id IS NOT NULL
   GROUP BY br.plan_id, COALESCE(br.supplier_company_code, br.supplier), COALESCE(br.currency_norm, br.currency, 'CNY')
),
-- 费目四分类(闭环表格):海运费/拖车(车队)/报关/其余归港杂;按票+币种聚合出 已付/未付
fee_groups AS (
  SELECT br.plan_id,
         CASE WHEN br.cost_category IS NULL OR BTRIM(br.cost_category)='' OR br.cost_category ILIKE 'misc' THEN 'unknown'
              WHEN br.cost_category ILIKE '%海运%' OR br.cost_category ILIKE '%ocean_freight%' THEN 'freight'
              WHEN br.cost_category ILIKE '%拖车%' OR br.cost_category ILIKE '%陆运%' OR br.cost_category ILIKE '%铁路%' OR br.cost_category ILIKE '%拖驳%' THEN 'truck'
              WHEN br.cost_category ILIKE '%报关%' OR br.cost_category ILIKE '%报检%' THEN 'customs'
              ELSE 'port' END AS fee_class,
         COALESCE(br.currency_norm, br.currency, 'CNY') AS currency,
         COALESCE(SUM(br.amount),0) AS amount,
         COALESCE(SUM(br.ap_paid_amount),0) AS paid,
         COUNT(*) AS bill_count
    FROM bill_rows br
   WHERE br.id IS NOT NULL
   GROUP BY 1, 2, 3
),
${INVOICE_CONFIRM_SQL},
shipment_sum AS (
  SELECT sp.id, sp._id, sp.shipment_no, sp.bl_no, sp.order_nos, sp.issuing_company,
         sp.forwarder_cn AS forwarder, sp.forwarder_company_id, sp.customer, sp.company_code, sp.customer_company_id,
         sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
         sp.customer AS consignee,
         sp.created_at, sp.updated_at, sp.forwarder_price_confirmed_at,
         COALESCE(SUM(bg.ap_total),0) AS ap_total, COALESCE(SUM(bg.ap_paid),0) AS ap_paid,
         COALESCE(SUM(bg.ar_total),0) AS ar_total, COALESCE(SUM(bg.ar_paid),0) AS ar_paid,
         COUNT(DISTINCT bg.currency) FILTER (WHERE bg.party_key IS NOT NULL) AS bill_currency_count,
         MIN(bg.currency) FILTER (WHERE bg.party_key IS NOT NULL) AS bill_currency,
         COALESCE(jsonb_agg(to_jsonb(bg) ORDER BY bg.party_key, bg.currency) FILTER (WHERE bg.party_key IS NOT NULL), '[]'::jsonb) AS bill_groups,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('fee_class',fg.fee_class,'currency',fg.currency,'amount',fg.amount,'paid',fg.paid,'bill_count',fg.bill_count) ORDER BY CASE fg.fee_class WHEN 'freight' THEN 1 WHEN 'port' THEN 2 WHEN 'truck' THEN 3 WHEN 'customs' THEN 4 ELSE 5 END) FROM fee_groups fg WHERE fg.plan_id=sp.id), '[]'::jsonb) AS fee_groups,
         COALESCE(icg.invoice_confirm_status, 'none') AS invoice_confirm_status,
         COALESCE(icg.pending_price_review, false) AS pending_price_review,
         icg.confirm_actor,
         icg.confirm_at,
         COALESCE(icg.invoice_confirm_refs, '[]'::jsonb) AS invoice_confirm_refs,
         (NULLIF(BTRIM(COALESCE(sp.forwarder_cn, '')), '') IS NULL) AS missing_forwarder,
         CASE WHEN EXISTS (SELECT 1 FROM recon_lines rl WHERE rl.template_key='ap_forwarder' AND sp.bl_no IS NOT NULL AND rl.line_key LIKE '%' || sp.bl_no || '%' AND COALESCE(rl.actual_amount,0)>0) THEN 'invoiced' ELSE 'pending' END AS ap_invoice
    FROM selected_shipments sp
    LEFT JOIN bill_groups bg ON bg.plan_id=sp.id
    LEFT JOIN invoice_confirm_groups icg ON icg.shipment_id=sp.id
   GROUP BY sp.id, sp._id, sp.shipment_no, sp.bl_no, sp.order_nos, sp.issuing_company,
            sp.forwarder_cn, sp.forwarder_company_id, sp.customer, sp.company_code, sp.customer_company_id,
            sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
            sp.created_at, sp.updated_at, sp.forwarder_price_confirmed_at,
            icg.invoice_confirm_status, icg.pending_price_review, icg.confirm_actor, icg.confirm_at, icg.invoice_confirm_refs
)
SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.last_action_at DESC NULLS LAST), '[]'::jsonb) FROM (
    SELECT so.created_at, so.updated_at, so.etd, so.order_date, so.delivery_date, so.confirmed_delivery, so.order_no, so.contract_no, so.customer, so.factory, so.issuing_company, so.currency,
           so.factory_code, so.factory_company_id, so.company_code, so.customer_company_id,
           so.created_by, so.status_updated_by, COALESCE(so.status_updated_at, so.updated_at) AS last_action_at,
           so.factory_confirmed_at, so.customer_confirmed_at,
           COALESCE(so.factory_total_amount, so.total_amount_factory, so.factory_amount) AS payable,
           -- 应收锚定:仅报关销售额 fob_cny;无 fer 锚 → NULL(anchored=false → 前端"待报关"),绝不兜底订单额。
           ra.receivable_anchor AS receivable,
           (ra.receivable_anchor IS NOT NULL) AS anchored,
           ra.anchor_currency, ra.anchor_decl_count, ra.anchor_from_declaration,
           -- 三价并列(Damon 2026-08-05 要):采购=付工厂 / 报关=申报额 / 销售=收客户
           COALESCE(so.factory_total_amount, so.total_amount_factory, so.factory_amount) AS price_buy,
           ra.receivable_anchor AS price_declared,
           COALESCE(so.customer_amount, so.total_amount) AS price_sale,
           ci.invoice_no,
           csf.slip_file_url, csf.slip_alloc, csf.slip_ap_alloc, csf.receipt_count, csf.slip_currency,
           osh.container_no, osh.shipper, osh.carrier_code, osh.vessel, osh.etd AS ship_etd, osh.eta AS ship_eta, osh.consignee,
           p.paid,
           -- 已收 = finance_payments 入账额 与 水单已认领分摊额 取大者(同一笔钱的两种记录,相加会翻倍)。
           -- 水单侧只认客户汇入(sender 非我方主体),我方付出的水单被错挂时不计入客户已收(见 customer_slip_file.slip_alloc)。
           GREATEST(COALESCE(p.received,0), COALESCE(csf.slip_alloc,0)) AS received,
           d.invoice_status, d.invoice_currency, d.invoice_amount, s.factory_slip_count, s.customer_slip_count
      FROM selected_orders so LEFT JOIN payments p USING(order_no, contract_no) LEFT JOIN drafts d USING(order_no, contract_no) LEFT JOIN slips s USING(order_no, contract_no)
           LEFT JOIN receivable_anchor ra USING(contract_no)
           LEFT JOIN customer_invoices ci USING(contract_no)
           LEFT JOIN customer_slip_file csf USING(contract_no, order_no)
           LEFT JOIN order_shipment osh USING(order_no)
  ) x) AS orders,
  (SELECT COALESCE(jsonb_agg(to_jsonb(ss) ORDER BY ss.created_at DESC NULLS LAST), '[]'::jsonb) FROM shipment_sum ss) AS shipments,
  (SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM finance_invoice_drafts d WHERE d.status IN ('pending','blocked','confirmed')) AS invoice_drafts,
  (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM finance_recon_exceptions e WHERE e.status='open') AS exceptions,
  (SELECT COUNT(*)::int FROM finance_payments WHERE COALESCE(direction,'')='') AS unclassified_payments_count`;
}
