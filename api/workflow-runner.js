// api/workflow-runner.js
// 独立轮询器 — 只读现有业务表，零入侵其他代码
//
// 调用方式：
//   POST /api/workflow-runner          — 手动跑一次（Admin）
//   POST /api/workflow-runner?dry=1    — 预览，不执行动作
//
// 设计原则：
//   · 不 import 任何业务 API
//   · 用 workflow_events 做去重（同一实体同一 trigger 24h 内不重复触发）
//   · 每个 scan 函数只读现有表，发现条件满足 → 调 fireEvent

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { fireEvent } from "./workflow-engine.js";

var TENANT = "SANLYN";

// ── 去重检查 ──────────────────────────────────────────────────────────
// 同一 entity_id + trigger 在 cooldown_hours 内已触发过 → 跳过
async function alreadyFired(pool, trigger, entityId, cooldownHours = 24) {
  var { rows } = await pool.query(
    `SELECT 1 FROM workflow_events
     WHERE trigger = $1
       AND entity_id = $2
       AND status = 'fired'
       AND created_at > NOW() - ($3 || ' hours')::INTERVAL
     LIMIT 1`,
    [trigger, entityId, cooldownHours]
  );
  return rows.length > 0;
}

// ── Scan 1: 客户应收账款催款 ──────────────────────────────────────────
// 读 finance_records(direction=AR, status=pending)
// 距到期日 ≤ remind_days_before 或已逾期 → 触发 ar_payment_reminder
async function scanArReminders(pool, dry) {
  var results = [];

  // 读规则：哪些公司配了催款规则（或全局默认）
  var { rows: rules } = await pool.query(
    `SELECT * FROM workflow_rules
     WHERE is_active = true
       AND trigger = 'ar_payment_reminder'
       AND tenant_id = $1
     ORDER BY company_code NULLS LAST, priority DESC`,
    [TENANT]
  );
  if (!rules.length) return results;

  // 拉出所有 pending AR，距到期 ≤ 7 天 或已逾期
  var { rows: records } = await pool.query(
    `SELECT fr.*, c.payment_type, c.payment_days, c.name_en, c.name_cn
     FROM finance_records fr
     LEFT JOIN customers c ON c.company_code = fr.counterparty_code
     WHERE fr.direction = 'AR'
       AND fr.status IN ('pending','partial')
       AND fr.due_date IS NOT NULL
       AND fr.due_date <= (NOW() + '7 days'::INTERVAL)::DATE
       AND fr.tenant_id = $1`,
    [TENANT]
  );

  for (var rec of records) {
    var entityId = "ar-" + rec.record_no;
    var daysOverdue = Math.floor((new Date() - new Date(rec.due_date)) / 86400000);

    // 冷却：逾期前提醒每 3 天一次，逾期后每 1 天一次
    var cooldown = daysOverdue >= 0 ? 24 : 72;
    if (await alreadyFired(pool, "ar_payment_reminder", entityId, cooldown)) continue;

    var ctx = {
      tenant_id:    TENANT,
      company_code: rec.counterparty_code,
      company_type: "customer",
      entity_type:  "finance_record",
      entity_id:    entityId,
      payment_type: rec.payment_type || "prepaid",
      record_no:    rec.record_no,
      amount:       rec.amount,
      currency:     rec.currency,
      due_date:     rec.due_date,
      days_overdue: daysOverdue,
      contract_no:  rec.contract_no,
      shipment_no:  rec.shipment_no,
      company_name: rec.name_en || rec.counterparty,
    };

    results.push({ trigger: "ar_payment_reminder", entityId, daysOverdue, dry });
    if (!dry) await fireEvent("ar_payment_reminder", ctx);
  }
  return results;
}

// ── Scan 2: 催工厂开票 ────────────────────────────────────────────────
// 读 finance_records(direction=AP, status=pending_invoice)
// 或：shipping_plans 里 etd 已过，但对应工厂没有 AP 记录
async function scanFactoryInvoiceRequests(pool, dry) {
  var results = [];

  // 已发货（etd 已过）但没有对应 AP 记录的订单
  var { rows: plans } = await pool.query(
    `SELECT sp.shipment_no, sp.order_nos, sp.customer, sp.etd,
            c.company_code, c.name_en
     FROM shipping_plans sp
     LEFT JOIN customers c ON c.portal_role = 'factory'
       AND c.company_code = ANY(
         SELECT DISTINCT factory FROM orders
         WHERE order_no = ANY(sp.order_nos)
       )
     WHERE sp.etd IS NOT NULL
       AND sp.etd < NOW()::DATE
       AND sp.etd > (NOW() - '30 days'::INTERVAL)::DATE
       AND NOT EXISTS (
         SELECT 1 FROM finance_records fr
         WHERE fr.shipment_no = sp.shipment_no
           AND fr.direction = 'AP'
           AND fr.category = 'factory_invoice'
           AND fr.status NOT IN ('cancelled')
       )
       AND sp.tenant_id = $1`,
    [TENANT]
  );

  for (var plan of plans) {
    var entityId = "fi-" + plan.shipment_no;
    if (await alreadyFired(pool, "factory_invoice_request", entityId, 48)) continue;

    var ctx = {
      tenant_id:    TENANT,
      company_code: plan.company_code,
      company_type: "factory",
      entity_type:  "shipping_plan",
      entity_id:    entityId,
      shipment_no:  plan.shipment_no,
      company_name: plan.name_en || plan.customer,
    };

    results.push({ trigger: "factory_invoice_request", entityId, shipmentNo: plan.shipment_no, dry });
    if (!dry) await fireEvent("factory_invoice_request", ctx);
  }
  return results;
}

// ── Scan 3: 付款申请长时间未审核 ─────────────────────────────────────
// finance_records(direction=AP, status=pending_review) 超过 N 小时未处理
async function scanPaymentRequestStale(pool, dry) {
  var results = [];

  var { rows: stale } = await pool.query(
    `SELECT * FROM finance_records
     WHERE direction = 'AP'
       AND status = 'pending_review'
       AND created_at < NOW() - '8 hours'::INTERVAL
       AND tenant_id = $1`,
    [TENANT]
  );

  for (var rec of stale) {
    var entityId = "pr-stale-" + rec.record_no;
    if (await alreadyFired(pool, "payment_request_stale", entityId, 8)) continue;

    var ctx = {
      tenant_id:    TENANT,
      company_code: rec.counterparty_code,
      company_type: "factory",
      entity_type:  "finance_record",
      entity_id:    entityId,
      record_no:    rec.record_no,
      amount:       rec.amount,
      currency:     rec.currency,
      shipment_no:  rec.shipment_no,
    };

    results.push({ trigger: "payment_request_stale", entityId, recordNo: rec.record_no, dry });
    if (!dry) await fireEvent("payment_request_stale", ctx);
  }
  return results;
}

// ── 主入口 ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin" && req.user.role !== "system") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  var pool = getPool();

  // ── GET: 最近操作记录（供前端 AI 职守面板展示）──────────────────
  if (req.method === "GET") {
    var limit = Math.min(parseInt(req.query.limit) || 50, 200);
    var { rows: events } = await pool.query(
      `SELECT we.id, we.trigger, we.entity_type, we.entity_id,
              we.company_code, we.action, we.status, we.error,
              we.created_at,
              wr.name AS rule_name
       FROM workflow_events we
       LEFT JOIN workflow_rules wr ON wr.id = we.rule_id
       WHERE we.tenant_id = $1
       ORDER BY we.created_at DESC
       LIMIT $2`,
      [TENANT, limit]
    );

    // 汇总统计
    var { rows: [stats] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='fired')    AS total_fired,
         COUNT(*) FILTER (WHERE status='skipped')  AS total_skipped,
         COUNT(*) FILTER (WHERE status='failed')   AS total_failed,
         COUNT(*) FILTER (WHERE created_at > NOW() - '24 hours'::INTERVAL) AS last_24h,
         MAX(created_at) AS last_run_at
       FROM workflow_events WHERE tenant_id = $1`,
      [TENANT]
    );

    return res.status(200).json({ ok: true, events, stats });
  }

  var dry = req.query.dry === "1";

  try {
    var [ar, fi, pr] = await Promise.all([
      scanArReminders(pool, dry),
      scanFactoryInvoiceRequests(pool, dry),
      scanPaymentRequestStale(pool, dry),
    ]);

    return res.status(200).json({
      ok: true,
      dry,
      summary: {
        ar_reminders:          ar.length,
        factory_invoice_req:   fi.length,
        payment_review_stale:  pr.length,
        total:                 ar.length + fi.length + pr.length,
      },
      detail: { ar, fi, pr },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
