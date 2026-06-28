// api/db/migrate-workflow.js
// 幂等：所有语句 IF NOT EXISTS，可重复执行

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

var STATEMENTS = [

  // ── 1. customers 表：规范化付款条款 ──────────────────────────────
  // payment_type: 枚举，流程引擎据此分支
  // payment_days: 账期天数（prepaid=0，net30=30，以此类推）
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'prepaid'
     CHECK (payment_type IN ('prepaid','net30','net60','net90','cod','custom'))`,

  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS payment_days INTEGER DEFAULT 0`,

  // ── 2. workflow_rules 表 ──────────────────────────────────────────
  // 每条记录 = 一个"当 X 发生时，对满足 condition 的公司执行 action"
  // company_code NULL = 全局默认规则
  `CREATE TABLE IF NOT EXISTS workflow_rules (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(128) NOT NULL,
    company_code   VARCHAR(64),
    company_type   VARCHAR(20) DEFAULT 'all'
                   CHECK (company_type IN ('all','customer','factory')),
    trigger        VARCHAR(64) NOT NULL,
    condition      JSONB DEFAULT '{}'::jsonb,
    action         VARCHAR(64) NOT NULL,
    action_config  JSONB DEFAULT '{}'::jsonb,
    priority       INTEGER DEFAULT 0,
    is_active      BOOLEAN DEFAULT true,
    tenant_id      VARCHAR(20) DEFAULT 'SANLYN',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wr_trigger
     ON workflow_rules (tenant_id, trigger, is_active)`,

  `CREATE INDEX IF NOT EXISTS idx_wr_company
     ON workflow_rules (company_code)`,

  // ── 3. workflow_events 表：所有触发记录（用于审计+去重） ─────────
  `CREATE TABLE IF NOT EXISTS workflow_events (
    id             SERIAL PRIMARY KEY,
    trigger        VARCHAR(64) NOT NULL,
    entity_type    VARCHAR(32),
    entity_id      VARCHAR(128),
    company_code   VARCHAR(64),
    rule_id        INTEGER REFERENCES workflow_rules(id),
    action         VARCHAR(64),
    status         VARCHAR(20) DEFAULT 'fired'
                   CHECK (status IN ('fired','skipped','failed')),
    payload        JSONB DEFAULT '{}'::jsonb,
    error          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    tenant_id      VARCHAR(20) DEFAULT 'SANLYN'
  )`,

  `CREATE INDEX IF NOT EXISTS idx_we_entity
     ON workflow_events (entity_type, entity_id)`,

  `CREATE INDEX IF NOT EXISTS idx_we_trigger
     ON workflow_events (trigger, created_at DESC)`,

  // ── 4. 内置默认规则（发货后自动触发链路） ───────────────────────
  // Rule 1: 发货确认 → 通知工厂开票
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('发货后通知工厂开票',
      NULL, 'factory',
      'shipment_confirmed',
      '{}'::jsonb,
      'notify_factory',
      '{"template":"invoice_request","severity":"info","title":"Please issue invoice","body":"Shipment confirmed. Please upload your commercial invoice for payment processing."}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 2: 工厂上传发票 → 创建付款申请（等待审核）
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('工厂发票上传后创建付款申请',
      NULL, 'factory',
      'invoice_uploaded',
      '{}'::jsonb,
      'create_payment_request',
      '{"status":"pending_review","notify_roles":["admin","ops"],"title":"Payment request pending review"}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 3: 付款申请审核通过 → 通知工厂
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('付款审核通过通知工厂',
      NULL, 'factory',
      'payment_approved',
      '{}'::jsonb,
      'notify_factory',
      '{"template":"payment_approved","severity":"info","title":"Payment approved","body":"Your payment request has been approved and will be processed."}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 4: 现款客户 - 报关单放行后直接推文件
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('现款客户放行后自动发单据',
      NULL, 'customer',
      'customs_cleared',
      '{"payment_type":"prepaid"}'::jsonb,
      'release_docs_to_customer',
      '{"doc_types":["customs_declaration","release_order"],"notify_channels":["portal","email"]}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 5: 账期客户 - 报关单放行后推文件 + 挂应收
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('账期客户放行后发单据并挂应收',
      NULL, 'customer',
      'customs_cleared',
      '{"payment_type":["net30","net60","net90"]}'::jsonb,
      'release_docs_and_create_ar',
      '{"doc_types":["customs_declaration","release_order"],"notify_channels":["portal","email"],"create_ar":true}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 6: 应收账款到期前自动催款（客户）
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('应收账款自动催款',
      NULL, 'customer',
      'ar_payment_reminder',
      '{}'::jsonb,
      'notify_customer',
      '{"template":"payment_due","severity":"warning","title":"Payment reminder","body":"Your invoice is due soon. Please arrange payment at your earliest convenience."}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 7: 催工厂上传发票
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('发货后催工厂上传发票',
      NULL, 'factory',
      'factory_invoice_request',
      '{}'::jsonb,
      'notify_factory',
      '{"template":"invoice_request","severity":"warning","title":"Invoice upload required","body":"Your shipment has been confirmed. Please upload your commercial invoice for payment processing."}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,

  // Rule 8: 付款申请长时间未审核 → 提醒运营
  `INSERT INTO workflow_rules
     (name, company_code, company_type, trigger, condition, action, action_config, priority)
   VALUES
     ('付款申请超时提醒运营',
      NULL, 'all',
      'payment_request_stale',
      '{}'::jsonb,
      'notify_ops',
      '{"severity":"critical","title":"Payment request needs review","body":"A payment request has been pending review for over 8 hours."}'::jsonb,
      10)
   ON CONFLICT DO NOTHING`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin" && req.user.role !== "system") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  try {
    var pool = getPool();
    var log = [];
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 80).replace(/\s+/g, " "));
    }
    return res.status(200).json({ ok: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
