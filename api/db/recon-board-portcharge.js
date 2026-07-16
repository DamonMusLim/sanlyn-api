// recon-board-portcharge.js
// 港杂费比价提示(仅航线无关杂费,航线相关的海运费/THC/拖车费不比价)。
// 历史均价源 = freight_supplier_bills(排除 rebill_status=voided),口径与 skill freight-price-compare 一致。
// 从 recon-board.js 拆出,保持主文件 ≤500 行。

// 归一化供应商名(与 supplier-bills-reconcile.js NORM_NAME_SQL 同口径:全/半角括号统一+去首尾空白)。
const NORM_SUPPLIER_SQL = `
  COALESCE(
    NULLIF(btrim(replace(replace(COALESCE(supplier, ''), '（', '('), '）', ')')), ''),
    '(未命名)'
  )`;

// 11 个航线无关港杂费目 → raw cost_category 精确匹配(库内实测枚举,见 2026-07-16 探查)。
// 不做正则/ILIKE 模糊匹配,避免"操作费"误吞"港口作业费/码头操作费(真THC)"等相邻词导致误标。
export const PORT_CHARGE_BUCKETS = [
  { key: "doc", label: "单证费", categories: ["单证费", "单证费用", "document", "出口单证操作费", "出口服务费", "打单费", "签单费", "条形码", "条形码费"] },
  { key: "telex", label: "电放费", categories: ["电放费", "telex_release", "出SWB"] },
  { key: "booking", label: "订舱费", categories: ["订舱费", "套柜费", "预配费"] },
  { key: "seal", label: "封签费", categories: ["封签费", "封条费", "封签", "铅封费"] },
  { key: "vgm", label: "VGM", categories: ["VGM", "VGM申报费", "VGM称重费"] },
  { key: "eir", label: "EIR", categories: ["EIR", "EIR及铅封", "设备交接费", "设备交接单费", "设备管理费", "equip_interchange"] },
  { key: "operation", label: "操作费", categories: ["操作费", "handling"] },
  { key: "amendment", label: "改单费", categories: ["改单费", "改舱单费"] },
  { key: "manifest", label: "舱单费", categories: ["舱单费", "舱单信息费", "箱单费", "电子装箱单", "电子箱单", "电子装箱费", "箱单", "舱单", "manifest", "packing", "装箱费"] },
  { key: "customs", label: "报关费", categories: ["报关费", "customs", "customs_declaration", "转关费", "申报服务费", "申报费", "二次申报费"] },
  { key: "lumpsum", label: "包干费", categories: ["包干费"] },
];

const CATEGORY_TO_BUCKET = new Map();
const ALL_CATEGORIES = [];
for (const b of PORT_CHARGE_BUCKETS) {
  for (const c of b.categories) {
    CATEGORY_TO_BUCKET.set(c, b);
    ALL_CATEGORIES.push(c);
  }
}

const HIGH_THRESHOLD = 1.2; // 超均价 20% 标高价(skill freight-price-compare 口径)
const MIN_SAMPLE = 3; // 样本 <3 标"样本不足",不硬比

function normSupplier(name) {
  return String(name ?? "").trim().replace(/（/g, "(").replace(/）/g, ")") || "(未命名)";
}

// 单价口径:unit_price 优先,否则 amount/qty(按柜),再否则整票 amount 兜底(与 freight-price-compare 一致)。
export function unitOf(row) {
  const unitPrice = Number(row.unit_price);
  if (Number.isFinite(unitPrice) && unitPrice > 0) return unitPrice;
  const qty = Number(row.qty);
  const amount = Number(row.amount);
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(amount)) return amount / qty;
  return Number.isFinite(amount) ? amount : null;
}

export function classifyPortCharge(costCategory) {
  return CATEGORY_TO_BUCKET.get(String(costCategory ?? "").trim()) || null;
}

// 拉一次全量港杂费历史行(排除 voided,仅 CNY,仅目标费目),在 JS 里按(供应商,费目桶)聚合。
// 一次查询覆盖所有货代/所有票,handleBoard 每次请求只跑一次,不随行数放大。
export async function fetchPortChargeHistory(pool) {
  const sql = `
    SELECT supplier, cost_category, amount, qty, unit_price
      FROM freight_supplier_bills
     WHERE COALESCE(rebill_status, '') <> 'voided'
       AND COALESCE(currency_norm, currency, 'CNY') = 'CNY'
       AND cost_category = ANY($1)`;
  const r = await pool.query(sql, [ALL_CATEGORIES]);
  const bySupplierBucket = new Map(); // key: normSupplier|bucketKey -> units[]
  const byBucket = new Map(); // key: bucketKey -> { supplierUnits: Map<supplier, units[]> }
  for (const row of r.rows) {
    const bucket = classifyPortCharge(row.cost_category);
    if (!bucket) continue;
    const unit = unitOf(row);
    if (unit === null || !Number.isFinite(unit) || unit <= 0) continue;
    const supplier = normSupplier(row.supplier);
    const sbKey = `${supplier}|${bucket.key}`;
    if (!bySupplierBucket.has(sbKey)) bySupplierBucket.set(sbKey, []);
    bySupplierBucket.get(sbKey).push(unit);
    if (!byBucket.has(bucket.key)) byBucket.set(bucket.key, new Map());
    const supplierUnits = byBucket.get(bucket.key);
    if (!supplierUnits.has(supplier)) supplierUnits.set(supplier, []);
    supplierUnits.get(supplier).push(unit);
  }
  return { bySupplierBucket, byBucket };
}

function stats(units) {
  if (!units || !units.length) return null;
  const sum = units.reduce((a, b) => a + b, 0);
  return {
    count: units.length,
    avg: Math.round((sum / units.length) * 100) / 100,
    min: Math.round(Math.min(...units) * 100) / 100,
    max: Math.round(Math.max(...units) * 100) / 100,
  };
}

// 单个港杂费账单行 → 比价结果(供该货代该票展示)。history 来自 fetchPortChargeHistory 的返回值。
export function computePortChargeCheck(billLine, supplierName, history) {
  if (!billLine || !billLine.cost_category) return null;
  const bucket = classifyPortCharge(billLine.cost_category);
  if (!bucket) return null;
  const unit = unitOf(billLine);
  if (unit === null || !Number.isFinite(unit) || unit <= 0) return null;
  const supplier = normSupplier(supplierName);
  const ownUnits = history.bySupplierBucket.get(`${supplier}|${bucket.key}`) || [];
  const own = stats(ownUnits);
  const marketSupplierUnits = history.byBucket.get(bucket.key) || new Map();
  let marketTotalCount = 0;
  const marketUnits = [];
  for (const units of marketSupplierUnits.values()) {
    marketTotalCount += units.length;
    marketUnits.push(...units);
  }
  const market = stats(marketUnits);
  let flag = "normal";
  let ratio = null;
  if (!own || own.count < MIN_SAMPLE) {
    flag = "insufficient_sample";
  } else {
    ratio = Math.round((unit / own.avg) * 100) / 100;
    flag = ratio >= HIGH_THRESHOLD ? "high" : "normal";
  }
  return {
    cost_category: billLine.cost_category,
    bucket_key: bucket.key,
    bucket_label: bucket.label,
    amount: money2(billLine.amount),
    qty: billLine.qty ?? null,
    unit: Math.round(unit * 100) / 100,
    bl_no: billLine.bl_no ?? null,
    flag,
    ratio,
    own_history: own,
    market_history: market
      ? { ...market, supplier_count: marketSupplierUnits.size, bill_count: marketTotalCount }
      : null,
  };
}

function money2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
