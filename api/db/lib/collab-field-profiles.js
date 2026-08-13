const INTERNAL_PROFILES = new Set(["shipping_booking", "upstream_downstream"]);

// 🔴 CY内部号铁律(2026-08-05 Damon)：CY开头=Sanlyn内部代码，对外一律不下发。
//    _id 同样禁 —— 它常含客户名(sp_enrich_.../TAOLAN-TRK-...)，等于泄漏客户身份。
//    外部方看 ext_ref：工厂=订单号，货代/船司=BL或SO。
const PUBLIC_SHEET_FIELDS = [
  "id", "ext_ref", "is_booked", "pol", "pod", "etd", "eta", "atd", "ata", "current_status_cn", "container_type",
  "container_qty", "collab_status", "total_cartons", "gross_weight_kg",
  "total_cbm", "so_no", "bl_no", "cargo_cutoff", "carrier_code", "vessel",
  "voyage", "release_type", "is_transfer", "so_info", "collab_uploads",
  "quarantine_docs", "has_quarantine", "containers_live", "containers_detail",
  "sailings", "trucking_detail", "factory_submitted", "factory_cargo_ready",
  "factory_container_type", "factory_cargo_type", "factory_remarks",
  "factory_submitted_at", "customer_submitted", "customer_reference_no",
  "customer_remarks", "customer_submitted_at", "factory_loading_done",
  "scope_missing", "pricing", "factory_progress", "orders", "factory_cargo",
  "factory_attrs", "factory_entry", "customer_item_notes", "customer_amend",
  "bl_confirmation",
  "customs_arrange", "trucking_arrange", "forwarder_cn", "forwarder_en",
  "trucking_company_cn", "trucking_cn", "customs_broker_cn", "customs_cn",
  "logistics_provider_kind", "trade_owner_kind",
  "so_bl_reference", "so_bl_ref_pending",
];

const FORBIDDEN_KEYS = new Set([
  "_cost_lines_raw", "cost", "cost_amount", "amount_cost", "payable_amount",
  "supplier_amount", "gross_profit", "profit", "margin", "counterparty_amount",
  "counterparty_company_code", "payer_company_code", "supplier_company_code",
  "freight_sale_usd", "rate_usd", "customer_name", "customer_en",
  "freight_term", "plan_freight_term",
]);

const FACTORY_CUSTOMS_FORBIDDEN_KEYS = new Set([
  "unit_price", "unit_price_ex", "amount", "declaration_amount", "declare_amount",
  "effective_expected_amount", "system_expected_amount", "manual_expected_amount",
  "expected_amount", "diff_amount", "sale_amount", "sales_amount", "gross_profit",
  "baoguan_amount", "lines_total", "total_incl",
]);

const FACTORY_CUSTOMS_FORBIDDEN_TEXT = ["销售", "毛利"];

// 🔴 客户绝不该看到工厂身份（Damon 2026-08-08：「去掉工厂信息，只看到产品和柜子」）
//    实测客户 token 返回里工厂名出现 12 次，分布在 orders[].factory /
//    containers_detail[].factory / factory_cargo[].factory_label。
//    看到工厂 = 客户有绕过我们直连工厂的可能，这是生意的根。
//    ⚖️ 在【权限层】砍，不在 UI 层藏 —— UI 藏起来的东西，F12 照样看得到。
const FACTORY_IDENTITY_KEYS = new Set([
  "factory", "factory_label", "factory_name", "factory_cn", "factory_en",
  "factory_code", "factory_company_id", "manufacturer", "manufacturer_name",
  "supplier_name", "supplier_cn",
]);

function stripFactoryIdentityDeep(node) {
  if (Array.isArray(node)) { node.forEach(stripFactoryIdentityDeep); return; }
  if (!node || typeof node !== "object") return;
  for (const k of Object.keys(node)) {
    if (FACTORY_IDENTITY_KEYS.has(k)) { delete node[k]; continue; }
    stripFactoryIdentityDeep(node[k]);
  }
}

const COUNTERPARTY_KEYS = new Set([
  "counterparty", "counterparty_name", "counterparty_code", "counterparty_company_code",
  "payer_company_code", "supplier_company_code", "customer_code", "customer_company_code",
]);

export const FIELD_PROFILES = Object.freeze({
  minimal: {
    sheetFields: ["id", "ext_ref", "pol", "pod", "etd", "eta", "container_type", "container_qty", "so_no", "bl_no"],
    billingSegment: "supplier",
    directions: [],
    allowCostAmount: false,
    scopes: [],
  },
  carrier: {
    sheetFields: PUBLIC_SHEET_FIELDS.filter(k => !["pricing", "orders", "factory_cargo", "factory_attrs", "factory_entry", "customer_item_notes", "customer_amend"].includes(k)),
    billingSegment: "ocean",
    directions: ["payable"],
    allowCostAmount: false,
    scopes: ["freight", "origin"],
  },
  customer: {
    sheetFields: [...PUBLIC_SHEET_FIELDS, "customer_selected_sailing", "freight_term", "plan_freight_term"],
    billingSegment: "customer",
    directions: ["receivable"],
    allowCostAmount: false,
    scopes: ["freight"],
  },
  factory: {
    // factory_purchase_term = 工厂→巴匕的【采购侧】成交方式(2026-08-05)。
    // ⚠️ 与 freight_term(对客条款,FORBIDDEN_KEYS 禁止外露)是两回事,别混。
    // 2026-08-06 追加排除:船期/港口/船名/提单号 —— 工厂的下游是厦门巴匕不是最终客户,
    // 海运怎么走跟他无关,下发等于把物流安排暴露给上游(Damon 2026-08-05)。
    // cargo_cutoff 同批删(Damon 2026-08-06 拍板):页面本来就没渲染它,删了工厂零感知;
    // 留着等于在刚做完的隔离上开个 F12 后门。
    sheetFields: [...PUBLIC_SHEET_FIELDS.filter(k => !["pricing", "sailings", "customer_item_notes", "customer_amend", "forwarder_cn", "forwarder_en",
      "pol", "pod", "etd", "eta", "vessel", "voyage", "carrier_code", "so_no", "bl_no", "release_type", "cargo_cutoff"].includes(k)), "factory_purchase_term"],
    billingSegment: "factory",
    directions: ["payable"],
    allowCostAmount: false,
    scopes: ["origin", "declaration", "review", "factory"],
  },
  shipping_booking: {
    sheetFields: null,
    billingSegment: "all",
    directions: ["receivable", "payable", "both"],
    allowCostAmount: true,
    scopes: ["all"],
  },
  upstream_downstream: {
    sheetFields: null,
    billingSegment: "all",
    directions: ["receivable", "payable", "both"],
    allowCostAmount: true,
    scopes: ["all"],
  },
  // 车队(2026-08-06 Damon 权限矩阵)：只要"去哪装、几个柜、多重、几点前进场、送哪个场站"。
  // 客户抬头/船名航次/提单号/目的港/费用一律不下发 —— 车队是最外围一环，
  // 给客户身份等于把客户暴露给最外圈。
  trucking: {
    sheetFields: [
      "id", "ext_ref", "collab_status", "scope_missing",
      "container_type", "container_qty", "containers_live", "containers_detail",
      "total_cartons", "gross_weight_kg", "total_cbm",
      "pol", "cargo_cutoff",
      "trucking_detail", "trucking_arrange", "trucking_company_cn", "trucking_cn",
      "factory_submitted", "factory_loading_done", "factory_cargo_ready", "collab_uploads",
    ],
    billingSegment: "truck",
    directions: ["payable"],
    allowCostAmount: false,
    scopes: ["truck"],
  },
  // 报关行(2026-08-06 Damon 权限矩阵)：品名数量重量+船名航次+柜号+报检件 —— 报关单上都要填。
  // 运价/港杂/货代账单/托书保函/SO/拖车安排与报关无关，给了会被拿去比价。
  broker: {
    sheetFields: [
      "id", "ext_ref", "bl_no", "collab_status", "scope_missing",
      "pol", "pod", "etd", "vessel", "voyage", "is_transfer",
      "container_type", "container_qty", "containers_live", "containers_detail",
      "total_cartons", "gross_weight_kg", "total_cbm",
      "orders", "factory_cargo",
      "quarantine_docs", "has_quarantine",
      "customs_arrange", "customs_broker_cn", "customs_cn", "collab_uploads",
    ],
    billingSegment: "customs",
    directions: ["payable"],
    allowCostAmount: false,
    scopes: ["customs", "declaration"],
  },
  shipper: {
    sheetFields: ["id", "_id", "shipment_no", "bl_no", "container_type", "container_qty", "scope_missing"],
    billingSegment: "port_charge",
    directions: ["receivable"],
    allowCostAmount: false,
    scopes: ["origin", "port_charge"],
  },
});

export function profileFor({ role, field_profile } = {}) {
  const explicit = clean(field_profile);
  if (FIELD_PROFILES[explicit]) return FIELD_PROFILES[explicit];
  if (explicit) return FIELD_PROFILES.minimal;
  if (role === "customer_booking") return FIELD_PROFILES.customer;
  if (role === "factory_booking") return FIELD_PROFILES.factory;
  if (role === "trucking_booking") return FIELD_PROFILES.trucking;
  if (role === "broker_booking") return FIELD_PROFILES.broker;
  if (role === "shipper_booking") return FIELD_PROFILES.shipper;
  if (role === "supplier_portal") return FIELD_PROFILES.carrier;
  return FIELD_PROFILES.minimal;
}

export function billingSegmentFor({ role, field_profile } = {}) {
  return profileFor({ role, field_profile }).billingSegment || "supplier";
}

export function sanitizeSheet(sheet, { role, field_profile, plan } = {}) {
  const profile = profileFor({ role, field_profile });
  const safe = clonePlain(sheet || {});
  if (Array.isArray(profile.sheetFields)) keepOnly(safe, profile.sheetFields);
  if (!profile.allowCostAmount) redactDeep(safe, { allowSale: role === "customer_booking" || field_profile === "customer" });
  if (role === "supplier_portal" && !INTERNAL_PROFILES.has(clean(field_profile))) {
    delete safe.customer_name;
    delete safe.customer_en;
    delete safe.freight_term;
    delete safe.plan_freight_term;
  }
  if (profile === FIELD_PROFILES.minimal) {
    safe.orders = [];
    safe.factory_cargo = [];
    safe.containers_live = [];
    safe.containers_detail = [];
    safe.scope_missing = true;
  }
  // 客户视角：抹掉一切工厂身份（产品、柜子照给，工厂是谁不给）
  if (role === "customer_booking" || clean(field_profile) === "customer") {
    stripFactoryIdentityDeep(safe);
  }
  delete safe.freight_sale_usd;
  // 🔴 兜底硬闸：内部标识绝不外发。即使有人把它加回白名单，这里也拦得住。
  if (!INTERNAL_PROFILES.has(clean(field_profile))) {
    delete safe.shipment_no;
    delete safe._id;
    delete safe.plan_business_id;
  }
  return safe;
}

export function visibleBillLines(lines, { field_profile, role, plan, resolvedPartyCode } = {}) {
  const profile = profileFor({ role, field_profile });
  const partyCode = clean(resolvedPartyCode).toUpperCase();
  const internal = Boolean(profile.allowCostAmount);
  if (!Array.isArray(lines)) return [];
  return lines.flatMap(line => {
    if (!line || typeof line !== "object") return [];
    if (!internal && !lineBelongsToProfile(line, profile, partyCode)) return [];
    // 只按"航段"词汇(fob_scope/segment)过滤; ownership_scope(trade/logistics)是另一套词汇, 不参与航段过滤,
    // 该行归属已由 party+direction 定死(lineBelongsToProfile), 无航段标记时不再二次拒绝。
    const scope = clean(line.fob_scope || line.segment).toLowerCase();
    if (!internal && !scopeAllowed(profile, scope)) return [];
    return [amountView(line, profile, internal)];
  });
}

export function scrubFactoryCustomsPayload(payload) {
  return redactFactoryCustomsDeep(clonePlain(payload));
}

function lineBelongsToProfile(line, profile, partyCode) {
  const direction = clean(line.direction || line.line_side).toLowerCase();
  if (profile.directions.length && !profile.directions.includes(direction)) return false;
  const hasPartyColumns = ["payer_company_code", "counterparty_company_code", "supplier_company_code"]
    .some(k => clean(line[k]));
  if (!hasPartyColumns) return true;
  if (!partyCode) return false;
  if (direction === "receivable") {
    return codeMatches(line.payer_company_code, partyCode) || codeMatches(line.counterparty_company_code, partyCode);
  }
  if (direction === "payable") {
    return codeMatches(line.supplier_company_code, partyCode);
  }
  return false;
}

function amountView(line, profile, internal) {
  if (internal) return clonePlain(line);
  const { amount, sale_amount, unit_price, cost_amount, gross_profit, cost, sale,
    supplier_amount, payer_company_code, supplier_company_code, counterparty_company_code,
    counterparty_amount, raw, ...safe } = line;
  const direction = clean(line.direction || line.line_side).toLowerCase();
  const visible = direction === "receivable" ? sale_amount ?? amount : amount;
  safe.amount = money(visible);
  safe.unit_price = money(line.qty ? money(visible) / Number(line.qty || 1) : visible);
  safe.currency = clean(line.currency || "CNY", 8).toUpperCase();
  return safe;
}

function scopeAllowed(profile, scope) {
  if (!profile.scopes.length || profile.scopes.includes("all")) return true;
  if (!scope) return true; // 无航段标记: 归属已由 party+direction 定, 不再按航段拒绝
  return profile.scopes.includes(scope);
}

function redactDeep(value, opts = {}) {
  if (Array.isArray(value)) {
    value.forEach(v => redactDeep(v, opts));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || COUNTERPARTY_KEYS.has(key) || (!opts.allowSale && key === "sale_amount")) {
      delete value[key];
      continue;
    }
    redactDeep(value[key], opts);
  }
  return value;
}

function redactFactoryCustomsDeep(value) {
  if (Array.isArray(value)) {
    value.forEach(redactFactoryCustomsDeep);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    if (FACTORY_CUSTOMS_FORBIDDEN_KEYS.has(lower) || FACTORY_CUSTOMS_FORBIDDEN_TEXT.some((word) => key.includes(word))) {
      delete value[key];
      continue;
    }
    redactFactoryCustomsDeep(value[key]);
  }
  return value;
}

function keepOnly(obj, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) if (!allowed.has(key)) delete obj[key];
}

function codeMatches(value, partyCode) {
  return clean(value).toUpperCase() === partyCode;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
