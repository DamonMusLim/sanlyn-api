const TRUCKING_CATEGORIES = ["拖车费", "trucking", "拖车运费", "内陆拖车费", "拖车+铁路运费"];

const OCEANBABY = {
  code: "OCEANBABY",
  name: "上海洋宝宝国际物流有限公司",
  tax_id: "91310106MAE9L4AQ28",
  bank_name: "中国银行厦门文灶支行",
  bank_account: "433849860868",
};

function clean(v) {
  return v == null ? "" : String(v).trim();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function addMissing(set, label) {
  if (label) set.add(label);
}

function hasDanger(verdicts) {
  return verdicts.some(v => v.level === "danger");
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(r.rows.map(row => row.column_name));
}

function bankFromCompany(row) {
  const fallback = clean(row?.code).toUpperCase() === "OCEANBABY" ? OCEANBABY : {};
  const raw = row?.bank_accounts;
  const accounts = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : []);
  const cny = accounts.find(a => clean(a.currency).toUpperCase() === "CNY" || clean(a.currency).toUpperCase() === "RMB") || accounts[0] || {};
  return {
    bank_name: clean(cny.bank_name || cny.bankName || cny.bank || cny.name) || fallback.bank_name || "",
    bank_account: clean(cny.account || cny.account_no || cny.bank_account || cny.bankAccount || cny.rmbAccount) || fallback.bank_account || "",
  };
}

async function companyByCode(pool, code) {
  if (!clean(code)) return null;
  const r = await pool.query(
    `SELECT code, name_cn, name_en, tax_id, bank_accounts
       FROM companies
      WHERE UPPER(code) = UPPER($1)
      LIMIT 1`,
    [code]
  );
  return r.rows[0] || null;
}

async function companyById(pool, id) {
  if (id == null || id === "") return null;
  const r = await pool.query(
    `SELECT code, name_cn, name_en, tax_id, bank_accounts
       FROM companies
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

function normalizeCompany(row, fallback) {
  const bank = bankFromCompany(row || fallback);
  return {
    code: clean(row?.code || fallback?.code),
    name: clean(row?.name_cn || row?.name_en || fallback?.name),
    tax_id: clean(row?.tax_id || fallback?.tax_id),
    bank_name: bank.bank_name || clean(fallback?.bank_name),
    bank_account: bank.bank_account || clean(fallback?.bank_account),
  };
}

async function loadPlan(pool, blNo, planCols) {
  const wanted = ["id", "customer_company_id", "customer_cn", "customer", "customer_en", "freight_rate_id"];
  const cols = wanted.filter(c => planCols.has(c));
  if (!cols.length) return null;
  const orderBy = planCols.has("created_at") ? "created_at DESC NULLS LAST, id DESC" : "id DESC";
  const r = await pool.query(
    `SELECT ${cols.join(", ")}
       FROM shipping_plans
      WHERE bl_no = $1
      ORDER BY ${orderBy}
      LIMIT 1`,
    [blNo]
  );
  return r.rows[0] || null;
}

async function loadBillSummary(pool, blNo, billCols) {
  if (!billCols.has("sale_amount")) return { amount_incl: null, payer_code: "", transport_lines: [] };
  const payerSelect = billCols.has("payer_company_code")
    ? `NULLIF((ARRAY_AGG(DISTINCT NULLIF(payer_company_code, '')))[1], '') AS payer_code,`
    : `NULL::text AS payer_code,`;
  const amountResult = await pool.query(
    `SELECT
       SUM(b.sale_amount)::numeric AS amount_incl,
       ${payerSelect}
       COUNT(*)::int AS bill_count
     FROM our_freight_cost_lines b
     WHERE b.bl_no = $1
       AND b.cost_category = ANY($2::text[])
       AND COALESCE(b.rebill_status, '') <> 'voided'`,
    [blNo, TRUCKING_CATEGORIES]
  );
  const row = amountResult.rows[0] || {};
  let transportLines = [];
  if (billCols.has("raw")) {
    const transportResult = await pool.query(
      `SELECT COALESCE(JSONB_AGG(t.line) FILTER (WHERE t.line IS NOT NULL), '[]'::jsonb) AS transport_lines
         FROM our_freight_cost_lines b
         LEFT JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(b.raw->'transport_lines') = 'array'
                THEN b.raw->'transport_lines' ELSE '[]'::jsonb END
         ) AS t(line) ON true
        WHERE b.bl_no = $1
          AND b.cost_category = ANY($2::text[])
          AND COALESCE(b.rebill_status, '') <> 'voided'`,
      [blNo, TRUCKING_CATEGORIES]
    );
    transportLines = transportResult.rows[0]?.transport_lines || [];
  }
  return {
    amount_incl: row.amount_incl == null ? null : Number(row.amount_incl),
    payer_code: clean(row.payer_code),
    transport_lines: Array.isArray(transportLines) ? transportLines : [],
  };
}

function normalizeTransportLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(line => ({
    transport_type: clean(line.transport_type || line.type || line.vehicle_type || line.kind),
    plate_no: clean(line.plate_no || line.plate || line.truck_no || line.vehicle_no || line.car_no),
    origin: clean(line.origin || line.from || line.loading_place || line.start_place),
    destination: clean(line.destination || line.to || line.unloading_place || line.end_place),
    cargo_name: clean(line.cargo_name || line.cargo || line.goods_name || line.product_name),
  }));
}

async function loadQuoteAmount(pool, plan, rateCols) {
  if (!plan?.freight_rate_id) return null;
  const quoteCols = [
    "trucking_quote_amount",
    "trucking_amount",
    "truck_quote_amount",
    "trucking_sale_amount",
    "customer_trucking_amount",
  ].filter(c => rateCols.has(c));
  if (!quoteCols.length) return null;
  const quoteExpr = quoteCols.length === 1
    ? `${quoteCols[0]}::numeric`
    : `COALESCE(${quoteCols.map(c => `${c}::numeric`).join(", ")})`;
  const r = await pool.query(
    `SELECT ${quoteExpr} AS quote_amount
       FROM freight_rates
      WHERE id = $1
      LIMIT 1`,
    [plan.freight_rate_id]
  );
  const n = Number(r.rows[0]?.quote_amount);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

export async function computePriceCheck(pool, { bl_no, invoice_amount, bill_cols, plan, rate_cols }) {
  const blNo = clean(bl_no);
  const invoiceAmount = invoice_amount == null ? null : round2(invoice_amount);
  let costAmount = null;
  if (bill_cols?.has("amount")) {
    const r = await pool.query(
      `SELECT SUM(amount)::numeric AS cost_amount
         FROM our_freight_cost_lines
        WHERE bl_no = $1
          AND cost_category = ANY($2::text[])
          AND COALESCE(rebill_status, '') <> 'voided'`,
      [blNo, TRUCKING_CATEGORIES]
    );
    costAmount = r.rows[0]?.cost_amount == null ? null : round2(r.rows[0].cost_amount);
  }
  const quoteAmount = await loadQuoteAmount(pool, plan, rate_cols || new Set());
  const grossProfit = invoiceAmount == null || costAmount == null ? null : round2(invoiceAmount - costAmount);
  const grossMargin = invoiceAmount > 0 && grossProfit != null ? round2(grossProfit / invoiceAmount) : null;
  const verdicts = [];

  if (invoiceAmount == null) verdicts.push({ level: "danger", label: "未录开票额(拖车销售额),不能开票" });
  if (costAmount == null) verdicts.push({ level: "warn", label: "未录拖车成本,无法核毛利" });
  if (invoiceAmount != null && costAmount != null && invoiceAmount < costAmount) {
    verdicts.push({ level: "danger", label: "倒挂:开票额<成本" });
  }
  if (grossMargin != null) {
    if (grossMargin < 0) verdicts.push({ level: "danger", label: "毛利率为负" });
    else if (grossMargin > 0.5) verdicts.push({ level: "warn", label: "毛利率偏高需复核" });
    else verdicts.push({ level: "ok", label: "毛利率正常" });
  }
  if (quoteAmount != null && invoiceAmount != null && Math.abs(invoiceAmount - quoteAmount) / quoteAmount > 0.05) {
    verdicts.push({ level: "warn", label: "偏离报价>5%" });
  }

  return {
    invoice_amount: invoiceAmount,
    cost_amount: costAmount,
    gross_profit: grossProfit,
    gross_margin: grossMargin,
    quote_amount: quoteAmount,
    verdicts,
    pass: !hasDanger(verdicts),
  };
}

export function numberToRMB(value) {
  const n = Number(value);
  if (!isFinite(n)) return "人民币零元整";
  const fraction = ["角", "分"];
  const digit = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const unit = [["元", "万", "亿"], ["", "拾", "佰", "仟"]];
  const sign = n < 0 ? "负" : "";
  let num = Math.abs(n);
  let s = "";
  for (let i = 0; i < fraction.length; i++) {
    const v = Math.floor(num * 10 * Math.pow(10, i) + 0.00001) % 10;
    s += (digit[v] + fraction[i]).replace(/零./, "");
  }
  s = s || "整";
  num = Math.floor(num);
  for (let i = 0; i < unit[0].length && num > 0; i++) {
    let p = "";
    for (let j = 0; j < unit[1].length && num > 0; j++) {
      p = digit[num % 10] + unit[1][j] + p;
      num = Math.floor(num / 10);
    }
    s = p.replace(/(零.)*零$/, "").replace(/^$/, "零") + unit[0][i] + s;
  }
  return "人民币" + sign + s
    .replace(/(零.)*零元/, "元")
    .replace(/(零.)+/g, "零")
    .replace(/^人民币整$/, "人民币零元整");
}

export async function buildInvoiceBData(pool, opts) {
  const blNo = clean(opts?.bl_no);
  const sellerCode = clean(opts?.seller_company_code) || OCEANBABY.code;
  if (!blNo) throw new Error("bl_no required");

  const [billCols, planCols] = await Promise.all([
    tableColumns(pool, "freight_supplier_bills"),
    tableColumns(pool, "shipping_plans"),
  ]);
  const rateCols = await tableColumns(pool, "freight_rates");
  const [sellerRow, plan, summary] = await Promise.all([
    companyByCode(pool, sellerCode),
    loadPlan(pool, blNo, planCols),
    loadBillSummary(pool, blNo, billCols),
  ]);

  const sellerFallback = sellerCode.toUpperCase() === OCEANBABY.code ? OCEANBABY : { code: sellerCode };
  const seller = normalizeCompany(sellerRow, sellerFallback);
  let buyerRow = summary.payer_code ? await companyByCode(pool, summary.payer_code) : null;
  if (!buyerRow && plan?.customer_company_id) buyerRow = await companyById(pool, plan.customer_company_id);
  const buyer = {
    code: clean(buyerRow?.code || summary.payer_code),
    name: clean(buyerRow?.name_cn || buyerRow?.name_en || plan?.customer_cn || plan?.customer || plan?.customer_en),
    tax_id: clean(buyerRow?.tax_id),
  };

  const missing = new Set();
  if (!seller.name) addMissing(missing, "销售方名称");
  if (!seller.tax_id) addMissing(missing, "销售方税号");
  if (!buyer.name) addMissing(missing, "购买方名称");
  if (!buyer.tax_id) addMissing(missing, "购买方税号");

  const amountIncl = summary.amount_incl && summary.amount_incl > 0 ? round2(summary.amount_incl) : null;
  if (amountIncl == null) addMissing(missing, "拖车销售额");
  const amountEx = amountIncl == null ? null : round2(amountIncl / 1.09);
  const tax = amountIncl == null ? null : round2(amountIncl - amountEx);

  const transportLines = normalizeTransportLines(summary.transport_lines);
  if (!transportLines.length) addMissing(missing, "运输工具明细(车牌/起运地/到达地/货物名)");
  for (const line of transportLines) {
    if (!line.transport_type) addMissing(missing, "运输工具种类");
    if (!line.plate_no) addMissing(missing, "车牌号");
    if (!line.origin) addMissing(missing, "起运地");
    if (!line.destination) addMissing(missing, "到达地");
    if (!line.cargo_name) addMissing(missing, "货物名");
  }

  const data = {
    seller,
    buyer,
    bl_no: blNo,
    issue_date: new Date().toISOString().slice(0, 10),
    line: {
      name: "*交通运输服务*运费",
      qty: 1,
      amount_incl: amountIncl,
      amount_ex: amountEx,
      tax,
      tax_rate: 0.09,
    },
    transport_lines: transportLines,
    missing: Array.from(missing),
  };
  data.price_check = await computePriceCheck(pool, {
    bl_no: blNo,
    invoice_amount: amountIncl,
    bill_cols: billCols,
    plan,
    rate_cols: rateCols,
  });
  data.can_issue = data.missing.length === 0 && amountIncl > 0;
  return data;
}
