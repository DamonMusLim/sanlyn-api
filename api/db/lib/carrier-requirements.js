// carrier-requirements.js — 承运人要求规则引擎。
// 命中 carrier_requirement_rules → 物化 shipment_requirement_tasks(幂等)→ 按角色列给确认单。
// 数据驱动:加船司/加要求=后台插一行规则,不改代码。

const CARRIER_ALIASES = {
  COSU: ["COSU", "COSCO", "中远"],
  // 后续船司在此加别名(SCAC ↔ 名 ↔ 中文),或接 carriers/carrier_aliases 表
};

// requirements jsonb 旗标 → 任务类型
const REQ_TASK_MAP = {
  requires_loi: "LOI_BOOKING",
  requires_cargo_declaration: "CARGO_DECLARATION",
  requires_dg_declaration: "DG_DECLARATION",
  requires_fumigation_cert: "WOOD_PACKAGING_DECL",
  requires_msds: "MSDS",
};
const TASK_LABEL = {
  LOI_BOOKING: "货物申报保函 (LOI)",
  CARGO_DECLARATION: "货品申报",
  DG_DECLARATION: "危险品申报 (DG)",
  WOOD_PACKAGING_DECL: "木质包装/熏蒸证",
  MSDS: "MSDS 安全说明书",
};

function up(v) { return String(v || "").toUpperCase(); }
function ilikeMatch(val, pat) {
  const a = up(val), b = up(pat);
  return !b || a.includes(b) || b.includes(a);
}
function carrierMatches(ruleCode, planCarriers) {
  const rc = up(ruleCode);
  const aliases = (CARRIER_ALIASES[rc] || [rc]).map(up);
  return planCarriers.some(pc => aliases.some(a => pc.includes(a) || a.includes(pc)));
}

export async function evaluateRules(pool, plan) {
  const { rows } = await pool.query(
    `SELECT * FROM carrier_requirement_rules
      WHERE is_active = true
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
        AND (effective_to   IS NULL OR effective_to   >= CURRENT_DATE)
      ORDER BY priority DESC, id`);
  const planCarriers = [plan.carrier_code, plan.shipping_line, plan.vessel]
    .filter(Boolean).map(up);
  if (!planCarriers.length) return [];
  return rows.filter(r =>
    carrierMatches(r.carrier_code, planCarriers) &&
    ilikeMatch(plan.pol, r.origin_port) &&
    ilikeMatch(plan.pod, r.dest_port));
}

// 物化 + 列出。role 传则只回该角色负责的任务(货代=supplier_portal);internal=true 回全部。
export async function materializeAndList(pool, planId, { role, internal = false } = {}) {
  const { rows: pr } = await pool.query(
    `SELECT id, carrier_code, shipping_line, vessel, pol, pod, etd FROM shipping_plans WHERE id = $1`, [planId]);
  const plan = pr[0];
  if (!plan) return [];
  const rules = await evaluateRules(pool, plan);
  for (const rule of rules) {
    const reqs = (typeof rule.requirements === "string" ? JSON.parse(rule.requirements) : rule.requirements) || {};
    for (const [flag, taskType] of Object.entries(REQ_TASK_MAP)) {
      if (!reqs[flag]) continue;
      const snap = JSON.stringify({ carrier: plan.carrier_code || plan.shipping_line, pol: plan.pol, pod: plan.pod, etd: plan.etd });
      await pool.query(
        `INSERT INTO shipment_requirement_tasks
           (shipping_plan_id, carrier_code, rule_id, task_type, responsible_role, status, source_snapshot, blocking_stage)
         VALUES ($1,$2,$3,$4,$5,'requested',$6::jsonb,$7)
         ON CONFLICT (shipping_plan_id, rule_id, task_type) DO NOTHING`,
        [planId, rule.carrier_code, rule.id, taskType, rule.required_of_role, snap, rule.blocking_stage]);
    }
  }
  const { rows } = await pool.query(
    `SELECT id, task_type, responsible_role, status, blocking_stage, due_at,
            loi_template_version, signed_by, signed_at, evidence_ref, reject_reason
       FROM shipment_requirement_tasks
      WHERE shipping_plan_id = $1
        AND ($2::boolean OR responsible_role IS NULL OR responsible_role = $3)
      ORDER BY id`,
    [planId, internal, role || ""]);
  return rows.map(t => ({ ...t, label: TASK_LABEL[t.task_type] || t.task_type }));
}
