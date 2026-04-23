// migrate-collab.js — P1-3: 协作记录最小表
//
// 两层模型：
//   collaboration_threads   — 一个任务/对象上的协作话题
//   collaboration_messages  — 话题下的消息
//
// 强制绑定对象（不允许裸聊天）：
//   每条 thread 必须有 (owner_object_type, owner_object_id)
//   task_id 可选 — 允许对象级讨论不挂任务
//
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-collab
import { getPool, setCors } from "../db.js";

const SQL = `
-- ── threads ──
CREATE TABLE IF NOT EXISTS collaboration_threads (
  id                 VARCHAR(32) PRIMARY KEY,           -- 形如 th-xxxx
  task_id            VARCHAR(32),                       -- 可空；挂在任务上时填
  owner_object_type  VARCHAR(16) NOT NULL,              -- order | factory | document | logistics
  owner_object_id    VARCHAR(64) NOT NULL,
  owner_object_label VARCHAR(200),
  company_code       VARCHAR(64),                       -- tenant 过滤
  title              VARCHAR(200),
  status             VARCHAR(16) NOT NULL DEFAULT 'open',  -- open | closed
  created_by         VARCHAR(64),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  last_message_at    TIMESTAMPTZ DEFAULT NOW(),
  raw                JSONB DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collab_threads_owner_type_check') THEN
    ALTER TABLE collaboration_threads ADD CONSTRAINT collab_threads_owner_type_check
      CHECK (owner_object_type IN ('order', 'factory', 'document', 'logistics'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collab_threads_status_check') THEN
    ALTER TABLE collaboration_threads ADD CONSTRAINT collab_threads_status_check
      CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_collab_threads_task        ON collaboration_threads(task_id)          WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_threads_owner       ON collaboration_threads(owner_object_type, owner_object_id);
CREATE INDEX IF NOT EXISTS idx_collab_threads_company     ON collaboration_threads(company_code);
CREATE INDEX IF NOT EXISTS idx_collab_threads_last_msg    ON collaboration_threads(last_message_at DESC);

-- ── messages ──
CREATE TABLE IF NOT EXISTS collaboration_messages (
  id           VARCHAR(32) PRIMARY KEY,                 -- 形如 m-xxxx
  thread_id    VARCHAR(32) NOT NULL,
  author       VARCHAR(64),                             -- username
  author_role  VARCHAR(32),                             -- admin | sales | logistics | factory | system
  body         TEXT,
  kind         VARCHAR(16) NOT NULL DEFAULT 'text',     -- text | event | system
  event_type   VARCHAR(32),                             -- 当 kind='event' 时填，例: 'confirm_ready_date' / 'fill_container'
  raw          JSONB DEFAULT '{}'::jsonb,               -- 事件载荷，附件引用等
  created_at   TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT fk_collab_msg_thread
    FOREIGN KEY (thread_id) REFERENCES collaboration_threads(id) ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collab_msg_kind_check') THEN
    ALTER TABLE collaboration_messages ADD CONSTRAINT collab_msg_kind_check
      CHECK (kind IN ('text', 'event', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_collab_msg_thread     ON collaboration_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_collab_msg_created_at ON collaboration_messages(created_at DESC);

-- last_message_at 自动维护（触发器）
CREATE OR REPLACE FUNCTION trg_collab_msg_touch_thread()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE collaboration_threads
    SET last_message_at = NEW.created_at
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS collab_msg_touch_thread ON collaboration_messages;
CREATE TRIGGER collab_msg_touch_thread
  AFTER INSERT ON collaboration_messages
  FOR EACH ROW EXECUTE FUNCTION trg_collab_msg_touch_thread();
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ error: "POST or GET only" });

  try {
    const pool = getPool();
    await pool.query(SQL);
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM collaboration_threads)   AS threads,
        (SELECT COUNT(*) FROM collaboration_messages)  AS messages
    `);
    return res.status(200).json({
      success: true,
      message: "collab threads+messages ready (object-bound, no naked chat)",
      counts: counts.rows[0],
    });
  } catch (err) {
    console.error("[migrate-collab]", err);
    return res.status(500).json({ error: err.message });
  }
}
