-- M140-20260929 boss_decisions:老板「待我处理」页后台的拍板留痕表
-- (api/db/hr-bossdesk.mjs 专用)
--   boss_decide_batch / boss_note / boss_assign 每作用一条 task 写一行;
--   prev 存操作前快照 {next_holder,next_action,damon_feedback},boss_undo 在 5 分钟窗口内按它整行回滚
--   (窗口由 hr-bossdesk.mjs 判,不进库约束;clerk 转派的 agenda 由代码置 cancelled)。
-- decision 列:text —— boss_decide_batch 存「同意/不同意」,boss_assign 存 to(clerk/nora/ada/claude)。
-- ⛔ 本文件只建表+索引,不改 tasks / hr_day_agenda 任何现有结构。

CREATE TABLE IF NOT EXISTS boss_decisions (
  id         bigserial primary key,
  batch_id   text not null,
  task_id    text not null,
  action     text not null,
  decision   text,
  note       text,
  prev       jsonb,
  created_at timestamptz default now(),
  undone_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_boss_decisions_batch_id   ON boss_decisions (batch_id);
CREATE INDEX IF NOT EXISTS idx_boss_decisions_created_at ON boss_decisions (created_at);
