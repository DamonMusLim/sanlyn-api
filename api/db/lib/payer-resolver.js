// payer-resolver v1.1.0 · 2026-08-17
// 费用归属判定(Damon 0817 DNA): 先看提单发货人,再看条款,不看订单工厂
//   R0 raw.payer_locked=1 → 原值不动
//   R1 驳船(任何写法) → BABI 且归类=海运成本(联程一段,从美金差价扣,不作港杂)
//       其他海运费(不论USD/CNY) → 收货人客户
//   R2a 内转外 → BABI   R2b EXW → 客户
//   R2c FOB: 发货人=我方贸易公司 → BABI;发货人=外部工厂 → 该发货人
//   R2d 混条款 / R2e 缺条款 → needsHuman + ask{} + 建 terms-<票> 任务
// 验收: 12/12 归属 + CNY海运归客户 + 驳船归BABI + locked + ask + exw,全过(2026-08-17 真库)
export const PAYER_RESOLVER_VERSION = "1.1.0";

const SELF = "SELF";

function clean(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return clean(v).toUpperCase();
}

function rawOf(o) {
  return o && typeof o.raw === "object" && o.raw !== null ? o.raw : {};
}

function list(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  if (!v) return [];
  return String(v).split(/[,\s|/]+/).map(clean).filter(Boolean);
}

function intId(v) {
  const s = clean(v);
  return /^[0-9]{1,6}$/.test(s) ? Number(s) : null;
}

function planTextId(plan) {
  return clean(plan?._id) || null;
}

function planIntId(plan) {
  return intId(plan?.id);
}

function stripBlSuffix(v) {
  return clean(v).replace(/#(?:merged-to|void)-.*$/i, "").replace(/#retired$/i, "");
}

function stripCarrierPrefix(v) {
  return upper(stripBlSuffix(v)).replace(/^[A-Z]{4}(?=[A-Z0-9]{6,})/, "");
}

function sameBl(a, b) {
  const x = upper(stripBlSuffix(a));
  const y = upper(stripBlSuffix(b));
  return !!x && !!y && (x === y || stripCarrierPrefix(x) === stripCarrierPrefix(y));
}

function locked(row) {
  return clean(rawOf(row).payer_locked) === "1";
}

function existingPayer(row) {
  return clean(row?.payer_company_code || row?.payer) || null;
}

function hasLine(row) {
  return !!row && ["cost_category", "fee_name", "currency", "incoterm", "trade_terms", "raw"].some(k => row[k] != null);
}

function taskSubject(plan, row) {
  return clean(row?.bl_no || plan?.bl_no || plan?.shipment_no || plan?._id || plan?.id);
}

function taskId(prefix, plan, row) {
  return `${prefix}${taskSubject(plan, row)}`;
}

function result({ payer, basis, confidence = "medium", needsHuman = false, reason, owned, task_id, hint, ask }) {
  return { payer: payer || null, basis, confidence, needsHuman, reason, owned: owned ?? !!payer, task_id, hint, ask };
}

function isOcean(row) {
  return /海运|ocean/i.test(clean(row?.cost_category || row?.fee_name));
}

function isBargeOcean(row) {
  return /驳船|barge/i.test(clean(row?.cost_category));
}

function isUsdOcean(row) {
  return upper(row?.currency || "CNY") === "USD" && isOcean(row);
}

function isCny(row) {
  return ["CNY", "RMB", ""].includes(upper(row?.currency || "CNY"));
}

function mode(plan, row) {
  return clean(rawOf(plan).transport_mode || rawOf(row).transport_mode || plan?.transport_mode || row?.transport_mode);
}

function explicitTerms(plan, row) {
  return [
    row?.incoterm,
    row?.trade_terms,
    rawOf(row).incoterm,
    rawOf(row).trade_terms,
    plan?.freight_term,
    plan?.trade_terms,
    rawOf(plan).freight_term,
    rawOf(plan).trade_terms,
    rawOf(plan).incoterm,
  ].map(upper).filter(Boolean);
}

function orderTerm(o) {
  return upper(o?.trade_terms || o?.freight_term);
}

function termsFrom(ctx, plan, row) {
  if (ctx.orders.length) return [...new Set(ctx.orders.map(orderTerm).filter(Boolean))];
  return [...new Set(explicitTerms(plan, row))];
}

function missingTermOrders(ctx) {
  return ctx.orders.filter(o => !orderTerm(o));
}

function primaryOrderCustomer(ctx) {
  return ctx.orders.find(o => clean(o.company_code))?.company_code || null;
}

function planCustomerCode(plan) {
  return clean(plan?.company_code || rawOf(plan).company_code || plan?.customer_company_code || rawOf(plan).customer_company_code) || null;
}

function planCustomerName(plan) {
  return clean(plan?.customer_en || plan?.customer || plan?.customer_cn || rawOf(plan).customer_en || rawOf(plan).customer || rawOf(plan).customer_cn) || null;
}

async function companyCodeByExactName(pool, name) {
  if (!name) return null;
  const r = await pool.query(
    `SELECT code
       FROM companies
      WHERE NULLIF(BTRIM(code),'') IS NOT NULL
        AND (BTRIM(name_en)=BTRIM($1) OR BTRIM(name_cn)=BTRIM($1))
      ORDER BY id`,
    [name]);
  return r.rows.length === 1 ? clean(r.rows[0].code) : null;
}

async function primaryCustomer(pool, ctx, plan) {
  return primaryOrderCustomer(ctx) || planCustomerCode(plan) || await companyCodeByExactName(pool, planCustomerName(plan));
}

function shipperCode(ctx, plan) {
  const explicit = clean(rawOf(plan).shipper_company_code || plan?.shipper_company_code);
  if (explicit) return explicit;
  if (ctx.orders.length) return SELF;
  return null;
}

function planTermConflict(ctx, plan, row) {
  const orderTerms = new Set(ctx.orders.map(orderTerm).filter(Boolean));
  if (orderTerms.size !== 1) return null;
  const orderOnly = [...orderTerms][0];
  const conflicting = explicitTerms(plan, row).find(t => t && t !== orderOnly);
  return conflicting ? `plan.freight_term=${conflicting} 与订单条款不符(已按订单)` : null;
}

function linkMismatchReason(plan, row) {
  if (!row || !plan || !row.bl_no || !plan.bl_no || sameBl(row.bl_no, plan.bl_no)) return null;
  return `账单BL与票BL不一致(疑两套号): ${clean(row.bl_no)} -> ${clean(plan.bl_no)}${plan.match_basis ? `; plan匹配=${plan.match_basis}` : ""}`;
}

async function ensureTermsTask(pool, plan, row, ctx) {
  const missing = missingTermOrders(ctx).map(o => clean(o.order_no || o.contract_no || o.id)).filter(Boolean);
  const bl = taskSubject(plan, row);
  const textId = planTextId(plan);
  const id = planIntId(plan);
  const summary = await pool.query(
    `SELECT COUNT(*)::int AS line_count, COALESCE(SUM(COALESCE(amount, qty * unit_price, 0)), 0)::numeric AS amount
       FROM active_freight_supplier_bills
      WHERE COALESCE(currency,'CNY') IN ('CNY','RMB','')
        AND ((NULLIF(BTRIM($1::text),'') IS NOT NULL AND BTRIM(bl_no)=BTRIM($1::text))
          OR (NULLIF(BTRIM($2::text),'') IS NOT NULL AND BTRIM(link_plan_id)=BTRIM($2::text))
          OR ($3::int IS NOT NULL AND link_plan_id ~ '^[0-9]{1,6}$' AND link_plan_id::int=$3::int))`,
    [clean(plan?.bl_no || row?.bl_no), textId, id]);
  const lineCount = summary.rows[0]?.line_count || (hasLine(row) ? 1 : 0);
  const amount = Number(summary.rows[0]?.amount || row?.amount || 0);
  const question = missing.length
    ? `这些订单缺 trade_terms: ${missing.join(", ")}。请确认是 EXW 还是 FOB?`
    : `这票 ${bl} 是 EXW 还是 FOB?`;
  const ask = { question, subject_type: "shipping_plan", subject_id: planIntId(plan), options: ["EXW", "FOB"] };
  await pool.query(
    `INSERT INTO tasks (id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
     VALUES ($1, '待确认条款', $2, 'open', 'payer-guard', 'logistics', $3, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET reason = EXCLUDED.reason, status = 'open', updated_at = now()`,
    [`terms-${bl}`, `缺条款导致 ${lineCount} 行费用无法判归属,涉及金额 ${amount}`, clean(plan?.id || bl)]);
  return ask;
}

export async function detectInternalTransfer(pool, plan) {
  if (!plan) return false;
  const bl = clean(plan?.bl_no);
  const textId = planTextId(plan);
  const id = planIntId(plan);
  const r = await pool.query(
    `SELECT 1
       FROM active_freight_supplier_bills
      WHERE ((NULLIF(BTRIM($1::text),'') IS NOT NULL AND BTRIM(bl_no)=BTRIM($1::text))
         OR (NULLIF(BTRIM($2::text),'') IS NOT NULL AND BTRIM(link_plan_id)=BTRIM($2::text))
         OR ($3::int IS NOT NULL AND link_plan_id ~ '^[0-9]{1,6}$' AND link_plan_id::int=$3::int))
        AND cost_category ~ '驳船费|转关费|套柜费'
      LIMIT 1`,
    [bl, textId, id]);
  return r.rows.length > 0;
}

async function internalTransferHint(pool, plan) {
  return await detectInternalTransfer(pool, plan) ? "transport_mode 未填,内转外规则未生效" : undefined;
}

export async function findPlan(pool, rowOrRef) {
  const link = clean(rowOrRef?.link_plan_id || rowOrRef?._id || "");
  const bl = clean(rowOrRef?.bl_no || rowOrRef?.bl || rowOrRef?.shipment_no || "");
  if (link) {
    const byText = await pool.query(`SELECT *, 'link_plan_id=_id' AS match_basis FROM shipping_plans WHERE deleted_at IS NULL AND BTRIM(_id)=BTRIM($1) ORDER BY id DESC LIMIT 1`, [link]);
    if (byText.rows.length) return byText.rows[0];
    const byInt = await pool.query(`SELECT *, 'link_plan_id=id::text' AS match_basis FROM shipping_plans WHERE deleted_at IS NULL AND id::text=BTRIM($1) ORDER BY id DESC LIMIT 1`, [link]);
    if (byInt.rows.length) return byInt.rows[0];
  }
  if (!bl) return null;
  const r = await pool.query(
    `SELECT *, 'bl_no' AS match_basis
       FROM shipping_plans
      WHERE deleted_at IS NULL
        AND (BTRIM(bl_no)=BTRIM($1)
          OR regexp_replace(upper(regexp_replace(bl_no, '#(merged-to|void)-.*$|#retired$', '', 'i')), '^[A-Z]{4}(?=[A-Z0-9]{6,})', '')=$2)
      ORDER BY id DESC LIMIT 1`,
    [bl, stripCarrierPrefix(bl)]);
  return r.rows[0] || null;
}

export async function orderContext(pool, plan) {
  const id = planIntId(plan);
  const bl = clean(plan?.bl_no);
  const r = await pool.query(
    `WITH matched AS (
       SELECT NULLIF(BTRIM(o.company_code),'') AS company_code,
              NULLIF(BTRIM(o.trade_terms),'') AS trade_terms,
              NULLIF(BTRIM(o.freight_term),'') AS freight_term,
              COALESCE(o.customer_amount, o.total_amount, 0) AS order_amount,
              o.id, o.order_no, o.contract_no
         FROM orders o
        WHERE o.deleted_at IS NULL AND (
              (NULLIF(BTRIM($1::text),'') IS NOT NULL AND (BTRIM(o.bl_no)=BTRIM($1::text)
                OR regexp_replace(upper(regexp_replace(o.bl_no, '#(merged-to|void)-.*$|#retired$', '', 'i')), '^[A-Z]{4}(?=[A-Z0-9]{6,})', '')=$2))
           OR ($3::int IS NOT NULL AND o.shipping_plan_id=$3::int)
           OR o.order_no = ANY(COALESCE($4::text[],'{}'::text[]))
           OR o.contract_no = ANY(COALESCE($5::text[],'{}'::text[]))
        )
     )
     SELECT * FROM matched
      ORDER BY order_amount DESC NULLS LAST, id`,
    [bl, stripCarrierPrefix(bl), id, list(plan?.order_nos), list(plan?.contract_nos)]);
  return { orders: r.rows, owned: r.rows.length > 0 };
}

function money(row) {
  const amount = Number(row?.amount);
  if (Number.isFinite(amount)) return amount;
  const qty = Number(row?.qty || 1);
  const unit = Number(row?.unit_price || 0);
  return Number.isFinite(qty * unit) ? qty * unit : 0;
}

function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function containerQty(plan) {
  const raw = rawOf(plan);
  const direct = number(plan?.container_qty || raw.container_qty || raw.containerQty);
  if (direct > 0) return direct;
  const detail = Array.isArray(plan?.containers_detail) ? plan.containers_detail : Array.isArray(raw.containers_detail) ? raw.containers_detail : [];
  const detailQty = detail.reduce((sum, item) => sum + Math.max(1, number(item?.qty || item?.quantity || item?.count)), 0);
  if (detailQty > 0) return detailQty;
  return list(plan?.container_no || raw.container_no || raw.containerNo).length || 1;
}

function billableMoney(row, plan) {
  if (!isPerContainer(row)) return money(row);
  const qty = containerQty(plan);
  const unit = number(row?.unit_price);
  if (unit > 0) return unit * qty;
  const amount = money(row);
  const rowQty = number(row?.qty);
  if (rowQty > 0 && rowQty !== qty) return (amount / rowQty) * qty;
  return amount;
}

function isPerContainer(row) {
  const s = upper(`${row?.charge_basis || ""} ${row?.unit || ""} ${row?.cost_category || ""} ${row?.fee_name || ""}`);
  return /PER_CONTAINER|CONTAINER|柜|THC|场站|港杂|封签|设备交接|VGM/.test(s);
}

function isTrucking(row) {
  return /拖车|提箱|提进|待时|停车|吊机|陆运|truck/i.test(`${row?.cost_category || ""} ${row?.fee_name || ""}`);
}

function poList(plan, orders) {
  const pos = orders.map(o => clean(o.order_no)).filter(Boolean);
  return pos.length ? [...new Set(pos)] : list(rawOf(plan).customerPO || plan?.customerPO || plan?.order_nos);
}

function allocate(total, pos, basis) {
  if (!pos.length) return [];
  const each = Number((total / pos.length).toFixed(2));
  return pos.map((po, i) => ({ po, amount: i === pos.length - 1 ? Number((total - each * (pos.length - 1)).toFixed(2)) : each, basis }));
}

export async function exwBillableBreakdown(pool, plan) {
  const ctx = await orderContext(pool, plan);
  const pos = poList(plan, ctx.orders);
  const bl = clean(plan?.bl_no);
  const textId = planTextId(plan);
  const id = planIntId(plan);
  const bills = await pool.query(
    `SELECT id, bl_no, cost_category, amount, currency, qty, unit_price, charge_basis
       FROM active_freight_supplier_bills
      WHERE COALESCE(currency,'CNY') IN ('CNY','RMB','')
        AND ((NULLIF(BTRIM($1::text),'') IS NOT NULL AND BTRIM(bl_no)=BTRIM($1::text))
          OR (NULLIF(BTRIM($2::text),'') IS NOT NULL AND BTRIM(link_plan_id)=BTRIM($2::text))
          OR ($3::int IS NOT NULL AND link_plan_id ~ '^[0-9]{1,6}$' AND link_plan_id::int=$3::int))
      ORDER BY id`,
    [bl, textId, id]);
  const qty = containerQty(plan);
  const perContainer = bills.rows.filter(isPerContainer).map(r => ({ ...r, container_qty: qty, billable_amount: Number(billableMoney(r, plan).toFixed(2)) }));
  const trucking = bills.rows.filter(isTrucking).map(r => ({ ...r, billable_amount: Number(money(r).toFixed(2)) }));
  const merged = [...new Map([...perContainer, ...trucking].map(r => [r.id, r])).values()];
  const total = merged.reduce((sum, r) => sum + Number(r.billable_amount || 0), 0);
  return {
    po_allocation: allocate(total, pos, pos.length > 1 ? "按柜量分摊" : "整票"),
    per_container_items: perContainer,
    trucking_items: trucking,
    total_cny: Number(total.toFixed(2)),
  };
}

export async function resolvePayer(pool, plan, row = null) {
  if (!plan) return result({ payer: null, basis: "no-plan", confidence: "low", needsHuman: true, reason: "missing shipping_plan", owned: false });

  if (locked(row)) {
    return result({ payer: existingPayer(row), basis: "locked", confidence: "high", reason: "raw.payer_locked=1" });
  }

  const ctx = await orderContext(pool, plan);
  const customer = await primaryCustomer(pool, ctx, plan);
  const mismatch = linkMismatchReason(plan, row);

  if (!hasLine(row)) {
    return customer
      ? result({ payer: customer, basis: "legacy-order", confidence: "medium", reason: ["compatible old signature: matched order customer", mismatch].filter(Boolean).join("; "), owned: true })
      : result({ payer: null, basis: "legacy-no-order", confidence: "low", needsHuman: true, reason: "compatible old signature: no matched order", owned: false, task_id: taskId("payer-", plan, row) });
  }

  // 驳船=联程运输的一段,属海运费成本(不是港杂,不单独向客户收);
  // 成本由我方承担并从美金海运差价里扣 → payer=BABI,但归类为 ocean-cost 不是 port charge
  if (isBargeOcean(row)) {
    return result({ payer: "BABI", basis: "barge-is-ocean-cost", confidence: "high", reason: ["驳船是联程海运的一段,计入海运费成本,从美金差价扣,不作港杂向客户收", mismatch].filter(Boolean).join("; "), owned: true, hint: "此行应归入海运成本桶,勿并入港杂" });
  }

  if (isOcean(row)) {
    return customer
      ? result({ payer: customer, basis: "ocean-customer", confidence: "high", reason: ["海运费按费用性质归收货人客户(不论USD/CNY)", mismatch].filter(Boolean).join("; "), owned: true })
      : result({ payer: null, basis: "ocean-no-customer", confidence: "low", needsHuman: true, reason: "海运费行但没匹配到客户订单", owned: false, task_id: taskId("payer-", plan, row) });
  }

  if (!isCny(row)) {
    return customer
      ? result({ payer: customer, basis: "legacy-order", confidence: "medium", reason: ["non-CNY/non-USD line kept compatible with order customer", mismatch].filter(Boolean).join("; "), owned: true })
      : result({ payer: null, basis: "legacy-no-order", confidence: "low", needsHuman: true, reason: "no matched order for non-CNY line", owned: false, task_id: taskId("payer-", plan, row) });
  }

  if (mode(plan, row) === "内转外" || await detectInternalTransfer(pool, plan)) {
    return result({ payer: "BABI", basis: "cny-internal-transfer", confidence: "high", reason: ["transport_mode=内转外 or internal transfer bill signal; routing choice belongs to BABI", mismatch].filter(Boolean).join("; "), owned: true });
  }

  if (!ctx.orders.length) {
    const shipper = shipperCode(ctx, plan);
    if (shipper) return result({ payer: shipper, basis: "cny-fob-external-shipper", confidence: "high", reason: ["无订单且 raw.shipper_company_code 存在; 代运外单按 FOB 发货人口径", mismatch].filter(Boolean).join("; "), owned: true });
  }

  const terms = termsFrom(ctx, plan, row);
  const hasExw = terms.includes("EXW");
  const hasFob = terms.includes("FOB");
  if (ctx.orders.length && missingTermOrders(ctx).length) {
    const ask = await ensureTermsTask(pool, plan, row, ctx);
    return result({ payer: null, basis: "missing-order-terms", confidence: "low", needsHuman: true, reason: ["some matched orders have blank trade_terms/freight_term", mismatch].filter(Boolean).join("; "), owned: false, task_id: `terms-${taskSubject(plan, row)}`, ask });
  }
  if (hasExw && hasFob) {
    return result({ payer: null, basis: "mixed-terms", confidence: "low", needsHuman: true, reason: "same BL has multiple order trade terms", owned: false, task_id: taskId("payer-mixterm-", plan, row) });
  }
  const conflict = planTermConflict(ctx, plan, row);
  if (hasExw) {
    return customer
      ? result({ payer: customer, basis: "cny-exw-customer", confidence: "high", reason: ["EXW CNY local charges belong to consignee customer", conflict, mismatch].filter(Boolean).join("; "), owned: true })
      : result({ payer: null, basis: "cny-exw-no-customer", confidence: "low", needsHuman: true, reason: "EXW terms found but no customer code matched", owned: false, task_id: taskId("payer-", plan, row) });
  }
  if (hasFob) {
    const shipper = shipperCode(ctx, plan);
    if (shipper === SELF) return result({ payer: "BABI", basis: "cny-fob-self-shipper", confidence: "high", reason: ["FOB shipper is BABI trade company; factory is supplier only", conflict, mismatch].filter(Boolean).join("; "), owned: true, hint: await internalTransferHint(pool, plan) });
    if (shipper) return result({ payer: shipper, basis: "cny-fob-external-shipper", confidence: "high", reason: ["FOB external shipper pays CNY local charges", conflict, mismatch].filter(Boolean).join("; "), owned: true });
    return result({ payer: null, basis: "cny-fob-no-shipper", confidence: "low", needsHuman: true, reason: "FOB terms found but shipper cannot be resolved", owned: false, task_id: taskId("payer-", plan, row) });
  }

  const ask = await ensureTermsTask(pool, plan, row, ctx);
  return result({ payer: null, basis: "unknown-terms", confidence: "low", needsHuman: true, reason: ["cannot resolve EXW/FOB terms", mismatch].filter(Boolean).join("; "), owned: false, task_id: `terms-${taskSubject(plan, row)}`, ask });
}
