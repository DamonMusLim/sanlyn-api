// /api/db/hgj-template-195 - read-only HGJ 195 placeholder map and renderer data
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TEMPLATE = {
  code: "hgj-195",
  name: "海管家195模板",
  version: "v2026.09.28-1",
};

const MAP = [
  ["ocean_export", "shipping_order_nos", "海运出口", "订单编号", "shipping_plans", "order_nos"],
  ["ocean_export", "shipping_quote_ref", "海运出口", "报价编号", "shipping_plans", "quote_ref"],
  ["ocean_export", "shipping_customer", "海运出口", "委托单位", "shipping_plans", "customer"],
  ["ocean_export", "customer_reference_no", "海运出口", "客户业务编号", "shipping_plans", "customer_reference_no"],
  ["ocean_export", "shipping_created_at", "海运出口", "创建时间", "shipping_plans", "created_at"],
  ["ocean_export", "booking_agent", "海运出口", "订舱代理", "shipping_plans", "forwarder_cn"],
  ["ocean_export", "bl_no", "海运出口", "主单号", "shipping_plans", "bl_no"],
  ["ocean_export", "vessel", "海运出口", "船名", "shipping_plans", "vessel"],
  ["ocean_export", "voyage", "海运出口", "航次", "shipping_plans", "voyage"],
  ["ocean_export", "shipping_line", "海运出口", "船公司", "shipping_plans", "shipping_line"],
  ["ocean_export", "pol", "海运出口", "起运港", "shipping_plans", "pol"],
  ["ocean_export", "pod", "海运出口", "目的港", "shipping_plans", "pod"],
  ["ocean_export", "doc_cutoff_at", "海运出口", "截单时间", "shipping_plans", "doc_cutoff_at"],
  ["ocean_export", "container_type", "海运出口", "箱型箱量", "shipping_plans", "container_type"],
  ["ocean_export", "total_cartons", "海运出口", "委托总件数", "shipping_plans", "total_cartons"],
  ["ocean_export", "gross_weight_kg", "海运出口", "委托总毛重(KGS)", "shipping_plans", "gross_weight_kg"],
  ["ocean_export", "total_cbm", "海运出口", "委托总体积(CBM)", "shipping_plans", "total_cbm"],
  ["ocean_export", "freight_payment", "海运出口", "付款方式", "shipping_plans", "freight_payment"],
  ["ocean_export", "freight_term", "海运出口", "贸易条款", "shipping_plans", "freight_term"],
  ["ocean_export", "etd", "海运出口", "ETD", "shipping_plans", "etd"],
  ["ocean_export", "eta", "海运出口", "ETA", "shipping_plans", "eta"],
  ["ocean_export", "container_no", "海运出口", "箱号", "shipping_plans", "container_no"],
  ["ocean_export", "contract_nos", "海运出口", "合约号", "shipping_plans", "contract_nos"],
  ["ocean_export", "shipping_remarks", "海运出口", "操作备注", "shipping_plans", "remarks"],
  ["ocean_export", "company_code", "海运出口", "委托单位代码", "shipping_plans", "company_code"],
  ["ocean_export", "shipping_status", "海运出口", "订单状态", "shipping_plans", "status"],
  ["ocean_export", "dq_status", "海运出口", "异常", "shipping_plans", "dq_status"],
  ["order", "order_source", "待接单", "订单来源", "orders", "source"],
  ["order", "order_type", "待接单", "订单类型", "orders", "type"],
  ["order", "order_status", "待接单", "接单状态", "orders", "status"],
  ["order", "order_mode", "待接单", "业务类型", "orders", "mode"],
  ["order", "order_customer", "待接单", "委托单位", "orders", "customer"],
  ["order", "order_date", "待接单", "委托日期", "orders", "order_date"],
  ["order", "order_pol", "待接单", "起运港/上货站", "orders", "pol"],
  ["order", "order_pod", "待接单", "目的港/下货站", "orders", "destination_port"],
  ["order", "order_remarks", "待接单", "备注", "orders", "remarks"],
  ["order", "order_no", "待接单", "订单编号", "orders", "order_no"],
  ["order", "order_etd", "待接单", "ETD/班列日期", "orders", "etd"],
  ["order", "order_eta", "待接单", "ETA", "orders", "eta"],
  ["order", "order_bl_no", "待接单", "主单号", "orders", "bl_no"],
  ["customs", "broker_company_id", "报关信息", "报关行", "customs_declarations", "broker_company_id"],
  ["customs", "declared_at", "报关信息", "报关日期", "customs_declarations", "declared_at"],
  ["customs", "declaration_no", "报关信息", "报关单号", "customs_declarations", "declaration_no"],
  ["customs", "declaration_amount", "报关信息", "申报货值", "customs_declarations", "total_declaration_amount"],
  ["customs", "declaration_currency", "报关信息", "申报币种", "customs_declarations", "total_declaration_currency"],
  ["container", "container_info_no", "箱货信息", "箱号", "containers", "container_no"],
  ["container", "seal_no", "箱货信息", "封号", "containers", "seal_no"],
  ["container", "container_info_type", "箱货信息", "箱型", "containers", "container_type"],
  ["fee_detail", "fee_direction", "费用明细", "属性", "freight_supplier_bills", "direction"],
  ["fee_detail", "fee_bl_no", "费用明细", "主单号", "freight_supplier_bills", "bl_no"],
  ["fee_detail", "fee_settlement_company", "费用明细", "结算单位", "freight_supplier_bills", "supplier"],
  ["fee_detail", "fee_name", "费用明细", "费用名称", "freight_supplier_bills", "cost_category"],
  ["fee_detail", "fee_currency", "费用明细", "币种", "freight_supplier_bills", "currency"],
  ["fee_detail", "fee_amount", "费用明细", "金额", "freight_supplier_bills", "amount"],
  ["fee_detail", "fee_status", "费用明细", "费用状态", "freight_supplier_bills", "fee_status"],
  ["fee_detail", "fee_exchange_rate", "费用明细", "汇率", "freight_supplier_bills", "exchange_rate"],
  ["fee_detail", "fee_tax_rate", "费用明细", "税率(%)", "freight_supplier_bills", "tax_rate"],
  ["fee_detail", "fee_tax_amount", "费用明细", "税金", "freight_supplier_bills", "tax_amount"],
  ["fee_detail", "fee_total_price", "费用明细", "不含税总价", "freight_supplier_bills", "total_price"],
  ["bill", "bill_direction", "账单管理", "属性", "freight_bills", "direction"],
  ["bill", "bill_created_at", "账单管理", "创建时间", "freight_bills", "created_at"],
  ["bill", "bill_created_by", "账单管理", "创建人", "freight_bills", "created_by"],
  ["bill", "invoice_head_code", "账单管理", "发票抬头", "freight_bills", "invoice_head_code"],
  ["bill", "bill_status", "账单管理", "状态", "freight_bills", "status"],
  ["bill", "bill_currency", "账单管理", "币种", "freight_bills", "currency"],
  ["bill", "bill_settlement_company", "账单管理", "结算单位", "freight_bills", "settlement_company_code"],
  ["bill", "bill_amount", "账单管理", "账单金额", "freight_bills", "total_amount"],
  ["bill", "bill_no", "账单管理", "账单编号", "freight_bills", "bill_no"],
  ["invoice", "invoice_type", "开票记录", "发票类型", "finance_invoices_in", "invoice_type"],
  ["invoice", "invoice_format", "开票记录", "发票种类", "finance_invoices_in", "invoice_format"],
  ["invoice", "invoice_no", "开票记录", "发票号码", "finance_invoices_in", "invoice_no"],
  ["invoice", "void_status", "开票记录", "作废状态", "finance_invoices_in", "void_status"],
  ["invoice", "invoice_issue_date", "开票记录", "开票时间", "finance_invoices_in", "issue_date"],
  ["invoice", "invoice_status", "开票记录", "状态", "finance_invoices_in", "review_status"],
  ["invoice", "seller_name", "开票记录", "销货单位", "finance_invoices_in", "seller_name"],
  ["invoice", "buyer_name", "开票记录", "购货单位", "finance_invoices_in", "buyer_name"],
  ["invoice", "invoice_bl_nos", "开票记录", "主单号", "finance_invoices_in", "bl_nos"],
  ["invoice", "invoice_bill_amount", "开票记录", "账单金额", "finance_invoices_in", "amount_incl_tax"],
  ["invoice", "invoice_amount", "开票记录", "开票金额", "finance_invoices_in", "amount_incl_tax"],
  ["invoice", "amount_ex_tax", "开票记录", "不含税金额", "finance_invoices_in", "amount_ex_tax"],
  ["invoice", "invoice_tax_rate", "开票记录", "税率", "finance_invoices_in", "tax_rate"],
  ["invoice", "invoice_total_tax", "开票记录", "税额", "finance_invoices_in", "total_tax"],
  ["payment", "payment_id", "收付管理", "收付编号", "finance_payments", "_id"],
  ["payment", "paid_date", "收付管理", "收付日期", "finance_payments", "paid_date"],
  ["payment", "payment_direction", "收付管理", "属性", "finance_payments", "direction"],
  ["payment", "payment_currency", "收付管理", "币种", "finance_payments", "currency"],
  ["payment", "payment_amount", "收付管理", "金额", "finance_payments", "amount"],
  ["payment", "paid_amount", "收付管理", "已核销金额", "finance_payments", "paid_amount"],
  ["payment", "pending_amount", "收付管理", "未核销金额", "finance_payments", "pending_amount"],
  ["payment", "pay_type", "收付管理", "收付方式", "finance_payments", "pay_type"],
  ["payment", "bank_ref", "收付管理", "银行水单号", "finance_payments", "bank_ref"],
  ["settlement", "settlement_amount", "核销管理", "核销金额", "finance_settlement_links", "amount_applied"],
  ["settlement", "settlement_currency", "核销管理", "核销币种", "finance_settlement_links", "currency"],
  ["settlement", "settlement_created_at", "核销管理", "核销时间", "finance_settlement_links", "created_at"],
  ["settlement", "settlement_reason", "核销管理", "核销备注", "finance_settlement_links", "reason"],
  ["company", "company_name", "客户列表", "公司抬头", "companies", "name_cn"],
  ["company", "company_code", "客户列表", "代码", "companies", "code"],
  ["company", "company_created_at", "客户列表", "创建时间", "companies", "created_at"],
  ["company", "company_address", "客户列表", "地址", "companies", "address"],
  ["company", "company_type", "客户列表", "性质", "companies", "type"],
  ["company", "client_mode", "客户列表", "客户端", "companies", "client_mode"],
  ["quote", "quote_service", "单票报价", "业务类型", "service_rates", "service"],
  ["quote", "quote_pol", "单票报价", "起运港/上货站", "service_rates", "pol"],
  ["quote", "quote_pod", "单票报价", "目的港/下货站", "service_rates", "pod"],
  ["quote", "rate_source", "单票报价", "费率来源", "service_rates", "source"],
  ["charge_template", "template_agent", "费用模板", "订舱代理", "local_charges", "company_name"],
  ["charge_template", "template_carrier", "费用模板", "船公司", "local_charges", "carrier"],
  ["charge_template", "template_created_at", "费用模板", "创建时间", "local_charges", "created_at"],
  ["unmapped", "hgj_invoice_no_on_bill", "账单管理", "发票号", "", ""],
  ["unmapped", "hgj_bill_invoiced_at", "账单管理", "开票时间", "", ""],
  ["unmapped", "hgj_bill_settled_at", "账单管理", "核销时间", "", ""],
  ["unmapped", "hgj_bill_voucher_no", "账单管理", "财务凭证号", "", ""],
  ["unmapped", "hgj_bill_source", "账单管理", "账单来源", "", ""],
  ["unmapped", "hgj_bill_attachment", "账单管理", "附件", "", ""],
  ["unmapped", "hgj_fee_settled_amount", "费用明细", "已核销金额", "", ""],
  ["unmapped", "hgj_fee_unsettled_amount", "费用明细", "未核销金额", "", ""],
  ["unmapped", "hgj_fee_invoice_amount", "费用明细", "开票金额", "", ""],
];

const TABLES = Array.from(new Set(MAP.map(row => row[4]).filter(Boolean)));
const KEYS = ["id", "_id", "order_no", "contract_no", "shipment_no", "bl_no", "declaration_no", "bill_no", "invoice_no"];
const UNSET_VALUE_PLACEHOLDERS = new Set([
  "declaration_amount", "fee_amount", "fee_exchange_rate", "fee_tax_rate", "fee_tax_amount", "fee_total_price",
  "bill_amount", "invoice_bill_amount", "invoice_amount", "amount_ex_tax", "invoice_tax_rate", "invoice_total_tax",
  "payment_amount", "paid_amount", "pending_amount", "settlement_amount",
]);
const MAX_TEMPLATE_TEXT_LENGTH = 20000;

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function readTemplateText(req) {
  const raw = req.method === "POST" ? req.body?.template_text : req.query?.template_text;
  const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (text.length > MAX_TEMPLATE_TEXT_LENGTH) {
    const err = new Error("template_text too long");
    err.statusCode = 413;
    throw err;
  }
  return clean(text);
}

function quoteIdent(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("invalid identifier");
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function isZeroLike(value) {
  return /^[+-]?0+(\.0+)?$/.test(String(value == null ? "" : value).trim());
}

function isUnsetValue(row, value) {
  return isBlank(value) || (UNSET_VALUE_PLACEHOLDERS.has(row.placeholder) && isZeroLike(value));
}

function rate(filled, total) {
  if (!total) return null;
  return Number((filled / total).toFixed(4));
}

function formatValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function placeholderRows() {
  return MAP.map(row => ({
    group: row[0],
    placeholder: row[1],
    module: row[2],
    label: row[3],
    source_table: row[4],
    source_column: row[5],
  }));
}

async function loadColumns(pool) {
  const result = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    ["public", TABLES]
  );
  const map = new Map();
  result.rows.forEach(row => {
    if (!map.has(row.table_name)) map.set(row.table_name, new Set());
    map.get(row.table_name).add(row.column_name);
  });
  return map;
}

async function loadCoverage(pool, columns, rows) {
  const grouped = new Map();
  rows.forEach(row => {
    if (!columns.get(row.source_table)?.has(row.source_column)) return;
    if (!grouped.has(row.source_table)) grouped.set(row.source_table, []);
    grouped.get(row.source_table).push(row);
  });

  const out = new Map();
  for (const [table, fields] of grouped.entries()) {
    const tableSql = quoteIdent(table);
    const selectSql = fields.map((field, idx) => {
      const col = quoteIdent(field.source_column);
      const filled = `${col} IS NOT NULL AND NULLIF(btrim(${col}::text), '') IS NOT NULL`;
      const valueSet = UNSET_VALUE_PLACEHOLDERS.has(field.placeholder)
        ? `${filled} AND NOT (${col}::text ~ '^\\s*[+-]?0+(\\.0+)?\\s*$')`
        : filled;
      return `count(*) FILTER (WHERE ${valueSet}) AS c${idx}`;
    }).join(", ");
    const result = await pool.query(`SELECT count(*) AS total, ${selectSql} FROM public.${tableSql}`);
    const data = result.rows[0] || {};
    const total = Number(data.total || 0);
    fields.forEach((field, idx) => {
      const filled = Number(data[`c${idx}`] || 0);
      out.set(field.placeholder, { total_count: total, filled_count: filled, fill_rate: rate(filled, total) });
    });
  }
  return out;
}

function isConfiguredPlaceholder(row) {
  return UNSET_VALUE_PLACEHOLDERS.has(row.placeholder);
}

function rowState(row, columns, coverage) {
  if (!row.source_table || !row.source_column) return { state: "not_connected", reason: `缺映射字段 ${row.module}.${row.label}`, total_count: null, filled_count: null, fill_rate: null };
  if (!columns.has(row.source_table)) return { state: "not_connected", reason: `缺表 ${row.source_table}，无法读取 ${row.source_table}.${row.source_column}`, total_count: null, filled_count: null, fill_rate: null };
  if (!columns.get(row.source_table).has(row.source_column)) return { state: "not_connected", reason: `缺字段 ${row.source_table}.${row.source_column}`, total_count: null, filled_count: null, fill_rate: null };
  const cov = coverage.get(row.placeholder) || { total_count: null, filled_count: null, fill_rate: null };
  if (!cov.total_count) return { state: "not_connected", reason: `缺 ${row.source_table}.${row.source_column} 可统计记录`, ...cov };
  if (!cov.filled_count && isConfiguredPlaceholder(row)) return { state: "not_configured", reason: `未设置 ${row.source_table}.${row.source_column} 有效值`, ...cov };
  if (!cov.filled_count) return { state: "not_connected", reason: `缺 ${row.source_table}.${row.source_column} 已填值`, ...cov };
  return { state: "ready", reason: "", ...cov };
}

async function sampleForTable(pool, columns, table, recordKey) {
  if (!columns.has(table)) return null;
  const tableSql = quoteIdent(table);
  const keyColumns = KEYS.filter(key => columns.get(table).has(key));
  if (recordKey && keyColumns.length) {
    const clauses = keyColumns.map((key, idx) => `${quoteIdent(key)}::text = $${idx + 1}`);
    const params = keyColumns.map(() => recordKey);
    const hit = await pool.query(`SELECT * FROM public.${tableSql} WHERE ${clauses.join(" OR ")} LIMIT 1`, params);
    if (hit.rows[0]) return hit.rows[0];
  }
  return null;
}

async function loadValues(pool, columns, rows, recordKey) {
  const tableRows = new Map();
  for (const table of TABLES) tableRows.set(table, await sampleForTable(pool, columns, table, recordKey));
  const values = {};
  rows.forEach(row => {
    const data = tableRows.get(row.source_table);
    const value = data && columns.get(row.source_table)?.has(row.source_column) ? formatValue(data[row.source_column]) : "";
    values[row.placeholder] = isUnsetValue(row, value) ? "" : value;
  });
  return values;
}

function missingReason(row, key = "") {
  if (!row) return key ? `缺占位符 {{${key}}} 的映射字段` : "缺映射字段";
  if (row.state === "ready") return `缺当前记录 ${row.source_table}.${row.source_column} 值`;
  return row.reason || `缺字段 ${[row.source_table, row.source_column].filter(Boolean).join(".") || `${row.module}.${row.label}`}`;
}

function fillRateText(row) {
  if (!row?.fill_rate || Number(row.fill_rate) <= 0) return "未接入";
  return `${Math.round(Number(row.fill_rate) * 1000) / 10}%`;
}

function missingLabel(row) {
  return row && UNSET_VALUE_PLACEHOLDERS.has(row.placeholder) && row.state !== "not_connected" ? "未设置" : "未接入";
}

function renderText(templateText, values, rows) {
  const missing = [];
  const renderedText = clean(templateText).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = values[key];
    const row = rows.find(item => item.placeholder === key);
    if (!isUnsetValue(row || { placeholder: key }, value)) return value;
    const label = missingLabel(row);
    missing.push({ placeholder: key, status: label, reason: missingReason(row, key), fill_rate: row?.fill_rate ?? null });
    return `${label}(${missingReason(row, key)}；当前填充率 ${fillRateText(row)})`;
  });
  const renderedHtml = esc(clean(templateText)).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = values[key];
    const row = rows.find(item => item.placeholder === key);
    if (!isUnsetValue(row || { placeholder: key }, value)) return esc(value);
    const label = missingLabel(row);
    const reason = missingReason(row, key);
    const brief = `${label}(${reason}；当前填充率 ${fillRateText(row)})`;
    return `<span class="hgj-missing" title="${esc(`${label} · ${reason}；当前填充率 ${fillRateText(row)}`)}">${esc(brief)}</span>`;
  });
  const seen = new Set();
  return { rendered: renderedText, rendered_text: renderedText, rendered_html: renderedHtml, missing_placeholders: missing.filter(item => {
    if (seen.has(item.placeholder)) return false;
    seen.add(item.placeholder);
    return true;
  }) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ success: false, error: "GET or POST required" });
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const rows = placeholderRows();
    const columns = await loadColumns(pool);
    const coverage = await loadCoverage(pool, columns, rows);
    const mapped = rows.map(row => ({ ...row, ...rowState(row, columns, coverage) }));
    const recordKey = clean(req.method === "POST" ? req.body?.record_key : req.query?.record_key);
    const values = await loadValues(pool, columns, rows, recordKey);
    const templateText = readTemplateText(req);
    const preview = templateText ? renderText(templateText, values, mapped) : { rendered: "", missing_placeholders: [] };
    const ready = mapped.filter(row => row.state === "ready").length;
    const notConnected = mapped.filter(row => row.state === "not_connected").length;
    const notConfigured = mapped.filter(row => row.state === "not_configured").length;
    return res.json({
      success: true,
      template: TEMPLATE,
      generated_at: new Date().toISOString(),
      record_key: recordKey,
      summary: { total: mapped.length, ready, not_connected: notConnected, not_configured: notConfigured, fill_rate: rate(ready, mapped.length) },
      mappings: mapped,
      values,
      preview,
    });
  } catch (err) {
    console.error("[hgj-template-195]", err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : "Internal server error" });
  }
}
