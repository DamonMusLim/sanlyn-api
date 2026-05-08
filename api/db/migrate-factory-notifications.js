// api/db/migrate-factory-notifications.js — B2-2A
//
// 目的：
//   1. 创建 factory_notifications 正式 PG 表（取代 B2-1 的 JSON 临时源）
//   2. 补 tasks.status 9 态 CHECK 约束（兼容 legacy open/doing/done/cancelled）
//
// 幂等：所有语句均 IF NOT EXISTS 或 DROP ... IF EXISTS 后重建。

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  FACTORY_TASK_STATUSES,
  FACTORY_NOTIFICATION_STATUSES,
  FACTORY_NOTIFICATION_SEVERITIES,
} from "../constants/factory-enums.js";

// 任务状态 CHECK：9 新 + legacy（open / doing / done / cancelled），且允许 NULL
var LEGACY_TASK_STATUSES = ["open", "doing", "done", "cancelled"];
var ALL_TASK_STATUSES = FACTORY_TASK_STATUSES.concat(LEGACY_TASK_STATUSES);
function quoteList(arr) {
  return arr.map(function (s) { return "'" + s.replace(/'/g, "''") + "'"; }).join(",");
}

var STATEMENTS = [
  // ── 1. factory_notifications 表 ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS factory_notifications (
    id              VARCHAR(64) PRIMARY KEY,
    factory_id      VARCHAR(64) NOT NULL,
    supplier_id     VARCHAR(64),
    task_id         VARCHAR(64),
    delivery_id     VARCHAR(64),
    title           TEXT NOT NULL,
    body            TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'unread',
    severity        VARCHAR(16) DEFAULT 'info',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ,
    audit           JSONB DEFAULT '{}'::jsonb
  )`,

  // 索引：按 factory_id + status + created_at 查询
  `CREATE INDEX IF NOT EXISTS idx_fn_factory   ON factory_notifications(factory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fn_status    ON factory_notifications(status)`,
  `CREATE INDEX IF NOT EXISTS idx_fn_task      ON factory_notifications(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fn_delivery  ON factory_notifications(delivery_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fn_created   ON factory_notifications(created_at DESC)`,

  // status CHECK（4 态，严格）
  `ALTER TABLE factory_notifications DROP CONSTRAINT IF EXISTS chk_fn_status`,
  `ALTER TABLE factory_notifications ADD CONSTRAINT chk_fn_status
     CHECK (status IN (` + quoteList(FACTORY_NOTIFICATION_STATUSES) + `))`,

  // severity CHECK（允许 NULL）
  `ALTER TABLE factory_notifications DROP CONSTRAINT IF EXISTS chk_fn_severity`,
  `ALTER TABLE factory_notifications ADD CONSTRAINT chk_fn_severity
     CHECK (severity IS NULL OR severity IN (` + quoteList(FACTORY_NOTIFICATION_SEVERITIES) + `))`,

  // ── 2. seed：如表为空，插入 3 条与 B2-1 JSON 源对齐的演示数据 ──
  `INSERT INTO factory_notifications
     (id, factory_id, task_id, delivery_id, title, body, status, severity, created_at, updated_at, audit)
   VALUES
     ('ntf-0001','FAC-JJ','t-00001',NULL,
      'Delivery doc rejected — missing CO',
      'Please re-upload Certificate of Origin signed by CCPIT.',
      'unread','warning','2026-04-23T08:12:00Z',NULL,
      '{"lastActionBy":"ops-wen","lastActionRole":"ops","lastActionAt":"2026-04-23T08:12:00.000Z"}'::jsonb),
     ('ntf-0002','FAC-JJ','t-00004','dlv-77',
      'Invoice accepted',
      'Your uploaded invoice #FS20260418075 was accepted.',
      'read','info','2026-04-22T02:45:00Z','2026-04-22T03:01:00Z',
      '{"lastActionBy":"factory-jj","lastActionRole":"factory","lastActionAt":"2026-04-22T03:01:00.000Z"}'::jsonb),
     ('ntf-0003','FAC-DB','t-00011',NULL,
      'Urge: pending driver info',
      'Driver info for container COAU1234567 is still missing.',
      'unread','critical','2026-04-24T01:10:00Z',NULL,
      '{"lastActionBy":"ops-wen","lastActionRole":"ops","lastActionAt":"2026-04-24T01:10:00.000Z"}'::jsonb)
   ON CONFLICT (id) DO NOTHING`,

  // ── 3. tasks.status 9 态 CHECK（兼容 legacy + 允许 NULL）───
  // 背景：现有数据含 'open' / 'doing'，不能直接切 9 态，必须 union 保证不拒旧数据。
  `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_status_v2`,
  `ALTER TABLE tasks ADD CONSTRAINT chk_tasks_status_v2
     CHECK (status IS NULL OR status IN (` + quoteList(ALL_TASK_STATUSES) + `))`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  // 仅允许 admin 触发（保持与其他 migrate 端点一致的防护；若需要自动化，后续开 CLI）
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
    return res.status(200).json({
      ok: true,
      log: log,
      enums: {
        task: FACTORY_TASK_STATUSES,
        task_legacy_allowed: LEGACY_TASK_STATUSES,
        notification: FACTORY_NOTIFICATION_STATUSES,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
