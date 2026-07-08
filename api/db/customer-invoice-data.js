// api/db/customer-invoice-data.js
// 客户销项发票读查询层（B3）：按订单派生 巴匕(销售方)→客户(购买方) 发票草稿。
//   - 金额一律以报关口径 finance_export_rebates.fob_cny 为权威默认（客户价只参考）。
//   - 国外客户(country 非中国)：单行锁报关口径，退税用，不建议改金额。
//   - 国内客户(country=中国)：可编辑多行(名目+金额+税率带税/免税)，默认一行报关口径。
// 纯读层：只接收 pool，不做鉴权/路由，无副作用。

// 编辑期：确认开票(issued)后仍可改的宽限天数，超期锁定只读，防止事后乱改已申报的发票。
// 默认 3 天（业务口径待 Damon 明确后再调整此常量，不建表配置——避免过度设计）。
export const EDIT_WINDOW_DAYS = 3;

function cleanText(v) {
  return String(v ?? "").trim();
}

function isDomesticCountry(country) {
  const c = cleanText(country);
  return !c || c === "中国" || /china|中国|中华人民共和国|cn\b/i.test(c);
}

// 销售方（我方开票主体）：按订单 issuing_company 中文名解析 companies。
async function getSeller(pool, issuingCompany) {
  const name = cleanText(issuingCompany);
  if (!name) return null;
  const r = await pool.query(
    `SELECT code, name_cn, factory_name, tax_id, address, bank_name, bank_account, contact_phone
       FROM companies
      WHERE name_cn = $1 OR factory_name = $1 OR name_cn ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN name_cn = $1 THEN 0 WHEN factory_name = $1 THEN 1 ELSE 9 END, id ASC
      LIMIT 1`,
    [name]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    code: row.code || null,
    name: row.name_cn || row.factory_name || name,
    tax_id: row.tax_id || null,
    address: row.address || null,
    bank_name: row.bank_name || null,
    bank_account: row.bank_account || null,
    contact_phone: row.contact_phone || null,
  };
}

// 购买方（客户）：优先 customer_id，其次订单 customer 文本名。
async function getBuyer(pool, customerId, customerName) {
  let row = null;
  if (customerId) {
    const r = await pool.query(
      `SELECT id, name, name_cn, name_en, country, tax_id, tax_no,
              address, address_cn, address_en, bank_name, invoice
         FROM customers WHERE id = $1 LIMIT 1`,
      [customerId]
    );
    row = r.rows[0] || null;
  }
  if (!row && cleanText(customerName)) {
    const r = await pool.query(
      `SELECT id, name, name_cn, name_en, country, tax_id, tax_no,
              address, address_cn, address_en, bank_name, invoice
         FROM customers
        WHERE name = $1 OR name_cn = $1 OR name_en = $1
        ORDER BY id ASC LIMIT 1`,
      [cleanText(customerName)]
    );
    row = r.rows[0] || null;
  }
  if (!row) {
    return {
      id: null,
      name: cleanText(customerName) || null,
      country: null,
      is_domestic: false,
      tax_id: null,
      address: null,
      invoice_rule: null,
    };
  }
  const domestic = isDomesticCountry(row.country);
  const name = domestic
    ? (row.name_cn || row.name || row.name_en || cleanText(customerName))
    : (row.name_en || row.name || row.name_cn || cleanText(customerName));
  // 客户预存的开票要求（拆分规则），空对象视为无。
  let rule = row.invoice && typeof row.invoice === "object" ? row.invoice : null;
  if (rule && Object.keys(rule).length === 0) rule = null;
  return {
    id: row.id,
    name: name || null,
    country: row.country || null,
    is_domestic: domestic,
    tax_id: row.tax_id || row.tax_no || null,
    address: domestic ? (row.address_cn || row.address || null) : (row.address_en || row.address || null),
    invoice_rule: rule,
  };
}

// 报关口径金额 + 报关单号 + 报关品名（默认发票行名用）。
async function getCustomsBasis(pool, contractNo) {
  const cno = cleanText(contractNo);
  if (!cno) return { fob_cny: 0, customs_no: null, decl_name_cn: null, decl_name_en: null };
  const r = await pool.query(
    `SELECT r.fob_cny, r.customs_no
       FROM finance_export_rebates r
      WHERE r.contract_no = $1
      ORDER BY r.customs_no DESC NULLS LAST LIMIT 1`,
    [cno]
  );
  const row = r.rows[0] || {};
  // 报关品名（首行）
  const n = await pool.query(
    `SELECT oli.declaration_name, oli.declaration_name_en
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
      WHERE o.contract_no = $1
        AND COALESCE(oli.declaration_name, '') <> ''
      ORDER BY oli.sort_order NULLS LAST, oli.id ASC LIMIT 1`,
    [cno]
  );
  return {
    fob_cny: Number(row.fob_cny) || 0,
    customs_no: row.customs_no || null,
    decl_name_cn: cleanText(n.rows[0]?.declaration_name) || null,
    decl_name_en: cleanText(n.rows[0]?.declaration_name_en) || null,
  };
}

// 已存草稿（B3 落库 / B5 已开）：source=customer_invoice，按 order_no 归属（raw.order_no）。
async function getSavedInvoice(pool, orderNo, contractNo) {
  const r = await pool.query(
    `SELECT id, invoice_no, amount_incl_tax, amount_ex_tax, total_tax, tax_rate, currency,
            buyer_name, seller_name, contract_nos, customs_nos, remark,
            review_status, invoice_format, raw, created_at, updated_at, issue_date, reviewed_at
       FROM finance_invoices_out
      WHERE source = 'customer_invoice'
        AND (raw->>'order_no' = $1 OR $2 = ANY(COALESCE(contract_nos, ARRAY[]::text[])))
      ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [cleanText(orderNo), cleanText(contractNo)]
  );
  const row = r.rows[0];
  if (!row) return null;
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const daysSinceConfirm = row.reviewed_at ? (Date.now() - new Date(row.reviewed_at).getTime()) / 86400000 : null;
  const locked = row.review_status === "issued" && daysSinceConfirm != null && daysSinceConfirm > EDIT_WINDOW_DAYS;
  return {
    id: row.id,
    invoice_no: row.invoice_no || null,
    is_real_invoice_no: !!row.invoice_no && !String(row.invoice_no).startsWith("CI-DRAFT-"),
    review_status: row.review_status || "draft",
    invoice_format: row.invoice_format || null,
    currency: row.currency || null,
    remark: row.remark || null,
    remark_fields: raw.remark_fields || null,
    issuer: raw.issuer || null,
    issue_date: row.issue_date || null,
    reviewed_at: row.reviewed_at || null,
    locked,
    edit_window_days: EDIT_WINDOW_DAYS,
    lines: Array.isArray(raw.line_items) ? raw.line_items : [],
    amount_incl_tax: Number(row.amount_incl_tax) || 0,
    updated_at: row.updated_at || row.created_at || null,
  };
}

// 组装单票客户发票视图（供 /ci 门户渲染）。
export async function buildCustomerInvoice(pool, orderNo) {
  const on = cleanText(orderNo);
  if (!on) return null;
  const o = await pool.query(
    `SELECT order_no, contract_no, customer, customer_id, issuing_company,
            currency, customer_amount, declare_amount,
            trade_terms, exchange_rate, bl_no, total_cartons
       FROM orders
      WHERE order_no = $1 OR contract_no = $1
      ORDER BY (order_no = $1) DESC LIMIT 1`,
    [on]
  );
  const order = o.rows[0];
  if (!order) return null;

  const [seller, buyer, customs] = await Promise.all([
    getSeller(pool, order.issuing_company),
    getBuyer(pool, order.customer_id, order.customer),
    getCustomsBasis(pool, order.contract_no),
  ]);

  const customsAmount = customs.fob_cny;
  const currency = cleanText(order.currency) || "CNY";
  const defaultName =
    (buyer.is_domestic ? customs.decl_name_cn : (customs.decl_name_en || customs.decl_name_cn)) ||
    "货款";

  // 默认发票行：单行报关口径，字段全可编辑（一套模板，不分境内外）。
  const totalCartons = Number(order.total_cartons) || null;
  const defaultLines = [{
    name: defaultName,
    spec: "",
    unit: totalCartons ? "箱" : "",
    qty: totalCartons,
    amount_incl: customsAmount || 0,
    tax_rate: 0,
  }];

  const exchangeRate = Number(order.exchange_rate) || null;
  const saved = await getSavedInvoice(pool, order.order_no, order.contract_no);

  return {
    order_no: order.order_no,
    contract_no: order.contract_no || null,
    customs_no: customs.customs_no,
    currency,
    is_domestic: buyer.is_domestic,
    seller,
    buyer,
    seller_missing: !seller || !seller.tax_id,
    buyer_missing: !buyer || !buyer.name,
    customs_amount: customsAmount,
    customer_amount: Number(order.customer_amount) || null,
    amount_source: customsAmount > 0 ? "customs" : "missing",
    amount_warning: !(customsAmount > 0),
    default_name: defaultName,
    default_lines: defaultLines,
    // 备注区默认值（比照真实已开票样例：成交方式/汇率/合同协议号/贸易国/提运单号），均可编辑覆盖。
    default_remark: {
      trade_terms: cleanText(order.trade_terms) || null,
      exchange_rate: exchangeRate,
      usd_ref: exchangeRate && customsAmount ? Math.round((customsAmount / exchangeRate) * 100) / 100 : null,
      contract_no: order.contract_no || null,
      trade_country: buyer.country || null,
      bl_no: cleanText(order.bl_no) || null,
    },
    invoice_rule: buyer.invoice_rule,
    saved,
    can_invoice: !!(seller && seller.tax_id && buyer && buyer.name),
  };
}
