import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

// ── P1-1: 代理模式敏感字段剥离 ──────────────────────────────────
// 当 order.mode === 'agent' 且请求者是工厂角色时，从 raw JSONB 里剥离这些 key。
// 顶层列（id / contract_no / customer / company_code / status / mode …）保留，
// 因为工厂仍需看到订单号和所属客户以便识别自己的单。
//
// 敏感 key 分组（和前端 .s-pay / .s-freight / .s-bl / .s-vessel / .s-eta / .s-transit 对应）：
const SENSITIVE_RAW_KEYS = [
  // 付款 / 金额 / 利润
  "paymentStatus", "payments", "paidAmount", "remainingAmount",
  "deposit", "balance", "fullPayment", "settlementStatus",
  "totalAmount", "totalAmountFactory", "totalAmountUSD", "totalAmountCNY",
  "customerUnitPrice", "pricePerCarton", "unitPriceCNY", "unitPriceUSD",
  "salePrice", "saleTotal", "profit", "profitRate",

  // 海运费 / 运价明细
  "oceanFreight", "oceanFreightCNY", "oceanFreightUSD",
  "freightQuote", "freightRate", "freightTotal", "freightSaleUSD",
  "localCharges", "portSurchargeTotal", "terminalFee", "thc",

  // 提单
  "blNo", "blDate", "blUrl", "blStatus", "telexRelease",
  "masterBlNo", "houseBlNo",

  // 船名航次
  "vessel", "voyage", "mv", "shipName", "shippingLine", "carrier",

  // ETD / ETA / 在途 / 到港
  "etd", "eta", "atd", "ata",
  "transitStatus", "arrivalStatus", "dischargeDate", "customsClearance",
  "containerBookingNo", "bookingNo",
];

// 敏感的 product 子字段（products[] 里也有单价，必须逐项剥离）
const SENSITIVE_PRODUCT_KEYS = [
  "unitPrice", "unitPriceCNY", "unitPriceUSD", "price", "totalAmount",
  "cost", "profit", "freightShare",
];

function stripSensitive(row, requesterRole) {
  // 前端兜底已经有 CSS，这里是 API 真过滤
  // 仅当 mode=agent 且请求者是工厂角色时剥离
  // admin / sales / logistics / customer 等内部或货主侧角色看到完整数据
  if (!row) return row;
  if (row.mode !== "agent") return row;
  if (requesterRole !== "factory") return row;

  const cleaned = { ...row };
  const raw = cleaned.raw && typeof cleaned.raw === "object" ? { ...cleaned.raw } : {};

  for (const k of SENSITIVE_RAW_KEYS) {
    if (k in raw) delete raw[k];
  }

  // products[] 内逐项剥离
  if (Array.isArray(raw.products)) {
    raw.products = raw.products.map(function(p) {
      if (!p || typeof p !== "object") return p;
      const cp = { ...p };
      for (const k of SENSITIVE_PRODUCT_KEYS) {
        if (k in cp) delete cp[k];
      }
      return cp;
    });
  }

  cleaned.raw = raw;
  // 打标让前端 / 调试可见
  cleaned._sensitive_stripped = true;
  cleaned._stripped_reason = "agent-mode + factory-role";
  return cleaned;
}

// food/强合规例外的预留钩子 — 本轮不实现完整逻辑
// 将来：通过 access_requests 审批通过后，本函数放行指定 BL / 船期
// eslint-disable-next-line no-unused-vars
function checkComplianceException(row, requester) {
  // placeholder — 本轮始终返回 false
  // 将来：查 access_requests 表，若 approved 则返回允许放行的 key 列表
  return false;
}

// ── PATCH: admin-only field update (status, etd, delivery_date, remarks, raw merge)
const PATCH_ALLOWED_COLS = [
  "order_no","company_code","status","etd","delivery_date","remarks","brand","trade_terms","notes","total_amount","currency",
  // Profit structure埋点 (2026-05-09)
  "factory_amount","customer_amount","margin_amount","margin_pct",
  "quote_sent_at","customer_replied_at","negotiation_rounds",
];

async function handlePatch(req, res) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }
  const pool = getPool();
  const body = req.body || {};
  const { id, raw: rawPatch, ...rest } = body;
  if (!id) return res.status(400).json({ error: "id required" });

  const sets = [], vals = [];
  let n = 0;
  for (const col of PATCH_ALLOWED_COLS) {
    if (rest[col] !== undefined) {
      n++; sets.push(col + " = $" + n); vals.push(rest[col]);
    }
  }
  // Merge raw JSONB if provided
  if (rawPatch && typeof rawPatch === "object") {
    n++; sets.push("raw = COALESCE(raw,'{}') || $" + n + "::jsonb"); vals.push(JSON.stringify(rawPatch));
  }
  if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

  // ── Auto-compute profit fields from raw.products ────────────────
  // If raw.products is being saved (either via rawPatch or already exists),
  // recompute factory_amount / customer_amount / margin_amount / margin_pct
  // so the columns stay in sync without manual entry.
  const patchProducts = rawPatch && Array.isArray(rawPatch.products) ? rawPatch.products : null;
  if (patchProducts && patchProducts.length > 0) {
    const factoryAmt  = patchProducts.reduce((s, it) => s + (Number(it.factoryPrice || 0) * Number(it.qty || 1)), 0);
    const customerAmt = patchProducts.reduce((s, it) => s + Number(it.subtotal || 0), 0);
    const marginAmt   = customerAmt - factoryAmt;
    const marginPct   = factoryAmt > 0 ? Math.round(marginAmt / factoryAmt * 1000) / 10 : null;
    // Only overwrite if caller didn't explicitly supply these cols (let explicit win)
    if (rest.factory_amount  === undefined && factoryAmt  > 0) { n++; sets.push("factory_amount  = $" + n); vals.push(factoryAmt); }
    if (rest.customer_amount === undefined && customerAmt > 0) { n++; sets.push("customer_amount = $" + n); vals.push(customerAmt); }
    if (rest.margin_amount   === undefined)                    { n++; sets.push("margin_amount   = $" + n); vals.push(marginAmt); }
    if (rest.margin_pct      === undefined && marginPct != null) { n++; sets.push("margin_pct    = $" + n); vals.push(marginPct); }
  }

  if (body.pricing_snapshot !== undefined) { n++; sets.push("pricing_snapshot = $" + n); vals.push(JSON.stringify(body.pricing_snapshot)); }
  if (body.payment_schedule !== undefined) { n++; sets.push("payment_schedule = $" + n); vals.push(JSON.stringify(body.payment_schedule)); }
  // Merge first_issued_at JSONB (per-docType timestamps) — use COALESCE merge to preserve other docTypes
  if (body.first_issued_at !== undefined && typeof body.first_issued_at === "object") {
    n++; sets.push("first_issued_at = COALESCE(first_issued_at,'{}') || $" + n + "::jsonb"); vals.push(JSON.stringify(body.first_issued_at));
  }
  n++; sets.push("updated_at = NOW()");
  vals.push(id);
  const sql = "UPDATE orders SET " + sets.join(", ") + " WHERE id = $" + (n) + " RETURNING id";
  const r = await pool.query(sql, vals);
  if (r.rowCount === 0) return res.status(404).json({ error: "order not found" });
  return res.status(200).json({ success: true, id });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method === "PATCH") {
    try { return await handlePatch(req, res); }
    catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    let { customer, status, limit = 500, brands, factory, company_code, company_codes, sku } = req.query;
    // Tenant scoping: non-admin users can only see their own company's orders.
    // FAIL-CLOSED: if JWT has no role or no companyCodes, refuse the request —
    // forces re-login so the fresh JWT carries the correct scope. (Prior
    // version fell through and returned ALL orders when JWT was missing fields.)
    if (req.user && req.user.role !== "admin") {
      const userCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : null);
      if (!userCodes || userCodes.length === 0) {
        return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
      }
      company_codes = JSON.stringify(userCodes);
      company_code  = undefined;
    }
    let query = "SELECT * FROM orders", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (status)   { params.push(status);           conds.push(`status = $${params.length}`); }
    if (factory)  { params.push(factory);           conds.push(`raw->>'factory' = $${params.length}`); }
    if (company_codes) {
      let codeList; try { codeList = JSON.parse(company_codes); } catch { codeList = company_codes.split(","); }
      if (codeList.length > 0) {
        const ph = codeList.map(function(c) { params.push(c); return "$" + params.length; });
        // Match either the buyer (company_code / raw.companyCode) OR the factory
        // (raw.factoryCompanyCode). Lets factory portal accounts see the orders
        // they are supplying, e.g. HENGAN sees HARMONIOUS's 48-4 because it ships it.
        conds.push(
          "(raw->>'companyCode' IN (" + ph.join(",") + ")" +
          " OR company_code IN (" + ph.join(",") + ")" +
          " OR raw->>'factoryCompanyCode' IN (" + ph.join(",") + "))"
        );
      }
    } else if (company_code) {
      params.push(company_code);
      conds.push(
        "(raw->>'companyCode' = $" + params.length +
        " OR company_code = $" + params.length +
        " OR raw->>'factoryCompanyCode' = $" + params.length + ")"
      );
    }
    if (brands) {
      let brandList;
      try { brandList = JSON.parse(brands); } catch { brandList = [brands]; }
      if (brandList.length > 0) {
        const orClauses = [];
        brandList.forEach(brand => { params.push(brand); orClauses.push(`raw->>'_widget_1775071325804' = $${params.length}`); });
        brandList.forEach(brand => { params.push(`%${brand}%`); orClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(raw->'products') p WHERE p->>'name' ILIKE $${params.length})`); });
        conds.push(`(${orClauses.join(' OR ')})`);
      }
    }
    if (sku) {
      params.push("%" + sku + "%");
      conds.push("EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(raw->'products','[]'::jsonb)) p WHERE p->>'sku' ILIKE $" + params.length + ")");
    }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);

    // ── P1-1 field filtering ──
    const requesterRole = (req.user && req.user.role) || null;
    const filtered = result.rows.map(function(r) { return stripSensitive(r, requesterRole); });

    return res.status(200).json({ success: true, data: filtered, count: result.rowCount });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
