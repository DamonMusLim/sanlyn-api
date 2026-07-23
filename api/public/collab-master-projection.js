// collab-master-projection.js — DRAFT, NOT DEPLOYED. Task #bp-collab-master-build-0723.
// 声明式字段投影表：谁能看见哪个字段。默认拒绝——字段不在白名单里就不下发。
// 这不是"查出来再删"，是 cols() 从这张表反查出"允许 SELECT 的列名"，成本类列对非内部
// 视角物理不出现在 SQL 里。
//
// 7 视角：internal(内部) / fwd(货代) / trucker(车队) / broker(报关行) /
//        insurer(保险) / factory(工厂) / customer(客户)

export const VIEWS = ["internal", "fwd", "trucker", "broker", "insurer", "factory", "customer"];

// ── 唯一例外常量（写死在这里，不散落在判断逻辑里）──────────────────────
//
// 例外①：报关行的"申报金额"——阶段=after 时其它外部视角金额全部清零，
// 报关行例外，因为没有申报金额报不了关。来源=customs_invoice_status
// (system_expected_amount/manual_expected_amount)，按 (customs_no, factory_code) 锚定。
// 【待 Damon 最终确认】是否要连报关行也一并清零、改走线下报送。
export const DECLARED_AMOUNT_EXCEPTION_VIEW = "broker";

// 阶段=after 时，外部视角金额一律清零。
// internal 永不受闸——Damon 明确"金额闸只对外部生效，内部照常看全部金额（对账要用）"。
// 外部唯一豁免＝报关行（申报金额），见上。
export const AMOUNT_GATE_EXEMPT_VIEWS = ["internal", DECLARED_AMOUNT_EXCEPTION_VIEW];

// ── 规则冲突已裁决（2026-07-23 审核环）────────────────────────────────
// 草稿曾把 factory_price/factory_subtotal 只给 internal，理由是"成本类不给外部"。
// 裁决：**工厂可以看自己的采购结算价**——那个价本来就是工厂自己开给我们的，不是泄露；
// 现有 customs-collab 工厂开票协同流程里工厂本来就在确认这个价。真正不能给工厂的是
// **销售价**（unit_price/subtotal/total_amount），那几个字段的 visibleTo 里没有 factory。
// 依据记忆铁律：采购价=工厂价（不给工厂看销售）。
// 注意：这两个字段仍标 amount:true，所以装货后照样被金额闸关掉，与其它金额一致。

// ── 字段定义 ─────────────────────────────────────────────────────
// db: 真实列名（表名.列名，供人读；实际 SQL 由 collab-master.js 按 block 手写，
//     这里只做"允许/禁止"判定源，不做 SQL 拼接，避免动态列名拼 SQL 的注入面）
// visibleTo: 允许下发的视角数组
// cost: true = 成本类字段，本草稿一律只给 internal（见上方冲突说明，无例外）
// amount: true = 金额类字段，受"阶段=after 金额闸"约束

export const ORDER_FIELDS = [
  { field: "order_no", db: "orders.order_no", visibleTo: ["internal", "fwd", "broker", "factory", "customer"] },
  { field: "status", db: "orders.status", visibleTo: ["internal", "fwd", "factory", "customer"] },
  { field: "etd", db: "orders.etd", visibleTo: VIEWS },
  { field: "eta", db: "orders.eta", visibleTo: VIEWS },
  { field: "delivery_date", db: "orders.delivery_date", visibleTo: ["internal", "customer"] },
  // 总件数/总毛重/总柜量 = 跨厂聚合口径，工厂/报关行绝不可见（防跳单反推别厂货量）
  { field: "total_qty", db: "orders.total_qty", visibleTo: ["internal", "customer"] },
  { field: "container_type", db: "orders.container_type", visibleTo: ["internal", "fwd", "trucker", "customer"] },
  // 成本类：只内部
  { field: "total_amount_factory", db: "orders.total_amount_factory", visibleTo: ["internal"], cost: true },
  { field: "profit", db: "orders.profit", visibleTo: ["internal"], cost: true },
  { field: "tax_rebate_amount", db: "orders.tax_rebate_amount", visibleTo: ["internal"], cost: true },
  { field: "margin_amount", db: "orders.margin_amount", visibleTo: ["internal"], cost: true },
  { field: "margin_pct", db: "orders.margin_pct", visibleTo: ["internal"], cost: true },
  // 金额类：客户只出卖价
  { field: "total_amount", db: "orders.total_amount", visibleTo: ["internal", "customer"], amount: true },
];

export const LINE_FIELDS = [
  { field: "product_name", db: "order_line_items.product_name / products.product_name_cn", visibleTo: ["internal", "factory", "customer"] },
  { field: "sku", db: "order_line_items.sku", visibleTo: ["internal", "factory"] },
  { field: "qty_ctn", db: "order_line_items.qty_ctn", visibleTo: ["internal", "factory", "customer"] },
  { field: "unit", db: "order_line_items.unit", visibleTo: ["internal", "factory", "customer"] },
  { field: "hs_code", db: "order_line_items.hs_code", visibleTo: ["internal", "broker"] },
  { field: "declaration_name", db: "order_line_items.declaration_name", visibleTo: ["internal", "broker"] },
  { field: "declaration_name_en", db: "order_line_items.declaration_name_en", visibleTo: ["internal", "broker"] },
  // 卖价：客户可见；金额闸约束
  { field: "unit_price", db: "order_line_items.unit_price", visibleTo: ["internal", "customer"], amount: true },
  { field: "subtotal", db: "order_line_items.subtotal", visibleTo: ["internal", "customer"], amount: true },
  // 申报金额：报关行的例外通道（见 DECLARED_AMOUNT_EXCEPTION_VIEW），仍是 amount 类
  { field: "declare_amount_per_box", db: "order_line_items.declare_amount_per_box", visibleTo: ["internal", "broker"], amount: true },
  // 采购结算价：工厂看自己的不算泄露（见上方裁决）；对其余任何外部视角一律不给
  { field: "factory_price", db: "order_line_items.factory_price", visibleTo: ["internal", "factory"], cost: true, amount: true },
  { field: "factory_subtotal", db: "order_line_items.factory_subtotal", visibleTo: ["internal", "factory"], cost: true, amount: true },
];

// 客户/内部识别字段：谁是这票货的客户。工厂/报关行/车队/货代/保险一律不可见——
// 客户名+客户订单号组合本身就是可跳单反查的信息，同"总件数"一类风险，默认不给。
export const IDENTITY_FIELDS = [
  { field: "customer_name", db: "orders.customer / customer_en", visibleTo: ["internal", "customer"] },
  { field: "issuing_company", db: "orders.issuing_company", visibleTo: ["internal", "customer"] },
];

// document_files：只 order 级绑定（bound_subject_type='order'），装 shipping_plan 级
// 绑定的单证（如主 BL/装箱单）对 factory/broker 视角物理不查——那类单证常带跨厂汇总数据。
export const DOC_FIELDS = [
  { field: "doc_kind", db: "document_files.doc_kind", visibleTo: ["internal", "broker", "factory", "customer"] },
  { field: "display_name", db: "document_files.display_name", visibleTo: ["internal", "broker", "factory", "customer"] },
  { field: "storage_url", db: "document_files.storage_url", visibleTo: ["internal", "broker", "factory", "customer"] },
  { field: "uploaded_at", db: "document_files.uploaded_at", visibleTo: ["internal", "broker", "factory", "customer"] },
];

// customs_invoice_status：PK (customs_no, factory_code)，天然按厂分行，报关行/工厂视角
// 必须用 meta.factory_code 过滤，未指定 = 空（fail-closed，见 collab-master.js）。
export const CUSTOMS_FIELDS = [
  { field: "customs_no", db: "customs_invoice_status.customs_no", visibleTo: ["internal", "broker", "factory"] },
  { field: "status", db: "customs_invoice_status.status", visibleTo: ["internal", "broker", "factory"] },
  // 申报金额 = 例外①，broker 专属；factory 不给（工厂不需要看报关口径金额）
  { field: "system_expected_amount", db: "customs_invoice_status.system_expected_amount", visibleTo: ["internal", "broker"], amount: true },
  { field: "manual_expected_amount", db: "customs_invoice_status.manual_expected_amount", visibleTo: ["internal", "broker"], amount: true },
  { field: "expected_amount_source", db: "customs_invoice_status.expected_amount_source", visibleTo: ["internal", "broker"] },
];

// container_bookings：车队视角唯一入口，按 meta.container_nos 白名单过滤，未列明 = 空。
export const CONTAINER_FIELDS = [
  { field: "container_no", db: "container_bookings.container_no", visibleTo: ["internal", "fwd", "trucker"] },
  { field: "seal_no", db: "container_bookings.seal_no", visibleTo: ["internal", "fwd", "trucker"] },
  { field: "container_type", db: "container_bookings.container_type", visibleTo: ["internal", "fwd", "trucker"] },
  { field: "tare_weight_kg", db: "container_bookings.tare_weight_kg", visibleTo: ["internal", "trucker"] },
  { field: "pickup_time", db: "container_bookings.pickup_time", visibleTo: ["internal", "trucker"] },
  { field: "pickup_yard", db: "container_bookings.pickup_yard", visibleTo: ["internal", "trucker"] },
  { field: "return_yard", db: "container_bookings.return_yard", visibleTo: ["internal", "trucker"] },
  { field: "loading_address", db: "container_bookings.loading_address", visibleTo: ["internal", "trucker"] },
  { field: "loading_contact", db: "container_bookings.loading_contact", visibleTo: ["internal", "trucker"] },
  { field: "truck_plate", db: "container_bookings.truck_plate", visibleTo: ["internal", "trucker"], editableBy: ["trucker"] },
  { field: "trailer_plate", db: "container_bookings.trailer_plate", visibleTo: ["internal", "trucker"], editableBy: ["trucker"] },
  { field: "driver_name", db: "container_bookings.driver_name", visibleTo: ["internal", "trucker"], editableBy: ["trucker"] },
  { field: "driver_phone", db: "container_bookings.driver_phone", visibleTo: ["internal", "trucker"], editableBy: ["trucker"] },
];

// insurance_policies：按 bl_no 关联；insured_amount 本质是"投保金额/申报价值"，不是
// Sanlyn 内部成本，保险公司/保险视角本来就需要它来核保，不受 cost 标记约束，但仍是
// amount 类，受金额闸约束（装货后按字面规则一样清零，同例外②的悬而未决问题）。
export const INSURANCE_FIELDS = [
  { field: "policy_no", db: "insurance_policies.policy_no", visibleTo: ["internal", "insurer"] },
  { field: "status", db: "insurance_policies.status", visibleTo: ["internal", "insurer"] },
  { field: "cargo_description", db: "insurance_policies.cargo_description", visibleTo: ["internal", "insurer"] },
  { field: "packing_qty", db: "insurance_policies.packing_qty", visibleTo: ["internal", "insurer"] },
  { field: "invoice_amount", db: "insurance_policies.invoice_amount", visibleTo: ["internal", "insurer"], amount: true },
  { field: "insured_amount", db: "insurance_policies.insured_amount", visibleTo: ["internal", "insurer"], amount: true },
  { field: "insurer", db: "insurance_policies.insurer", visibleTo: ["internal", "insurer"] },
];

// 客户金额锚：只在 finance_export_rebates 有报关锚定行时才给值，无锚='待报关'，
// 绝不用 orders.declare_amount / OLI 等其它字段顶替（feedback_customs_declaration_master_truth）。
export const PRICE_ANCHOR_FIELDS = [
  { field: "declared_anchor_cny", db: "finance_export_rebates.fob_cny (SUM)", visibleTo: ["internal", "customer"], amount: true },
];

const ALL_BLOCKS = {
  order: ORDER_FIELDS, line: LINE_FIELDS, doc: DOC_FIELDS, customs: CUSTOMS_FIELDS,
  container: CONTAINER_FIELDS, insurance: INSURANCE_FIELDS, priceAnchor: PRICE_ANCHOR_FIELDS,
  identity: IDENTITY_FIELDS,
};

// 返回某 block 在某视角下允许下发的 field 名数组（默认拒绝：不在表里的一律不给）
export function allowedFields(blockName, view) {
  const block = ALL_BLOCKS[blockName] || [];
  return block.filter(f => f.visibleTo.includes(view)).map(f => f.field);
}

// 阶段=after 时，view 是否仍保留某字段（amount 类默认全部清零，唯一按 view 整体豁免的
// 是 AMOUNT_GATE_EXEMPT_VIEWS 里的视角——目前只有 broker）
export function amountAllowedAfterLoading(view) {
  return AMOUNT_GATE_EXEMPT_VIEWS.includes(view);
}

// 投影一行数据：只保留 allowed 字段名，且阶段=after 时按 amountAllowedAfterLoading 清零
// amount 类字段（除非该字段本身不是 amount 类）。
export function projectRow(blockName, view, stage, row) {
  const block = ALL_BLOCKS[blockName] || [];
  const meta = new Map(block.map(f => [f.field, f]));
  const out = {};
  for (const field of allowedFields(blockName, view)) {
    const def = meta.get(field);
    if (def.amount && stage === "after" && !amountAllowedAfterLoading(view)) {
      out[field] = null; // 金额闸：装货后清零，不是不返回键（前端好判断"被闸掉"vs"本来没有"）
      out[`${field}_gated`] = "after_loading";
      continue;
    }
    out[field] = Object.prototype.hasOwnProperty.call(row, field) ? row[field] : null;
  }
  return out;
}
