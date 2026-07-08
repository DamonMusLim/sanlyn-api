import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
import { serializeOrdersForRole } from "../lib/orders/serializer.js"; // W0-1: role-scoped allowlist

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

// ROLE-BASED-REAL-ACCOUNT-VERIFY-001 — Product sub-field isolation:
//   "always" = hide from both factory and customer (Sanlyn-internal analytics only)
//   "factory hides" = customer-facing prices factory must not see
//   "customer hides" = factory cost fields customer must not see
//
// NOTE: SENSITIVE_PRODUCT_KEYS is kept for legacy reference but NOT used in stripSensitive.
//       All stripping is now done via role-specific arrays below.
const SENSITIVE_PRODUCT_KEYS = []; // legacy — not used

// Product fields always hidden from external roles (Sanlyn-internal)
const ALWAYS_HIDE_PROD = [
  "freightShare", "profit",   // Sanlyn allocation / margin — internal only
];
// Factory must NOT see customer-side prices (but factory CAN see factoryPrice / cost)
const FACTORY_HIDE_PROD = [
  "unitPrice", "unitPriceCNY", "unitPriceUSD",
  "customerPrice", "salePrice",
  "totalPrice", "totalAmount", "price",        // customer-facing line totals
  "subtotal",                                  // customer subtotal = qty × unitPrice
];
// Customer must NOT see factory cost fields (but customer CAN see unitPrice / totalPrice)
const CUSTOMER_HIDE_PROD = [
  "factoryPrice", "factory_price", "cost",          // factory cost price
  "factorySubtotal", "factory_subtotal",             // factory line total
  "declareAmountPerBox", "declare_amount_per_box",   // customs declared amount (internal)
  "vatRate", "vat_rate",                             // VAT rate (internal tax structure)
  "taxRebateRate", "tax_rebate_rate",                // tax rebate rate (internal)
  "_masterFilled",                                   // internal backfill flag
];

// Sanlyn profit fields — neither factory nor customer ever sees these.
const ALWAYS_HIDE_TOP = [
  "margin_amount", "margin_pct",               // Sanlyn profit — never expose externally
  "middleman_markup_total", "middleman_markup_pct",
  "profit",                                    // orders.profit = Sanlyn net profit — internal only
];
// Fields hidden from customer but visible to factory (factory's own costs)
const CUSTOMER_HIDE_TOP = ["factory_amount", "factory_price_total", "total_amount_factory"];
// Fields hidden from factory but visible to customer (customer's own pricing)
const FACTORY_HIDE_TOP  = ["customer_amount", "customer_price_total"];

function stripSensitive(row, requesterRole) {
  // ROLE-BASED-REAL-ACCOUNT-VERIFY-001:
  //   factory : sees factory_amount but NOT margin / customer pricing
  //   customer: sees customer_amount/unitPrice but NOT margin / factory cost
  //   admin/logistics: full visibility (no stripping)
  if (!row) return row;
  if (requesterRole !== "factory" && requesterRole !== "customer") return row;

  const cleaned = { ...row };

  // Strip Sanlyn-internal profit from both roles
  for (const k of ALWAYS_HIDE_TOP) {
    if (k in cleaned) delete cleaned[k];
  }

  // Role-specific top-level strips
  const roleTopHide = requesterRole === "factory" ? FACTORY_HIDE_TOP : CUSTOMER_HIDE_TOP;
  for (const k of roleTopHide) {
    if (k in cleaned) delete cleaned[k];
  }

  const raw = cleaned.raw && typeof cleaned.raw === "object" ? { ...cleaned.raw } : {};

  for (const k of SENSITIVE_RAW_KEYS) {
    if (k in raw) delete raw[k];
  }

  // products[] stripping — the canonical products array is the TOP-LEVEL column (not raw.products).
  // raw.products is a smaller snapshot used for document generation — strip both for safety.
  // ROLE-BASED-REAL-ACCOUNT-VERIFY-001 fix: target row.products (top-level) not just raw.products.
  const prodHideKeys = [
    ...ALWAYS_HIDE_PROD,
    ...(requesterRole === "factory" ? FACTORY_HIDE_PROD : CUSTOMER_HIDE_PROD),
  ];

  // Strip top-level products column
  if (Array.isArray(cleaned.products)) {
    cleaned.products = cleaned.products.map(function(p) {
      if (!p || typeof p !== "object") return p;
      const cp = { ...p };
      for (const k of prodHideKeys) {
        if (k in cp) delete cp[k];
      }
      return cp;
    });
  }

  // Strip raw.products too (document generation snapshot)
  if (Array.isArray(raw.products)) {
    raw.products = raw.products.map(function(p) {
      if (!p || typeof p !== "object") return p;
      const cp = { ...p };
      for (const k of prodHideKeys) {
        if (k in cp) delete cp[k];
      }
      return cp;
    });
  }

  cleaned.raw = raw;
  // 打标让前端 / 调试可见
  cleaned._sensitive_stripped = true;
  cleaned._stripped_reason = requesterRole + "-role (mode=" + (row.mode || "null") + ")";
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
  "order_no","company_code","company_name_en","status","etd","delivery_date","remarks","brand","trade_terms","notes","total_amount","currency",
  // Order totals — auto-derived from raw.products on save (compute-at-write, then docs/list read the stored value) (2026-05-22)
  "total_qty","net_weight","gross_weight","total_cbm",
  // Buyer + commercial refs editable from the order detail Deal section (2026-05-22)
  "customer","customer_po","payment_terms",
  // Actual delivery date (expected = delivery_date; actual triggers收款+定船期) (2026-05-22)
  "confirmed_delivery",
  // Profit structure (2026-05-09)
  "factory_amount","customer_amount","margin_amount","margin_pct",
  "quote_sent_at","customer_replied_at","negotiation_rounds",
  // Seller entity (2026-05-09): which Sanlyn entity issues the PI/SC/IV
  "seller_code",
  // Three-tier pricing for middlemen like 洋宝宝 (2026-05-10)
  "factory_price_total","middleman_code","middleman_markup_total","middleman_markup_pct","customer_price_total",
  // Exchange rate: factory prices in USD → customer prices in CNY conversion (2026-05-10)
  "exchange_rate",
  // 客户确认 + 洋宝宝价格 (2026-06-22)
  "customer_confirmed_at",
  "oceanbaby_price",
  // is_locked 不在此列——只允许通过专属锁单端点修改
];

// Order_no prefix must match company_code numeric suffix.
// Naming convention: order_no = "{customer_num}-{factory}-{seq}", e.g. "37-WP-60" for CN-00037.
// Add `raw.order_no_prefix_exempt: true` to bypass (used for legacy JDY customs declaration numbers).
// Returns { ok: true } or { ok: false, error: string } — caller responds with 400.
function checkOrderNoPrefix(order_no, company_code, raw) {
  if (raw && raw.order_no_prefix_exempt) return { ok: true };
  if (!order_no || !company_code) return { ok: true }; // partial PATCH — skip when either is missing
  const prefixMatch = String(order_no).match(/^([0-9]{2})-/);
  const ccMatch     = String(company_code).match(/00([0-9]{2})$/);
  if (!prefixMatch || !ccMatch) return { ok: true }; // unconventional format — don't block
  if (prefixMatch[1] !== ccMatch[1]) {
    return {
      ok: false,
      error: "order_no_prefix_mismatch",
      message: `Prefix '${prefixMatch[1]}-' on order_no '${order_no}' does not match company_code '${company_code}'. ` +
               `Either correct the prefix or set raw.order_no_prefix_exempt=true with reason if intentional.`
    };
  }
  return { ok: true };
}

async function handlePatch(req, res) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }
  const pool = getPool();
  const body = req.body || {};
  const { id, raw: rawPatch, ...rest } = body;
  if (!id) return res.status(400).json({ error: "id required" });

  // Validate order_no/company_code prefix consistency BEFORE writing
  if (rest.order_no !== undefined || rest.company_code !== undefined) {
    // Need current row for the field the PATCH isn't touching
    const cur = await pool.query("SELECT order_no, company_code, raw FROM orders WHERE id=$1", [id]);
    if (cur.rows[0]) {
      const finalOrderNo = rest.order_no    !== undefined ? rest.order_no    : cur.rows[0].order_no;
      const finalCompany = rest.company_code !== undefined ? rest.company_code : cur.rows[0].company_code;
      const finalRaw     = { ...(cur.rows[0].raw || {}), ...(rawPatch || {}) };
      const chk = checkOrderNoPrefix(finalOrderNo, finalCompany, finalRaw);
      if (!chk.ok) return res.status(400).json({ error: chk.error, message: chk.message });
    }
  }

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
  //
  // Cross-currency fix (2026-05-10): factoryPrice is in USD, subtotal is in CNY.
  // Use exchange_rate to convert factory USD → CNY before subtracting.
  // exchange_rate is taken from: (1) this PATCH payload, (2) current DB row.
  const patchProducts = rawPatch && Array.isArray(rawPatch.products) ? rawPatch.products : null;
  if (patchProducts && patchProducts.length > 0) {
    // Fetch current row to get stored exchange_rate if not provided in this PATCH
    let currentRow = null;
    try {
      const cur = await pool.query("SELECT exchange_rate FROM orders WHERE id = $1", [id]);
      currentRow = cur.rows[0] || null;
    } catch (_) { /* non-fatal: proceed without currentRow */ }

    const factoryAmt  = patchProducts.reduce((s, it) => s + (Number(it.factoryPrice || 0) * Number(it.qty || 1)), 0);
    const customerAmt = patchProducts.reduce((s, it) => s + Number(it.subtotal || 0), 0);
    // When exchange_rate is set (factory in USD, customer in CNY), convert factory to CNY first
    const exRate = Number(rest.exchange_rate || currentRow?.exchange_rate || 0);
    const factoryInCustomerCurrency = exRate > 0 ? factoryAmt * exRate : factoryAmt;
    const marginAmt   = customerAmt - factoryInCustomerCurrency;
    const marginPct   = factoryInCustomerCurrency > 0
      ? Math.round(marginAmt / factoryInCustomerCurrency * 1000) / 10
      : null;
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

// ── POST (no action): create a new order — admin only, minimal fields ─────────
// Called by NewOrderDrawer in admin-v1 OrdersModule.
// orders.id has no serial default (schema-frozen). We use pg_advisory_xact_lock
// to serialize concurrent creates so MAX(id)+1 is always unique.
async function handleCreate(req, res) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }
  const pool = getPool();
  const body = req.body || {};
  if (!body.customer) return res.status(400).json({ error: "customer is required" });

  // L3: factory_code 必填（admin 创单时必须选工厂，否则工厂端永远看不到该订单）
  const rawBody = body.raw || {};
  const factoryCode = (rawBody.factory_code || rawBody.factoryCompanyCode || '').trim();
  if (!factoryCode) {
    return res.status(422).json({
      error: 'factory_code 必填',
      hint: '请从 partner_relationships 选择工厂，否则工厂端无法看到该订单'
    });
  }
  // 回写到 raw，确保两个字段同步
  rawBody.factory_code = factoryCode;
  rawBody.factoryCompanyCode = factoryCode;
  body.raw = rawBody;

  // Auto-generate order_no / contract_no if caller omits them
  const d = new Date();
  const ds = String(d.getFullYear()) + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0");
  const orderNo    = body.order_no    || ("ORD-" + ds + "-" + String(Math.floor(Math.random()*10000)).padStart(4,"0"));
  const contractNo = body.contract_no || ("FS"   + ds + String(Math.floor(Math.random()*1000)).padStart(3,"0"));

  // Prefix consistency check — blocks the kind of misfile we found on 2026-05-18 (40-LL-21 went to PETSOME)
  if (body.company_code) {
    const chk = checkOrderNoPrefix(orderNo, body.company_code, body.raw || {});
    if (!chk.ok) return res.status(400).json({ error: chk.error, message: chk.message });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Advisory lock serializes concurrent admin creates for id generation (no schema change needed)
    await client.query("SELECT pg_advisory_xact_lock(hashtext('orders_id_gen'))");
    const nidRes = await client.query("SELECT COALESCE(MAX(id),0)+1 AS nid FROM orders");
    const nextId = nidRes.rows[0].nid;
    const r = await client.query(
      `INSERT INTO orders
         (_id, id, order_no, contract_no, customer, company_code, company_name_en,
          factory, factory_code, country, destination_port, pol,
          trade_terms, status, production_status, container_qty,
          total_amount, total_amount_factory, currency, etd, remarks,
          products, raw, source, created_by)
       VALUES
         (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,$15,
          $16,$23,$17,$18,$19,
          $20::jsonb,$21::jsonb,'admin_panel',$22)
       RETURNING id, order_no, contract_no`,
      [
        nextId,                                                   // $1  id
        orderNo,                                                  // $2  order_no
        contractNo,                                               // $3  contract_no
        body.customer,                                            // $4  customer
        body.company_code || null,                                // $5  company_code
        body.company_name_en || null,                             // $6  company_name_en
        body.factory || null,                                     // $7  factory
        rawBody.factory_code || body.factory_code || null,        // $8  factory_code
        body.country || null,                                     // $9  country
        body.destination_port || null,                            // $10 destination_port
        body.pol || null,                                         // $11 pol
        body.trade_terms || "FOB",                                // $12 trade_terms
        body.status || "draft",                                   // $13 status
        body.production_status || null,                           // $14 production_status
        body.container_qty != null ? Number(body.container_qty) : null, // $15 container_qty
        body.total_amount ? Number(body.total_amount) : null,     // $16 total_amount
        body.currency || "USD",                                   // $17 currency
        body.etd || null,                                         // $18 etd
        body.remarks || body.notes || null,                       // $19 remarks
        JSON.stringify(Array.isArray(body.products) ? body.products : []), // $20 products jsonb
        JSON.stringify(rawBody || body.raw || {}),                // $21 raw jsonb
        req.user.uid || req.user.sub || null,                     // $22 created_by
        body.total_amount_factory != null ? Number(body.total_amount_factory) : null, // $23 采购额
      ]
    );
    const row = r.rows[0];
    // 写订单明细 order_line_items(铁律:建单必须落OLI,否则UI产品网格空) — 同事务
    const lineItems = Array.isArray(body.products) ? body.products : [];
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const qty = li.qty != null ? Number(li.qty) : (li.qty_ctn != null ? Number(li.qty_ctn) : null);
      const up = li.unit_price != null ? Number(li.unit_price) : null;
      const fp = li.factory_price != null ? Number(li.factory_price) : null;
      await client.query(
        `INSERT INTO order_line_items
           (order_id, sku, product_id, product_name, qty_ctn, unit, unit_price, factory_price, subtotal, factory_subtotal, nw_ctn, gw_ctn, cbm_ctn, hs_code, bg_bx, sort_order,
            declaration_name, declare_amount_per_box, vat_rate, tax_rebate_rate, brand)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          row.id,
          li.sku || null,
          li.product_id != null ? Number(li.product_id) : null,
          li.product_name || null,
          qty,
          li.unit || "CTN",
          up,
          fp,
          (up != null && qty != null) ? up * qty : null,         // subtotal 销售小计
          (fp != null && qty != null) ? fp * qty : null,         // factory_subtotal 采购小计
          li.nw_ctn != null ? Number(li.nw_ctn) : null,
          li.gw_ctn != null ? Number(li.gw_ctn) : null,
          li.cbm_ctn != null ? Number(li.cbm_ctn) : null,
          li.hs_code || null,
          li.bg_bx != null ? parseInt(li.bg_bx, 10) || null : null,
          i,
          li.declaration_name || null,
          li.declaration_amount != null ? Number(li.declaration_amount) : null,
          li.vat_rate != null ? Number(li.vat_rate) : null,
          li.rebate_rate != null ? Number(li.rebate_rate) : null,
          li.brand || null,
        ]
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, id: row.id, order_no: row.order_no, contract_no: row.contract_no, line_items: lineItems.length });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── POST mark_ready: factory delivery confirmation on behalf of ops ───────────
// Auth: requires 'orders:admin:write' capability (req.user.access[]) or admin role.
// v3.2 §6.1: writes raw.actDelivery + inserts order_events production_complete.
async function handleMarkReady(req, res) {
  // Capability gate: check req.user.access (JWT field from accounts.raw.access).
  // Admin role accepted as fallback for backwards-compatibility while access grants roll out.
  const capabilities = Array.isArray(req.user?.access) ? req.user.access : [];
  const hasCapability = capabilities.includes("orders:admin:write") || req.user?.role === "admin";
  if (!req.user || !hasCapability) {
    return res.status(403).json({ error: "Forbidden: requires orders:admin:write capability or admin role" });
  }
  const id = parseInt(req.query.id || req.body?.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: "id required" });

  const pool = getPool();
  const now = new Date().toISOString();

  // 1. Write raw.actDelivery timestamp
  const r = await pool.query(
    `UPDATE orders
        SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{actDelivery}', to_jsonb($1::text), true),
            updated_at = NOW()
      WHERE id = $2
      RETURNING id`,
    [now, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "order not found" });

  // 2. Insert order_events record (v3.2 §6.1 + Claude H migration)
  // Non-fatal: log but do not fail the response if order_events write fails.
  try {
    await pool.query(
      `INSERT INTO order_events
         (order_id, stage_key, source, actor_role, actor_user_id, occurred_at, is_current, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), true, 'active', NOW())`,
      [id, "production_complete", "manual", "internal_ops", req.user.uid || req.user.sub || null]
    );
  } catch (evtErr) {
    // Non-fatal: order update succeeded; event write failure is logged only.
    console.error("[mark_ready] order_events insert failed:", evtErr.message);
  }

  return res.status(200).json({ success: true, actDelivery: now });
}

// ── Cancel Request: any authenticated user can request, but order must NOT be in production ──
// Rule: once confirmed_delivery IS NOT NULL, production has started → reject cancel.
async function handleCancelRequest(req, res) {
  const id = parseInt(req.query.id || req.body?.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: "id required" });
  const reason = (req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason required" });

  const pool = getPool();
  // Fetch current order state
  const check = await pool.query(
    `SELECT id, status, confirmed_delivery, raw->'cancellation_request' AS existing_req
       FROM orders WHERE id = $1`, [id]
  );
  if (check.rowCount === 0) return res.status(404).json({ error: "order not found" });
  const o = check.rows[0];

  // Guard: production started (confirmed_delivery set) = cannot cancel
  if (o.confirmed_delivery) {
    return res.status(409).json({
      error: "Cannot cancel: production has already started (goods confirmed by factory).",
      code: "PRODUCTION_STARTED"
    });
  }
  // Guard: terminal states
  if (["shipped","in_transit","customs","delivered","cancelled"].includes(o.status)) {
    return res.status(409).json({ error: `Cannot cancel: order is already ${o.status}.` });
  }
  // Guard: duplicate pending request
  if (o.existing_req && o.existing_req.status === "pending") {
    return res.status(409).json({ error: "A cancellation request is already pending review." });
  }

  const requestPayload = {
    status: "pending",
    reason,
    requested_at: new Date().toISOString(),
    requested_by: req.user?.companyCode || req.user?.uid || "unknown",
    requested_by_role: req.user?.role || "unknown",
  };

  await pool.query(
    `UPDATE orders
        SET raw = jsonb_set(COALESCE(raw,'{}'), '{cancellation_request}', $1::jsonb, true),
            updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(requestPayload), id]
  );

  // Log event
  try {
    await pool.query(
      `INSERT INTO order_events
         (order_id, stage_key, source, actor_role, actor_user_id, occurred_at, is_current, status, created_at)
       VALUES ($1,'cancel_requested','manual',$2,$3,NOW(),false,'active',NOW())`,
      [id, req.user?.role || "unknown", req.user?.uid || req.user?.sub || null]
    );
  } catch (_) {}

  return res.status(200).json({ success: true, message: "Cancellation request submitted. Pending Sanlyn review." });
}

// ── Cancel Review: internal admin/ops only — approve or reject a pending cancel request ──
async function handleCancelReview(req, res) {
  const capabilities = Array.isArray(req.user?.access) ? req.user.access : [];
  const isInternal = capabilities.includes("orders:admin:write") || req.user?.role === "admin";
  if (!req.user || !isInternal) {
    return res.status(403).json({ error: "Forbidden: requires admin role or orders:admin:write" });
  }
  const id = parseInt(req.query.id || req.body?.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: "id required" });
  const action = req.body?.action; // "approve" | "reject"
  if (!["approve","reject"].includes(action)) return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  const notes = (req.body?.notes || "").trim();

  const pool = getPool();
  const check = await pool.query(
    `SELECT id, status, raw->'cancellation_request' AS req FROM orders WHERE id = $1`, [id]
  );
  if (check.rowCount === 0) return res.status(404).json({ error: "order not found" });
  const o = check.rows[0];
  if (!o.req || o.req.status !== "pending") {
    return res.status(409).json({ error: "No pending cancellation request found." });
  }

  const updatedReq = {
    ...o.req,
    status: action === "approve" ? "approved" : "rejected",
    reviewed_by: req.user?.uid || req.user?.sub || "admin",
    reviewed_by_role: req.user?.role,
    reviewed_at: new Date().toISOString(),
    notes: notes || undefined,
  };

  // If approved: also set orders.status = 'cancelled'
  const statusUpdate = action === "approve"
    ? `, status = 'cancelled'`
    : "";

  await pool.query(
    `UPDATE orders
        SET raw = jsonb_set(COALESCE(raw,'{}'), '{cancellation_request}', $1::jsonb, true),
            updated_at = NOW()${statusUpdate}
      WHERE id = $2`,
    [JSON.stringify(updatedReq), id]
  );

  try {
    await pool.query(
      `INSERT INTO order_events
         (order_id, stage_key, source, actor_role, actor_user_id, occurred_at, is_current, status, created_at)
       VALUES ($1,$2,'manual',$3,$4,NOW(),false,'active',NOW())`,
      [id, action === "approve" ? "cancel_approved" : "cancel_rejected",
       req.user?.role || "admin", req.user?.uid || req.user?.sub || null]
    );
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: action === "approve"
      ? "Order cancelled successfully."
      : "Cancellation request rejected. Order remains active.",
    order_status: action === "approve" ? "cancelled" : o.status,
  });
}

// POST /api/db/orders?action=lock
// body: { order_no, is_locked: boolean }
async function handleLock(req, res) {
  const { role } = req.user || {};
  if (role !== "admin") return res.status(403).json({ error: "admin only" });
  const { order_no, is_locked } = req.body || {};
  if (!order_no || typeof is_locked !== "boolean") {
    return res.status(400).json({ error: "order_no and is_locked required" });
  }
  const pool = getPool();
  await pool.query(
    "UPDATE orders SET is_locked=$1 WHERE order_no=$2",
    [is_locked, order_no]
  );
  // TODO: write to audit_log if table exists
  return res.status(200).json({ ok: true, order_no, is_locked });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method === "PATCH") {
    try { return await handlePatch(req, res); }
    catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
  }
  if (req.method === "POST") {
    const action = req.query.action;
    if (action === "mark_ready") {
      try { return await handleMarkReady(req, res); }
      catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
    }
    if (action === "cancel_request") {
      try { return await handleCancelRequest(req, res); }
      catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
    }
    if (action === "cancel_review") {
      try { return await handleCancelReview(req, res); }
      catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
    }
    if (action === "lock") {
      try { return await handleLock(req, res); }
      catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
    }
    if (action === "hard_delete") {
      if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden: admin only" });
      }
      const { order_no } = req.body || {};
      if (!order_no) return res.status(400).json({ error: "order_no required" });
      const pool = getPool();
      const row = await pool.query(`SELECT id FROM orders WHERE order_no=$1`, [order_no]);
      if (!row.rows.length) return res.status(404).json({ error: "Order not found" });
      const oid = row.rows[0].id;
      await pool.query(`DELETE FROM order_line_items WHERE order_id=$1`, [oid]);
      await pool.query(`DELETE FROM orders WHERE id=$1`, [oid]);
      return res.json({ success: true, deleted: order_no });
    }
    if (action) return res.status(400).json({ error: "unknown action: " + action });
    // No action = create new order
    try { return await handleCreate(req, res); }
    catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    let { customer, status, limit = 500, brands, factory, company_code, company_codes, sku, order_no, contract_no } = req.query;
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
    // LEFT JOIN latest loading_collab_sheets per order for driver chip
    let query = `
      SELECT o.*,
             lcs.loading->>'driver_name'    AS driver_name,
             lcs.loading->>'driver_phone'   AS driver_phone,
             lcs.loading->>'truck_plate'    AS truck_plate,
             lcs.loading->>'planned_load_at' AS planned_load_at,
             sp.bl_no               AS sp_bl_no,
             sp.etd                 AS sp_etd,
             sp.eta                 AS sp_eta,
             sp.pol                 AS sp_pol,
             sp.pod                 AS sp_pod,
             sp.current_status_cn   AS sp_status_cn,
             sp.tracking_updated_at AS sp_tracking_updated_at,
             sp.container_type      AS sp_container_type,
             sp.container_qty       AS sp_container_qty,
             sp.carrier_code       AS sp_shipping_line,
             COALESCE(NULLIF(o.raw->>'containerType',''), sp.container_type) AS container_type_raw,
             COALESCE(NULLIF(o.raw->>'shippingLine',''), sp.carrier_code) AS shipping_line,
             o.raw->>'inland_freight'          AS inland_freight,
             o.raw->>'inland_freight_label'    AS inland_freight_label,
             o.raw->>'inland_freight_label_en' AS inland_freight_label_en,
             fc.name_cn     AS factory_name_cn,
             fc.name_en     AS factory_name_en,
             oe._events,
             ot._tasks
        FROM orders o
        LEFT JOIN LATERAL (
          SELECT loading FROM loading_collab_sheets
           WHERE order_id = o.id
           ORDER BY submitted_at DESC NULLS LAST
           LIMIT 1
        ) lcs ON TRUE
        -- Live shipping dates from the linked shipping_plan (Portun keeps eta/etd
        -- fresh via /api/vessel-callback). ONE row only (LIMIT 1) — never fan out
        -- per container, which would both inflate rows and over-bill Portun.
        LEFT JOIN LATERAL (
          SELECT s.bl_no, s.etd, s.eta, s.pol, s.pod, s.current_status_cn, s.tracking_updated_at, s.container_type, s.container_qty, s.carrier_code
            FROM shipping_plans s
           WHERE (NULLIF(o.bl_no,'') IS NOT NULL AND s.bl_no = o.bl_no)
              OR (s.contract_no IS NOT NULL AND o.contract_no IS NOT NULL AND s.contract_no = o.contract_no)
              OR (s.order_contract_nos IS NOT NULL AND o.contract_no IS NOT NULL AND s.order_contract_nos ILIKE '%' || o.contract_no || '%')
              OR (s.order_contract_nos IS NOT NULL AND o.order_no IS NOT NULL AND s.order_contract_nos ILIKE '%' || o.order_no || '%')
           ORDER BY s.tracking_updated_at DESC NULLS LAST, s.eta DESC NULLS LAST
           LIMIT 1
        ) sp ON TRUE
        -- v3.2 §6.1 — current active milestone events (one row per stage_key per order)
        -- Gracefully no-ops when order_events table does not yet exist.
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'id', e.id,
              'stage_key', e.stage_key,
              'event_group', e.event_group,
              'sequence_no', e.sequence_no,
              'occurred_at', e.occurred_at,
              'actor_role', e.actor_role,
              'actor_company_id', e.actor_company_id,
              'source', e.source,
              'visibility_scope', e.visibility_scope,
              'confidence', e.confidence,
              'meta', e.meta
            ) ORDER BY e.occurred_at ASC
          ) AS _events
          FROM order_events e
          WHERE e.order_id = o.id
            AND e.is_current = TRUE
            AND e.status = 'active'
        ) oe ON TRUE
        -- v3.2 §6.2 — open tasks assigned to any party on this order
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'id', t.id,
              'task_key', t.task_key,
              'assigned_role', t.assigned_role,
              'assigned_company_id', t.assigned_company_id,
              'assigned_user_id', t.assigned_user_id,
              'status', t.status,
              'due_at', t.due_at,
              'meta', t.meta
            ) ORDER BY t.due_at ASC NULLS LAST
          ) AS _tasks
          FROM order_tasks t
          WHERE t.order_id = o.id
            AND t.status NOT IN ('done', 'cancelled')
        ) ot ON TRUE
        LEFT JOIN companies fc ON NULLIF(TRIM(o.factory_code),'') IS NOT NULL AND fc.code = TRIM(o.factory_code)
    `, params = [], conds = [];

    // is_mock column was removed from orders table — filter dropped (ORDER-DATA-DISPLAY-UNBLOCK-001)

    if (customer) { params.push(`%${customer}%`); conds.push(`o.customer ILIKE $${params.length}`); }
    if (status)   { params.push(status);           conds.push(`o.status = $${params.length}`); }
    if (factory)  { params.push(factory);           conds.push(`o.raw->>'factory' = $${params.length}`); }
    // Exact-match lookups by order_no / contract_no (2026-05-22) — previously
    // these query params were silently ignored, so a "?order_no=X" call returned
    // the whole list in non-stable order (caused a wrong-row data edit).
    if (order_no)    { params.push(order_no);    conds.push(`o.order_no = $${params.length}`); }
    if (contract_no) { params.push(contract_no); conds.push(`o.contract_no = $${params.length}`); }
    if (company_codes) {
      let codeList; try { codeList = JSON.parse(company_codes); } catch { codeList = company_codes.split(","); }
      if (codeList.length > 0) {
        const ph = codeList.map(function(c) { params.push(c); return "$" + params.length; });
        conds.push(
          "(o.raw->>'companyCode' IN (" + ph.join(",") + ")" +
          " OR o.company_code IN (" + ph.join(",") + ")" +
          " OR o.raw->>'factoryCompanyCode' IN (" + ph.join(",") + "))"
        );
      }
    } else if (company_code) {
      params.push(company_code);
      conds.push(
        "(o.raw->>'companyCode' = $" + params.length +
        " OR o.company_code = $" + params.length +
        " OR o.raw->>'factoryCompanyCode' = $" + params.length + ")"
      );
    }
    if (brands) {
      let brandList;
      try { brandList = JSON.parse(brands); } catch { brandList = [brands]; }
      if (brandList.length > 0) {
        const orClauses = [];
        brandList.forEach(brand => { params.push(brand); orClauses.push(`o.raw->>'_widget_1775071325804' = $${params.length}`); });
        brandList.forEach(brand => { params.push(`%${brand}%`); orClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(o.raw->'products') p WHERE p->>'name' ILIKE $${params.length})`); });
        conds.push(`(${orClauses.join(' OR ')})`);
      }
    }
    if (sku) {
      params.push("%" + sku + "%");
      conds.push("EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.raw->'products','[]'::jsonb)) p WHERE p->>'sku' ILIKE $" + params.length + ")");
    }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY o.created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);

    // ── P1-1 field filtering (negative-list defence-in-depth) ──
    const requesterRole = (req.user && req.user.role) || null;
    const filtered = result.rows.map(function(r) { return stripSensitive(r, requesterRole); });

    // ── PRODUCTS-BACKFILL-001: promote raw.products → top-level products when empty ──
    // Some older orders have products only in raw.products (not in the top-level products column).
    // The serializer below strips raw from all external responses, so without this backfill those
    // 7 orders would show empty product lists in the customer/detail panel.
    // stripSensitive() has already cleaned raw.products of factoryPrice/cost/vatRate etc,
    // so it is safe to promote here — sensitive fields are already gone.
    const withProducts = filtered.map(function(r) {
      if (!r) return r;
      const hasTopProducts = Array.isArray(r.products) && r.products.length > 0;
      if (hasTopProducts) return r;
      const rawProducts = r.raw && Array.isArray(r.raw.products) && r.raw.products.length > 0
        ? r.raw.products
        : null;
      if (!rawProducts) return r;
      return Object.assign({}, r, { products: rawProducts });
    });

    // ── W0-1 role-scoped positive allowlist (fail-closed; default = customer_facing) ──
    // Runs AFTER stripSensitive: even if a sensitive key sneaks through the deny list,
    // it cannot exit unless the role's allowlist explicitly permits it.
    const safe = serializeOrdersForRole(withProducts, requesterRole);

    return res.status(200).json({ success: true, data: safe, count: result.rowCount });
  } catch (err) { if (res.headersSent) { console.error('[orders] 响应已发后又抛错:', err.message); return; } return res.status(500).json({ success: false, error: err.message }); }
}
