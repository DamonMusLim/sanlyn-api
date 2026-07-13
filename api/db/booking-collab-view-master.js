// booking-collab-view-master.js — master-view 聚合（拆自 booking-collab-view.js 2026-07-13）
import { NON_EMPTY, arr, parseRaw, tableExists, columnExists, resolvePlan, companyName, derivePlanFactories } from "./booking-collab-view-lib.js";

async function getFactories(pool, plan) {
  const fromTable = [];
  if (await tableExists(pool, "plan_factories")) {
    const hasShippingPlanId = await columnExists(pool, "plan_factories", "shipping_plan_id");
    const hasPlanId = await columnExists(pool, "plan_factories", "plan_id");
    const hasBusinessId = await columnExists(pool, "plan_factories", "plan_business_id");
    let where = "";
    let vals = [];
    if (hasShippingPlanId) {
      where = "pf.shipping_plan_id = $1";
      vals = [plan.id];
    } else if (hasPlanId) {
      where = "pf.plan_id::text = $1";
      vals = [String(plan.id)];
    } else if (hasBusinessId) {
      where = "pf.plan_business_id = $1";
      vals = [String(plan._id || plan.id)];
    }
    if (!where) return await derivePlanFactories(pool, plan.id);
    const { rows } = await pool.query(
      `SELECT to_jsonb(pf) AS j FROM plan_factories pf WHERE ${where}`,
      vals);
    for (const r of rows) {
      const j = r.j || {};
      const label = j.label || j.factory || j.factory_name || j.name;
      if (NON_EMPTY(label)) fromTable.push({ ...j, label, source: "plan_factories" });
    }
  }
  if (fromTable.length) return fromTable;
  return await derivePlanFactories(pool, plan.id);
}

async function getOrders(pool, planId) {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_no, o.contract_no, o.factory, o.customer, o.export_mode,
            o.trade_terms, o.issuing_company,
            o.total_qty, o.gross_weight, o.raw,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(oli))
                FROM order_line_items oli
               WHERE oli.order_id = o.id
            ), '[]'::jsonb) AS items
       FROM orders o
      WHERE o.shipping_plan_id = $1
        AND (o.status IS NULL OR o.status NOT IN ('cancelled'))
      ORDER BY o.order_no NULLS LAST, o.id`,
    [planId]);
  return rows;
}

async function getCustoms(pool, planId, orders) {
  if (!(await tableExists(pool, "customs_data"))) return [];
  const hasPlan = await columnExists(pool, "customs_data", "shipping_plan_id");
  const hasOrder = await columnExists(pool, "customs_data", "order_no");
  const orderNos = orders.map(o => o.order_no).filter(NON_EMPTY);
  if (hasPlan) {
    const { rows } = await pool.query(
      `SELECT to_jsonb(cd) AS j FROM customs_data cd WHERE cd.shipping_plan_id = $1`,
      [planId]);
    return rows.map(r => r.j || {});
  }
  if (hasOrder && orderNos.length) {
    const { rows } = await pool.query(
      `SELECT to_jsonb(cd) AS j FROM customs_data cd WHERE cd.order_no = ANY($1::text[])`,
      [orderNos]);
    return rows.map(r => r.j || {});
  }
  return [];
}

function hasAny(obj, keys) {
  return keys.some(k => NON_EMPTY(obj && obj[k]));
}

function hasJsonPath(raw, keys) {
  return keys.some(k => NON_EMPTY(raw && raw[k]));
}

function priceReady(plan, orders) {
  const raw = parseRaw(plan.raw);
  if (plan.freight_sale_usd !== null && plan.freight_sale_usd !== undefined) return true;
  if (arr(raw.cost_lines).length || arr(raw.pricing_decisions).length) return true;
  return orders.some(o => arr(o.items).some(i =>
    Number(i.unit_price || 0) > 0 ||
    Number(i.declare_amount_per_box || 0) > 0 ||
    Number(i.subtotal || 0) > 0));
}

function customsDocReady(customsRows, raw) {
  if (customsRows.length) return true;
  if (arr(raw.collab_uploads).some(u => ["customs_decl", "customs_declaration"].includes(u.doc_type || u.type))) return true;
  return hasJsonPath(raw, ["customs_decl", "customs_declaration", "customs_doc", "customs_receipt"]);
}

function buildSummary(plan, orders, factories, customsRows) {
  const raw = parseRaw(plan.raw);
  // 读时派生:本票订单里一致的值(空计划字段可用它兜底,不落库)
  const orderOne = (f) => {
    const s = [...new Set((orders || []).map(o => NON_EMPTY(o[f]) ? String(o[f]).trim() : "").filter(Boolean))];
    return s.length === 1 ? s[0] : null;
  };
  const missing = [];
  const issues = [];
  const addMissing = (key, label, crit = true) => missing.push({ key, label, level: crit ? "crit" : "warn" });
  const addIssue = (key, message, level = "warn") => issues.push({ key, message, level });

  if (!factories.length) addMissing("factory", "工厂");
  if (!hasAny(plan, ["so_no", "vessel", "voyage", "carrier_code"]) && !hasJsonPath(raw, ["so_info", "sailing", "ocean"])) {
    addMissing("ocean", "海运");
  }
  if (!NON_EMPTY(plan.customer) && !NON_EMPTY(plan.customer_en) && !orders.some(o => NON_EMPTY(o.customer))) addMissing("customer", "客户");
  if (!NON_EMPTY(plan.trucking_arrange) && !hasAny(plan, ["trucking_company_id", "trucking_company_cn"]) && !hasJsonPath(raw, ["trucking", "truck", "trucking_detail"])) {
    addMissing("trucking", "车队");
  }
  if (!NON_EMPTY(plan.customs_arrange) && !hasAny(plan, ["customs_broker_id", "customs_broker_cn"]) && !customsRows.length) {
    addMissing("customs", "报关");
  }
  if (!NON_EMPTY(plan.release_type) && !hasJsonPath(raw, ["release_type", "bl_release_type"])) {
    addMissing("release_type", "提单方式");
  }
  if (!NON_EMPTY(plan.trade_terms) && !NON_EMPTY(plan.freight_term) && !hasJsonPath(raw, ["trade_terms", "incoterm"]) && !orderOne("trade_terms")) {
    addMissing("trade_terms", "交易方式");
  }
  if (!NON_EMPTY(plan.bl_no) && !NON_EMPTY(plan.hbl_no)) addMissing("bl", "BL");
  if (!customsDocReady(customsRows, raw)) addMissing("customs_doc", "报关单", false);
  if (!priceReady(plan, orders)) addMissing("price", "价格");

  if (!orders.length) addIssue("orders", "本票没有关联订单", "crit");
  const noFactoryOrders = orders.filter(o => !NON_EMPTY(o.factory)).map(o => o.order_no || String(o.id));
  if (noFactoryOrders.length) addIssue("order_factory", `订单缺工厂: ${noFactoryOrders.join(", ")}`, "warn");
  const noItems = orders.filter(o => !arr(o.items).length).map(o => o.order_no || String(o.id));
  if (noItems.length) addIssue("order_items", `订单缺明细: ${noItems.join(", ")}`, "warn");

  const crit = missing.filter(x => x.level === "crit").length + issues.filter(x => x.level === "crit").length;
  const warn = missing.filter(x => x.level !== "crit").length + issues.filter(x => x.level !== "crit").length;
  return { ok: true, missing, issues, crit, warn, total: crit + warn };
}

export async function handleMasterView(req, res, pool) {
  const source = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const planRef = source.plan_id;
  if (!planRef) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const plan = await resolvePlan(pool, planRef);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });

  if (req.method === "POST") {
    const sets = [];
    const vals = [];
    if (Object.prototype.hasOwnProperty.call(source, "release_type")) {
      vals.push(source.release_type || null);
      sets.push(`release_type = $${vals.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(source, "trade_terms")) {
      vals.push(source.trade_terms || null);
      if (await columnExists(pool, "shipping_plans", "trade_terms")) {
        sets.push(`trade_terms = $${vals.length}`);
      } else {
        sets.push(`raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{trade_terms}', to_jsonb(COALESCE($${vals.length}::text, '')), true)`);
      }
    }
    if (sets.length) {
      vals.push(plan.id);
      await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    }
  }

  const freshPlan = req.method === "POST" ? await resolvePlan(pool, plan.id) : plan;
  const orders = await getOrders(pool, freshPlan.id);
  const factories = await getFactories(pool, freshPlan);
  const customs = await getCustoms(pool, freshPlan.id, orders);
  const summary = buildSummary(freshPlan, orders, factories, customs);
  const rawp2 = parseRaw(freshPlan.raw);
  summary.intermediary_company_id = rawp2.intermediary_company_id || null;
  summary.intermediary_cn = await companyName(pool, rawp2.intermediary_company_id);
  summary.exporter_company_id = rawp2.exporter_company_id || null;
  summary.exporter_cn = await companyName(pool, rawp2.exporter_company_id);
  return res.json(summary);
}
