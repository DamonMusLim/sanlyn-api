// booking-collab-view.js — 协同中枢视图补充端点
// Mounted by booking-collab-LIVE.js. Keep this file small and route-only.

const NON_EMPTY = v => v !== null && v !== undefined && String(v).trim() !== "";
const arr = v => Array.isArray(v) ? v : [];

function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw || {};
}

async function tableExists(pool, table) {
  const { rows } = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return !!(rows[0] && rows[0].ok);
}

async function columnExists(pool, table, column) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS ok`,
    [table, column]);
  return !!(rows[0] && rows[0].ok);
}

async function resolvePlan(pool, planRef) {
  const { rows } = await pool.query(
    `SELECT sp.* FROM shipping_plans sp WHERE sp._id = $1 OR sp.id::text = $1 LIMIT 1`,
    [String(planRef || "")]);
  return rows[0] || null;
}

export async function derivePlanFactories(pool, planId) {
  const { rows } = await pool.query(
    `SELECT NULLIF(TRIM(factory), '') AS label,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(total_qty), 0)::int AS total_qty
       FROM orders
      WHERE shipping_plan_id = $1
        AND NULLIF(TRIM(factory), '') IS NOT NULL
        AND (status IS NULL OR status NOT IN ('cancelled'))
      GROUP BY NULLIF(TRIM(factory), '')
      ORDER BY label`,
    [planId]);
  return rows.map(r => ({
    label: r.label,
    seqs: [],
    qty: r.order_count || null,
    note: null,
    submitted: false,
    source: "derived",
    order_count: r.order_count || 0,
    total_qty: r.total_qty || 0,
  }));
}

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
  const missing = [];
  const issues = [];
  const addMissing = (key, label, crit = true) => missing.push({ key, label, level: crit ? "crit" : "warn" });
  const addIssue = (key, message, level = "warn") => issues.push({ key, message, level });

  if (!factories.length) addMissing("factory", "工厂");
  if (!hasAny(plan, ["so_no", "vessel", "voyage", "carrier_code"]) && !hasJsonPath(raw, ["so_info", "sailing", "ocean"])) {
    addMissing("ocean", "海运");
  }
  if (!NON_EMPTY(plan.customer) && !NON_EMPTY(plan.customer_en)) addMissing("customer", "客户");
  if (!NON_EMPTY(plan.trucking_arrange) && !hasAny(plan, ["trucking_company_id", "trucking_cn"]) && !hasJsonPath(raw, ["trucking", "truck", "trucking_detail"])) {
    addMissing("trucking", "车队");
  }
  if (!NON_EMPTY(plan.customs_arrange) && !hasAny(plan, ["customs_broker_id", "customs_cn"]) && !customsRows.length) {
    addMissing("customs", "报关");
  }
  if (!NON_EMPTY(plan.release_type) && !hasJsonPath(raw, ["release_type", "bl_release_type"])) {
    addMissing("release_type", "提单方式");
  }
  if (!NON_EMPTY(plan.trade_terms) && !NON_EMPTY(plan.freight_term) && !hasJsonPath(raw, ["trade_terms", "incoterm"])) {
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

async function handleMasterView(req, res, pool) {
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
  return res.json(buildSummary(freshPlan, orders, factories, customs));
}

async function companyName(pool, id) {
  if (!NON_EMPTY(id)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(name_cn, name_en) AS n FROM companies WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] ? rows[0].n : null;
  } catch { return null; }
}

// party company_id 列 → 对应中文名列（写 id 时顺带回填名字，便于前端 linked() 判定）
const PARTY_COLUMNS = {
  forwarder_company_id: "forwarder_cn",
  customer_company_id: null,
  factory_company_id: null,
  trucking_company_id: "trucking_company_cn",
  customs_broker_id: "customs_broker_cn",
};
// 无专属列的党派 → 落 raw JSON（洋宝宝/巴匕，待迁移补列）
const RAW_PARTY = ["intermediary_company_id", "exporter_company_id"];
const SCALAR_COLS = ["trucking_arrange", "customs_arrange", "freight_term", "release_type"];

// POST /supply-chain — 保存某一方公司（手动选/一键关联/采纳建议都走这里）
async function handleSupplyChain(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });

  const sets = [], vals = [];
  for (const [col, cnCol] of Object.entries(PARTY_COLUMNS)) {
    if (!(col in body)) continue;
    const id = NON_EMPTY(body[col]) ? body[col] : null;
    vals.push(id); sets.push(`${col} = $${vals.length}`);
    if (id != null && cnCol) {
      const nm = await companyName(pool, id);
      if (nm) { vals.push(nm); sets.push(`${cnCol} = $${vals.length}`); }
    }
  }
  for (const col of SCALAR_COLS) {
    if (col in body) { vals.push(NON_EMPTY(body[col]) ? body[col] : null); sets.push(`${col} = $${vals.length}`); }
  }
  const rawPatch = {};
  for (const col of RAW_PARTY) if (col in body) rawPatch[col] = NON_EMPTY(body[col]) ? body[col] : null;
  if (Object.keys(rawPatch).length) {
    vals.push(JSON.stringify(rawPatch));
    sets.push(`raw = COALESCE(raw, '{}'::jsonb) || $${vals.length}::jsonb`);
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "没有可更新字段" });
  vals.push(plan.id);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// POST /assign-orders — 加/撤订单到本票
async function handleAssignOrders(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const add = arr(body.add).map(Number).filter(Boolean);
  const remove = arr(body.remove).map(Number).filter(Boolean);
  if (add.length) await pool.query(`UPDATE orders SET shipping_plan_id = $1 WHERE id = ANY($2::int[])`, [plan.id, add]);
  if (remove.length) await pool.query(`UPDATE orders SET shipping_plan_id = NULL WHERE id = ANY($1::int[]) AND shipping_plan_id = $2`, [remove, plan.id]);
  return res.json({ ok: true, added: add.length, removed: remove.length });
}

// POST /confirm-shipment — 确认已出运
async function handleConfirmShipment(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const sets = ["shipped_confirmed_at = NOW()"], vals = [];
  if (NON_EMPTY(body.shipment_date)) { vals.push(body.shipment_date); sets.push(`shipment_date = $${vals.length}`); }
  vals.push(plan.id);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// POST /add-factory — 关联现有工厂公司（或新建）
async function handleAddFactory(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  let companyId = NON_EMPTY(body.company_id) ? body.company_id : null, label = "", dup_warning = "";
  if (companyId) {
    const nm = await companyName(pool, companyId);
    if (!nm) return res.status(404).json({ ok: false, error: "找不到该公司" });
    label = nm;
  } else if (NON_EMPTY(body.name)) {
    const nm = String(body.name).trim();
    const ex = await pool.query(`SELECT id, COALESCE(name_cn,name_en) AS n FROM companies WHERE name_cn = $1 OR name_en = $1 LIMIT 1`, [nm]);
    if (ex.rows.length) { companyId = ex.rows[0].id; label = ex.rows[0].n; dup_warning = `已存在同名公司，已关联：${label}`; }
    else {
      try {
        const ins = await pool.query(`INSERT INTO companies (name_cn, type, active) VALUES ($1, 'factory', true) RETURNING id, name_cn`, [nm]);
        companyId = ins.rows[0].id; label = ins.rows[0].name_cn;
      } catch (e) { return res.status(400).json({ ok: false, error: "新建工厂失败：" + e.message }); }
    }
  } else return res.status(400).json({ ok: false, error: "company_id 或 name 必填" });
  await pool.query(`UPDATE shipping_plans SET factory_company_id = COALESCE(factory_company_id, $1) WHERE id = $2`, [companyId, plan.id]);
  return res.json({ ok: true, factory: { id: companyId, label }, dup_warning });
}

// POST /ai-fill-from-docs — 单据识别（OCR 待接，先返回空建议不报错）
async function handleAiFillFromDocs(req, res) {
  return res.json({ ok: true, suggestions: {}, note: "单据 OCR 识别尚未接入" });
}

// POST /ai-suggest — 从客户历史 + forwarder_partner 文本推断建议（只读，不写库）
async function handleAiSuggest(req, res, pool) {
  const body = req.body || {};
  const plan = await resolvePlan(pool, body.plan_id);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到计划" });
  const suggestions = {};
  const cust = plan.customer || plan.customer_en;
  if (NON_EMPTY(cust)) {
    const { rows } = await pool.query(
      `SELECT release_type, freight_term, trucking_company_id, customs_broker_id
         FROM shipping_plans
        WHERE id <> $1 AND (customer = $2 OR customer_en = $2)
        ORDER BY updated_at DESC NULLS LAST LIMIT 40`,
      [plan.id, cust]);
    const mode = (field) => {
      const cnt = {}; let total = 0;
      for (const r of rows) { const v = r[field]; if (NON_EMPTY(v)) { cnt[v] = (cnt[v] || 0) + 1; total++; } }
      let best = null, n = 0; for (const [k, c] of Object.entries(cnt)) if (c > n) { best = k; n = c; }
      return best ? { value: best, count: n, total } : null;
    };
    if (!NON_EMPTY(plan.release_type)) {
      const m = mode("release_type");
      if (m) suggestions.release_type = { value: m.value, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.total} 票中 ${m.count} 票用 ${m.value}` };
    }
    if (!NON_EMPTY(plan.freight_term)) {
      const m = mode("freight_term");
      if (m) suggestions.freight_term = { value: m.value, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${m.value}` };
    }
    if (!NON_EMPTY(plan.trucking_company_id)) {
      const m = mode("trucking_company_id");
      if (m) { const nm = await companyName(pool, m.value); if (nm) suggestions.trucking = { company_id: Number(m.value), company_cn: nm, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${nm}` }; }
    }
    if (!NON_EMPTY(plan.customs_broker_id)) {
      const m = mode("customs_broker_id");
      if (m) { const nm = await companyName(pool, m.value); if (nm) suggestions.broker = { company_id: Number(m.value), company_cn: nm, confidence: m.count >= 3 ? "high" : "medium", source: "客户历史", reason: `该客户 ${m.count} 票用 ${nm}` }; }
    }
  }
  const fp = plan.forwarder_partner || "";
  if (NON_EMPTY(fp)) {
    const parts = fp.split(/[×xX*、,，\/／&+]/).map(s => s.trim()).filter(s => s.length >= 2);
    for (const p of parts) {
      const { rows } = await pool.query(
        `SELECT id, COALESCE(name_cn, name_en) AS n FROM companies
          WHERE name_cn ILIKE $1 OR name_en ILIKE $1
          ORDER BY (type = 'forwarder') DESC, length(COALESCE(name_cn, name_en)) ASC LIMIT 2`,
        [`%${p}%`]);
      if (rows.length === 1) {
        const isBaby = /洋宝宝|宝宝|OCEANBABY/i.test(rows[0].n);
        const key = isBaby ? "intermediary" : "ocean";
        if (!suggestions[key] && !NON_EMPTY(plan[key === "ocean" ? "forwarder_company_id" : "intermediary_company_id"])) {
          suggestions[key] = { company_id: rows[0].id, company_cn: rows[0].n, confidence: "medium", source: "forwarder_partner 解析", reason: `来自 "${fp}"` };
        }
      }
    }
  }
  return res.json({ ok: true, suggestions });
}

export async function registerBookingCollabView(req, res, pool, ctx = {}) {
  const { pathSuffix, requireAuth } = ctx;
  const gate = () => {
    if (!requireAuth) { res.status(403).json({ ok: false, error: "auth_required" }); return false; }
    return requireAuth(req, res);
  };
  const routes = {
    "master-view": { methods: ["GET", "POST"], fn: handleMasterView },
    "supply-chain": { methods: ["POST"], fn: handleSupplyChain },
    "assign-orders": { methods: ["POST"], fn: handleAssignOrders },
    "confirm-shipment": { methods: ["POST"], fn: handleConfirmShipment },
    "add-factory": { methods: ["POST"], fn: handleAddFactory },
    "ai-suggest": { methods: ["POST"], fn: handleAiSuggest },
    "ai-fill-from-docs": { methods: ["POST"], fn: handleAiFillFromDocs },
  };
  const r = routes[pathSuffix];
  if (r && r.methods.includes(req.method)) {
    if (!gate()) return true;
    await r.fn(req, res, pool);
    return true;
  }
  return false;
}
