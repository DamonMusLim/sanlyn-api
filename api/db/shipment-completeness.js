// api/db/shipment-completeness.js — 出运完整度「专项单」只读端点
// GET /api/db/shipment-completeness?ref=<str>&by=auto|order_no|contract_no|bl_no|container_no|shipping_plan_id
// 铁律：只读、参数化、绝不造数。ref 不猜——唯一命中=resolved / 多命中=ambiguous(列candidates) / 无=missing。
// 订单↔海运 join 真实键 = shipping_plans.order_nos[] → orders.order_no（task 1817, 2026-06-24）。
// 标量 contract_no 仅作兜底(常为脏值 "FS.../FS..." 或 NULL, 匹配 0 单 → 旧逻辑误报「缺单」)。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = ["admin","logistics","operator","finance","sales","ceo","superadmin","system","trader"];

// 必需维度（缺=标红、计入 missing、扣 pct）；其余为可选（缺=灰显、不扣分）
const REQUIRED = new Set([
  "order","contract","sale_price_goods","sale_price_freight","sale_price_local","freight_cost","container",
]);
// 缺料 → 补料 skill
const NEXT_ACTION = {
  order:"order-intake", contract:"order-intake",
  sale_price_goods:"order-intake", sale_price_freight:"shipping-intake",
  sale_price_local:"shipping-intake", freight_cost:"shipping-intake",
  container:"container-intake", customs:"customs-declaration",
  invoice_docs:"invoice-doc-intake", payment_in:"finance-slip", payment_out:"finance-slip",
};
const DIM_ORDER = ["order","contract","sale_price_goods","sale_price_freight","sale_price_local",
  "freight_cost","container","customs","invoice_docs","payment_in","payment_out"];

const ISO_CONTAINER = /^[A-Z]{4}\d{7}$/i;
const BATCH_LIMIT = 100;
const BATCH_CONCURRENCY = 5;

// BL 前缀 → 船公司（local_charges.carrier 存的是船公司名，shipping_plans 无干净 carrier 列）
function carrierFromBl(bl) {
  const p = String(bl || "").toUpperCase();
  if (/^(COAU|COSU)/.test(p)) return "COSCO";
  if (/^OOLU/.test(p)) return "OOCL";
  if (/^(MEDU|MSCU|^177)/.test(p)) return "MSC";
  if (/^(MAEU|MAER)/.test(p)) return "MSK";
  if (/^EGLV/.test(p)) return "EVERGREEN";
  if (/^(ESL|WFLX|GSLP)/.test(p)) return "ESL";
  if (/^(KMTC|SITC|ONEY|YMJA|HLCU|CMAU|SNL)/.test(p)) return p.slice(0,4);
  return "";
}

// 安全查询：表/列缺失等错误 → 返回 null（让该维度降级 not_supported，不炸整请求）
async function safe(pool, sql, params) {
  try { return await pool.query(sql, params); }
  catch (e) { return { error: e.message, rows: [] }; }
}
const has = r => r && !r.error && r.rows && r.rows.length > 0;

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!req.user || !READ_ROLES.includes(req.user.role))
    return res.status(403).json({ success:false, error:"Forbidden" });

  const pool = getPool();
  const ref = String(req.query.ref || "").trim();
  const by  = String(req.query.by  || "auto").trim();
  if (!ref) return res.status(400).json({ success:false, error:"ref required" });

  try {
    // ── 1. 解析 ref → 候选 shipping_plans + orders（绝不猜，跨类型收集） ──
    const plansById = new Map();   // plan.id → plan row
    const orderRows = [];          // candidate orders
    const addPlans = r => { if (has(r)) for (const p of r.rows) plansById.set(p.id, p); };

    const wantOrder     = by === "auto" || by === "order_no";
    const wantContract  = by === "auto" || by === "contract_no";
    const wantBl        = by === "auto" || by === "bl_no";
    const wantContainer = by === "auto" || by === "container_no";
    const wantPlanId    = by === "auto" || by === "shipping_plan_id";

    if (wantContainer && (by === "container_no" || ISO_CONTAINER.test(ref) || by === "auto")) {
      addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE container_no ILIKE $1`, [`%${ref}%`]));
    }
    if (wantBl)       addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE bl_no = $1`, [ref]));
    if (wantContract) addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE contract_no = $1 OR $1 = ANY(contract_nos)`, [ref]));
    if (wantPlanId)   addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE id::text = $1 OR _id = $1`, [ref]));
    // task 1817: 真实关联键是 order_nos[] → orders.order_no。ref 是订单号时, 直接回溯命中该单的 plans。
    if (wantOrder)    addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE $1 = ANY(order_nos)`, [ref]));

    // orders 候选：order_no / contract_no / customer_po
    if (wantOrder || wantContract) {
      const o = await safe(pool,
        `SELECT * FROM orders WHERE order_no = $1 OR contract_no = $1 OR customer_po = $1`, [ref]);
      if (has(o)) orderRows.push(...o.rows);
    }

    // ── task 1817: 真实连接键是 shipping_plans.order_nos[] → orders.order_no ──────────
    // 旧逻辑只用标量 contract_no join orders。但 order_nos[] 有值而 contract_no 为脏值
    // (如 "FS.../FS...")或 NULL 时, 标量匹配命中 0 单 → 订单明明有却报「缺」(误报根因)。
    // 现在先用每个 plan 的 order_nos[] 拉关联订单, contract_no 仅作兜底。
    const orderNoSet = new Set();
    for (const p of plansById.values()) {
      if (Array.isArray(p.order_nos)) for (const on of p.order_nos) { const v = String(on || "").trim(); if (v) orderNoSet.add(v); }
    }
    if (orderNoSet.size) {
      const o3 = await safe(pool, `SELECT * FROM orders WHERE order_no = ANY($1::text[])`, [[...orderNoSet]]);
      if (has(o3)) { const seen = new Set(orderRows.map(x=>x.id)); for (const r of o3.rows) if (!seen.has(r.id)) orderRows.push(r); }
    }

    // 兜底/反向: 用 contract_no(标量 + contract_nos[]) 把 order 候选连到 plans
    const contractSet = new Set();
    for (const p of plansById.values()) {
      if (p.contract_no) contractSet.add(p.contract_no);
      if (Array.isArray(p.contract_nos)) for (const c of p.contract_nos) { const v = String(c || "").trim(); if (v) contractSet.add(v); }
    }
    for (const o of orderRows) if (o.contract_no) contractSet.add(o.contract_no);
    // 反向补：orders 命中合同 → 拉该合同的 plans；plans 命中合同 → 拉该合同的 orders
    if (contractSet.size) {
      const arr = [...contractSet];
      addPlans(await safe(pool, `SELECT * FROM shipping_plans WHERE contract_no = ANY($1::text[]) OR contract_nos && $1::text[]`, [arr]));
      const o2 = await safe(pool, `SELECT * FROM orders WHERE contract_no = ANY($1::text[])`, [arr]);
      if (has(o2)) { const seen = new Set(orderRows.map(x=>x.id)); for (const r of o2.rows) if (!seen.has(r.id)) orderRows.push(r); }
    }

    const plans = [...plansById.values()];

    // ── 2. resolution 判定（不猜） ──
    // 统一票 = contract_no；无合同的散 plan 用 __plan_N 标识。
    // task 1817 关键: 经 order_nos[] 连到某 plan 的订单, 它们的 contract_no 不得另立 group
    // (否则「无合同 plan + 它的订单合同号」会被误判成多票 ambiguous)。先算出「已被 plan 经
    // order_nos[] 认领的订单合同号」, 从 contractSet 里剔除。
    const planOrderNos = new Set();
    for (const p of plans) if (Array.isArray(p.order_nos)) for (const on of p.order_nos) { const v = String(on||"").trim(); if (v) planOrderNos.add(v); }
    const claimedContractNos = new Set();
    for (const o of orderRows) if (planOrderNos.has(String(o.order_no||"").trim()) && o.contract_no) claimedContractNos.add(o.contract_no);

    // contract group 只保留「干净且能匹配到订单」的 contract_no。
    // 一个 plan 的 contract_no 若匹配不到任何 order(脏值 "FS.../FS..." 或单纯没录),
    // 不立 contract group, 改走该 plan 的 __plan_N 组 + order_nos[] 连单(task 1817)。
    const orderContractNos = new Set(orderRows.map(o => o.contract_no).filter(Boolean));
    const groups = new Set();
    for (const c of contractSet) if (!claimedContractNos.has(c) && orderContractNos.has(c)) groups.add(c);
    // 散 plan(无干净匹配 contract_no)用 __plan_N。判据: contract_no 为空, 或其 contract_no
    // 匹配不到订单(脏值)。这类 plan 靠 order_nos[] 连单。
    const planHasCleanContract = (p) => p.contract_no && orderContractNos.has(p.contract_no) && !claimedContractNos.has(p.contract_no);
    const noContractPlans = plans.filter(p => !planHasCleanContract(p));
    for (const p of noContractPlans) groups.add(`__plan_${p.id}`);

    if (plans.length === 0 && orderRows.length === 0) {
      return res.status(200).json({ success:true, ref, by,
        resolution:{ status:"missing", matched_by:null, candidates:[] },
        message:"系统查无此票（待录入，不代表没货）" });
    }
    if (groups.size > 1) {
      const candidates = [...groups].map(g => {
        if (g.startsWith("__plan_")) {
          const p = plans.find(x => `__plan_${x.id}` === g);
          return { kind:"shipping_plan", shipping_plan_id:p?.id, bl_no:p?.bl_no, container_no:p?.container_no };
        }
        const ps = plans.filter(x => x.contract_no === g);
        const os = orderRows.filter(x => x.contract_no === g);
        return { kind:"contract", contract_no:g, plan_count:ps.length, order_count:os.length,
                 bl_nos:[...new Set(ps.map(x=>x.bl_no).filter(Boolean))] };
      });
      return res.status(200).json({ success:true, ref, by,
        resolution:{ status:"ambiguous", matched_by:null, candidates },
        message:"匹配到多票，请用更精确的标识（合同号/提单号/柜号）选定" });
    }

    // ── 3. resolved：唯一票，建 dossier + 维度 ──
    const groupKey = [...groups][0];
    const isContract = !groupKey.startsWith("__plan_");
    const contractNo = isContract ? groupKey : null;
    const myPlans  = isContract ? plans.filter(p => p.contract_no === contractNo) : plans.filter(p => `__plan_${p.id}` === groupKey);
    // task 1817: 用 order_nos[] 把该票的订单连进来 — 不再只靠 contract_no。
    // 收集本票所有 plan 的 order_nos[] + (合同票时)contract_no, 据此从候选订单里挑出 myOrders。
    const myOrderNos = new Set();
    for (const p of myPlans) if (Array.isArray(p.order_nos)) for (const on of p.order_nos) { const v = String(on||"").trim(); if (v) myOrderNos.add(v); }
    const myOrders = (() => {
      const seen = new Set(); const out = [];
      const push = (o) => { if (o && !seen.has(o.id)) { seen.add(o.id); out.push(o); } };
      for (const o of orderRows) {
        if (myOrderNos.has(String(o.order_no || "").trim())) push(o);           // 主键: order_nos[]
        else if (isContract && o.contract_no === contractNo) push(o);            // 兜底: contract_no
      }
      return out;
    })();
    const matchedBy = by !== "auto" ? by
      : (ISO_CONTAINER.test(ref) ? "container_no"
      : myOrders.some(o=>o.order_no===ref) ? "order_no"
      : myPlans.some(p=>p.bl_no===ref) ? "bl_no"
      : contractNo === ref ? "contract_no" : "auto");

    const planIds  = myPlans.map(p => p.id);
    const planUids = myPlans.map(p => p._id).filter(Boolean);
    const orderIds = myOrders.map(o => o.id);

    const dim = {}; // key → {status, required, detail, source}
    const setDim = (k, status, detail, source) =>
      dim[k] = { status, required: REQUIRED.has(k), detail, source };

    // order 订单+明细
    let lineCount = 0;
    if (orderIds.length) {
      const li = await safe(pool, `SELECT count(*)::int AS n FROM order_line_items WHERE order_id = ANY($1::int[])`, [orderIds]);
      lineCount = has(li) ? li.rows[0].n : 0;
    }
    if (!myOrders.length) setDim("order","missing","无关联订单","shipping_plans.order_nos[] → orders.order_no");
    else if (lineCount === 0) setDim("order","partial",`${myOrders.length} 订单但无明细行`,"order_line_items");
    else setDim("order","ok",`${myOrders.length} 订单 / ${lineCount} 明细行`,"orders + order_line_items");

    // contract 合同号
    const contracts = new Set([ ...myPlans.map(p=>p.contract_no), ...myOrders.map(o=>o.contract_no) ].filter(Boolean));
    if (!contracts.size) setDim("contract","missing","订单与海运均无合同号","orders/shipping_plans.contract_no");
    else if (contracts.size > 1) setDim("contract","partial",`合同号不一致：${[...contracts].join(", ")}`,"contract_no");
    else setDim("contract","ok",[...contracts][0],"contract_no");

    // sale_price_goods 货款销售价 = orders.total_amount
    if (!myOrders.length) setDim("sale_price_goods","missing","无订单","orders.total_amount");
    else {
      const miss = myOrders.filter(o => o.total_amount == null || Number(o.total_amount) <= 0);
      if (!miss.length) setDim("sale_price_goods","ok","全部订单有货款销售价","orders.total_amount");
      else setDim("sale_price_goods", miss.length===myOrders.length?"missing":"partial",
        `${miss.length}/${myOrders.length} 订单缺货款销售价`,"orders.total_amount");
    }

    // sale_price_freight 运费销售价 = shipping_plans.freight_sale_usd
    if (!myPlans.length) setDim("sale_price_freight","missing","无海运计划","shipping_plans.freight_sale_usd");
    else {
      const miss = myPlans.filter(p => p.freight_sale_usd == null || Number(p.freight_sale_usd) <= 0);
      if (!miss.length) setDim("sale_price_freight","ok","全部柜有运费销售价","shipping_plans.freight_sale_usd");
      else setDim("sale_price_freight", miss.length===myPlans.length?"missing":"partial",
        `${miss.length}/${myPlans.length} 柜缺运费销售价`,"shipping_plans.freight_sale_usd");
    }

    // sale_price_local 港杂销售价 = local_charges.sell_total（按路线 carrier+pol+pod+container_type）
    {
      let routeRows = 0, withSell = 0;
      for (const p of myPlans) {
        const carrier = carrierFromBl(p.bl_no);
        const lc = await safe(pool,
          `SELECT sell_total FROM local_charges
           WHERE ($1='' OR lower(btrim(coalesce(carrier,'')))=lower(btrim($1)))
             AND lower(btrim(coalesce(pol,'')))=lower(btrim($2))
             AND lower(btrim(coalesce(pod,'')))=lower(btrim($3))
           ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
          [carrier, p.pol || "", p.pod || ""]);
        if (has(lc)) { routeRows++; if (lc.rows[0].sell_total != null && Number(lc.rows[0].sell_total) > 0) withSell++; }
      }
      if (lc_unsupported(routeRows, myPlans.length)) setDim("sale_price_local","not_supported","该路线无港杂费率行","local_charges.sell_total");
      else if (withSell >= myPlans.length && myPlans.length) setDim("sale_price_local","ok","港杂销售价已维护","local_charges.sell_total");
      else if (withSell > 0) setDim("sale_price_local","partial",`${withSell}/${myPlans.length} 柜路线有港杂销售价`,"local_charges.sell_total");
      else setDim("sale_price_local","missing","路线港杂销售价未维护","local_charges.sell_total");
    }

    // freight_cost 海运成本 = freight_supplier_bills（按 container_no / link_plan_id）
    {
      const conds = [], params = [];
      const containers = myPlans.map(p=>p.container_no).filter(Boolean);
      if (containers.length) { params.push(containers); conds.push(`container_no = ANY($${params.length}::text[])`); }
      if (planUids.length)   { params.push(planUids);   conds.push(`link_plan_id = ANY($${params.length}::text[])`); }
      if (planIds.length)    { params.push(planIds.map(String)); conds.push(`link_plan_id = ANY($${params.length}::text[])`); }
      let bills = { rows: [] };
      if (conds.length) bills = await safe(pool,
        `SELECT cost_category, count(*)::int n FROM freight_supplier_bills WHERE ${conds.join(" OR ")} GROUP BY cost_category`, params);
      if (bills.error) setDim("freight_cost","not_supported","成本表查询不可用","freight_supplier_bills");
      else if (!bills.rows.length) setDim("freight_cost","missing","无货代账单成本","freight_supplier_bills");
      else {
        const cats = bills.rows.map(r=>r.cost_category).filter(Boolean);
        const hasOcean = cats.some(c => /海运|ocean/i.test(c));
        setDim("freight_cost", hasOcean ? "ok" : "partial",
          `${bills.rows.reduce((a,b)=>a+b.n,0)} 条成本（${cats.length} 费目）${hasOcean?"":"，缺海运费"}`,"freight_supplier_bills");
      }
    }

    // container 柜号
    {
      const withCtn = myPlans.filter(p => p.container_no && String(p.container_no).trim());
      if (!myPlans.length) setDim("container","missing","无海运计划","shipping_plans.container_no");
      else if (!withCtn.length) setDim("container","missing","柜号未录","shipping_plans.container_no");
      else if (withCtn.length < myPlans.length) setDim("container","partial",`${withCtn.length}/${myPlans.length} 柜有柜号`,"shipping_plans.container_no");
      else setDim("container","ok",withCtn.map(p=>p.container_no).join("; "),"shipping_plans.container_no");
    }

    // customs 报关（可选）= customs_data
    {
      const cd = await safe(pool, `SELECT count(*)::int n FROM customs_data WHERE contract_no = ANY($1::text[])`, [[...contracts]]);
      if (cd.error) setDim("customs","not_supported","报关表查询不可用","customs_data");
      else if (has(cd) && cd.rows[0].n > 0) setDim("customs","ok",`${cd.rows[0].n} 条报关记录`,"customs_data");
      else setDim("customs","missing","无报关资料","customs_data");
    }

    // invoice_docs 发票（可选）= finance_invoices_out
    {
      // finance_invoices_out 关联键是 contract_nos（复数，文本）→ 逐合同 ILIKE 匹配
      const cArr = [...contracts];
      const inv = cArr.length
        ? await safe(pool, `SELECT count(*)::int n FROM finance_invoices_out WHERE ` +
            cArr.map((_,i)=>`contract_nos::text ILIKE '%'||$${i+1}||'%'`).join(" OR "), cArr)
        : { rows: [] };
      if (inv.error) setDim("invoice_docs","not_supported","发票表查询不可用","finance_invoices_out");
      else if (has(inv) && inv.rows[0].n > 0) setDim("invoice_docs","ok",`${inv.rows[0].n} 张销售发票`,"finance_invoices_out");
      else setDim("invoice_docs","missing","无销售发票","finance_invoices_out");
    }

    // payment_in / payment_out（可选）= finance_payments direction
    for (const [k, dir, label] of [["payment_in","in","实收"],["payment_out","out","实付"]]) {
      const conds = [], params = [];
      if (contracts.size) { params.push([...contracts]); conds.push(`contract_no = ANY($${params.length}::text[])`); }
      if (planIds.length || planUids.length) {
        const pid = [...planIds.map(String), ...planUids]; params.push(pid);
        conds.push(`plan_id = ANY($${params.length}::text[])`);
      }
      let pay = { rows: [] };
      if (conds.length) pay = await safe(pool,
        `SELECT count(*)::int n, coalesce(sum(amount),0) amt FROM finance_payments WHERE direction=$${params.length+1} AND (${conds.join(" OR ")})`,
        [...params, dir]);
      if (pay.error) setDim(k,"not_supported",`${label}查询不可用`,"finance_payments");
      else if (has(pay) && pay.rows[0].n > 0) setDim(k,"ok",`${label} ${pay.rows[0].n} 笔 / ${pay.rows[0].amt}`,"finance_payments.direction");
      else setDim(k,"missing",`无${label}记录`,"finance_payments.direction");
    }

    // ── 4. 汇总 ──
    const dimensions = {};
    for (const k of DIM_ORDER) if (dim[k]) dimensions[k] = dim[k];
    const requiredKeys = DIM_ORDER.filter(k => REQUIRED.has(k) && dim[k]);
    const requiredOk = requiredKeys.filter(k => dim[k].status === "ok").length;
    const requiredTotal = requiredKeys.length;
    const missing = DIM_ORDER.filter(k => dim[k] && REQUIRED.has(k) && !["ok","not_supported"].includes(dim[k].status));
    const next_actions = DIM_ORDER
      .filter(k => dim[k] && !["ok","not_supported","ambiguous"].includes(dim[k].status))
      .map(k => ({ gap:k, required:REQUIRED.has(k), skill: NEXT_ACTION[k] || null, detail: dim[k].detail }));

    return res.status(200).json({ success:true, ref, by,
      resolution:{ status:"resolved", matched_by:matchedBy, candidates:[] },
      dossier:{
        contract_no: contractNo,
        shipping_plans: myPlans.map(p => ({ shipping_plan_id:p.id, contract_no:p.contract_no, bl_no:p.bl_no, freight_cost:p.freight_cost, freight_sale_usd:p.freight_sale_usd,
          container_no:p.container_no, vessel:p.vessel })),
        orders: myOrders.map(o => ({ order_id:o.id, order_no:o.order_no, customer:o.customer })),
      },
      dimensions,
      missing,
      next_actions,
      completeness:{ required_ok:requiredOk, required_total:requiredTotal,
        pct: requiredTotal ? Math.round(requiredOk / requiredTotal * 100) : 0 },
    });
  } catch (err) {
    return res.status(500).json({ success:false, error: err.message });
  }
}

function uniqueRefs(input) {
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const ref = String(raw || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function resolveOneViaHandler(req, ref, by) {
  let code = 200;
  let payload = null;
  const fakeReq = {
    ...req,
    method: "GET",
    query: { ref, by },
    body: undefined,
  };
  const fakeRes = {
    headersSent: false,
    setHeader() {},
    status(n) { code = n; return this; },
    json(body) { payload = body; this.headersSent = true; return body; },
    end() { this.headersSent = true; return undefined; },
  };
  await handler(fakeReq, fakeRes);
  if (code >= 400) {
    return { ref, error: payload?.error || `shipment-completeness failed with HTTP ${code}` };
  }
  return payload || { ref, error: "empty response" };
}

export async function batchHandler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ success:false, error:"POST only" });
  if (!req.user || !READ_ROLES.includes(req.user.role)) {
    return res.status(403).json({ success:false, error:"Forbidden" });
  }

  const body = req.body || {};
  if (!Array.isArray(body.refs)) {
    return res.status(400).json({ success:false, error:"refs must be an array" });
  }
  if (body.refs.length > BATCH_LIMIT) {
    return res.status(400).json({ success:false, error:`refs limit is ${BATCH_LIMIT} per request` });
  }

  const refs = uniqueRefs(body.refs);
  const by = String(body.by || "auto").trim();
  const results = await runLimited(refs, BATCH_CONCURRENCY, async (ref) => {
    try { return await resolveOneViaHandler(req, ref, by); }
    catch (err) { return { ref, error: err.message }; }
  });
  return res.status(200).json({ success:true, count:results.length, results });
}

// 路线无任一港杂费率行 → not_supported（无从判缺）；否则可判
function lc_unsupported(routeRows, planCount) {
  return planCount > 0 && routeRows === 0;
}
