// api/workflow-engine.js
// 核心：fireEvent(trigger, context) — 查规则 → 匹配 → 执行 action

import { getPool } from "./db.js";

// ── Action 执行器 ─────────────────────────────────────────────────────

async function execNotifyFactory(pool, rule, ctx) {
  var cfg = rule.action_config || {};
  var id = "ntf-wf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  await pool.query(
    `INSERT INTO factory_notifications
       (id, factory_id, task_id, title, body, status, severity, created_at, updated_at, audit)
     VALUES ($1,$2,$3,$4,$5,'unread',$6,NOW(),NOW(),$7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      ctx.company_code,
      ctx.task_id || null,
      cfg.title || "Notification",
      cfg.body || "",
      cfg.severity || "info",
      JSON.stringify({ triggeredBy: "workflow", trigger: ctx.trigger, ruleId: rule.id }),
    ]
  );
  return { notificationId: id };
}

async function execCreatePaymentRequest(pool, rule, ctx) {
  var cfg = rule.action_config || {};
  var recordNo = "PAY-REQ-" + Date.now();
  await pool.query(
    `INSERT INTO finance_records
       (record_no, direction, category, status, currency, amount,
        counterparty, counterparty_code, contract_no, shipment_no, raw, created_by)
     VALUES ($1,'AP','factory_invoice','pending_review',$2,$3,$4,$5,$6,$7,$8::jsonb,'workflow')
     ON CONFLICT (record_no) DO NOTHING`,
    [
      recordNo,
      ctx.currency || "USD",
      ctx.amount || 0,
      ctx.company_name || ctx.company_code,
      ctx.company_code,
      ctx.contract_no || null,
      ctx.shipment_no || null,
      JSON.stringify({ ruleId: rule.id, trigger: ctx.trigger, invoiceUrl: ctx.invoice_url }),
    ]
  );
  return { recordNo };
}

async function execReleaseDocsToCustomer(pool, rule, ctx) {
  // 标记 DAS 文件对客户可见（读写权限由 DAS 管，这里只记录动作）
  return { released: ctx.doc_types || [], orderId: ctx.order_id };
}

async function execReleaseDocsAndCreateAR(pool, rule, ctx) {
  await execReleaseDocsToCustomer(pool, rule, ctx);
  var cfg = rule.action_config || {};
  if (cfg.create_ar) {
    var recordNo = "AR-" + Date.now();
    await pool.query(
      `INSERT INTO finance_records
         (record_no, direction, category, status, currency, amount,
          counterparty, counterparty_code, contract_no, shipment_no, due_date, raw, created_by)
       VALUES ($1,'AR','customer_invoice','pending',$2,$3,$4,$5,$6,$7,
               (NOW() + ($8 || ' days')::INTERVAL)::DATE,
               $9::jsonb,'workflow')
       ON CONFLICT (record_no) DO NOTHING`,
      [
        recordNo,
        ctx.currency || "USD",
        ctx.amount || 0,
        ctx.company_name || ctx.company_code,
        ctx.company_code,
        ctx.contract_no || null,
        ctx.shipment_no || null,
        ctx.payment_days || 30,
        JSON.stringify({ ruleId: rule.id, trigger: ctx.trigger }),
      ]
    );
  }
  return { released: true, arCreated: !!cfg.create_ar };
}

// 通知客户门户（复用 factory_notifications 表，factory_id 存客户 company_code）
async function execNotifyCustomer(pool, rule, ctx) {
  var cfg = rule.action_config || {};
  var id = "ntf-cust-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  await pool.query(
    `INSERT INTO factory_notifications
       (id, factory_id, title, body, status, severity, created_at, updated_at, audit)
     VALUES ($1,$2,$3,$4,'unread',$5,NOW(),NOW(),$6::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      ctx.company_code,
      cfg.title || "Notification",
      cfg.body || "",
      cfg.severity || "info",
      JSON.stringify({ triggeredBy: "workflow", trigger: ctx.trigger, ruleId: rule.id }),
    ]
  );
  return { notificationId: id };
}

// 通知运营团队（写入 factory_notifications，factory_id 固定为 'OPS'）
async function execNotifyOps(pool, rule, ctx) {
  var cfg = rule.action_config || {};
  var id = "ntf-ops-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  await pool.query(
    `INSERT INTO factory_notifications
       (id, factory_id, title, body, status, severity, created_at, updated_at, audit)
     VALUES ($1,'OPS',$2,$3,'unread',$4,NOW(),NOW(),$5::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      cfg.title || "Action required",
      (cfg.body || "") + (ctx.record_no ? " | Ref: " + ctx.record_no : ""),
      cfg.severity || "warning",
      JSON.stringify({ triggeredBy: "workflow", trigger: ctx.trigger, ruleId: rule.id, context: ctx }),
    ]
  );
  return { notificationId: id };
}

var ACTIONS = {
  notify_factory:              execNotifyFactory,
  notify_customer:             execNotifyCustomer,
  notify_ops:                  execNotifyOps,
  create_payment_request:      execCreatePaymentRequest,
  release_docs_to_customer:    execReleaseDocsToCustomer,
  release_docs_and_create_ar:  execReleaseDocsAndCreateAR,
};

// ── 条件匹配 ──────────────────────────────────────────────────────────
// condition JSONB 里的每个 key 必须与 ctx 匹配
// 值可以是 scalar 或数组（数组 = in 匹配）
function matchCondition(condition, ctx) {
  if (!condition || Object.keys(condition).length === 0) return true;
  for (var [k, v] of Object.entries(condition)) {
    var ctxVal = ctx[k];
    if (Array.isArray(v)) {
      if (!v.includes(ctxVal)) return false;
    } else {
      if (ctxVal !== v) return false;
    }
  }
  return true;
}

// ── 主入口 ────────────────────────────────────────────────────────────
// trigger: string  e.g. 'shipment_confirmed'
// ctx: object      e.g. { company_code, order_id, shipment_no, payment_type, ... }
export async function fireEvent(trigger, ctx = {}) {
  var pool = getPool();
  ctx.trigger = trigger;

  // 1. 拉出所有匹配此 trigger 的活跃规则（按 priority 降序）
  var { rows: rules } = await pool.query(
    `SELECT wr.*
     FROM workflow_rules wr
     WHERE wr.is_active = true
       AND wr.trigger = $1
       AND wr.tenant_id = $2
       AND (wr.company_code IS NULL OR wr.company_code = $3)
       AND (wr.company_type = 'all'
            OR wr.company_type = $4)
     ORDER BY wr.priority DESC, wr.id ASC`,
    [trigger, ctx.tenant_id || "SANLYN", ctx.company_code || "", ctx.company_type || "all"]
  );

  var results = [];

  for (var rule of rules) {
    // 2. 条件过滤
    if (!matchCondition(rule.condition, ctx)) {
      await logEvent(pool, trigger, rule, ctx, "skipped", null, null);
      continue;
    }

    // 3. 执行 action
    var executor = ACTIONS[rule.action];
    if (!executor) {
      await logEvent(pool, trigger, rule, ctx, "failed", null, "Unknown action: " + rule.action);
      continue;
    }

    try {
      var result = await executor(pool, rule, ctx);
      await logEvent(pool, trigger, rule, ctx, "fired", result, null);
      results.push({ ruleId: rule.id, action: rule.action, result });
    } catch (err) {
      await logEvent(pool, trigger, rule, ctx, "failed", null, err.message);
    }
  }

  return results;
}

async function logEvent(pool, trigger, rule, ctx, status, result, error) {
  try {
    await pool.query(
      `INSERT INTO workflow_events
         (trigger, entity_type, entity_id, company_code, rule_id, action, status, payload, error, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        trigger,
        ctx.entity_type || null,
        ctx.entity_id || null,
        ctx.company_code || null,
        rule?.id || null,
        rule?.action || null,
        status,
        JSON.stringify({ ctx, result }),
        error || null,
        ctx.tenant_id || "SANLYN",
      ]
    );
  } catch (_) {
    // 日志失败不影响主流程
  }
}
