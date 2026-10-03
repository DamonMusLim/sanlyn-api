-- M146 1004:任务前置依赖(借鉴 Paperclip ②,任务 HALL-20261003-76E691,Damon 1004 同意)。
-- task-writer /task/claim 只领 blocked_by 里全部 done/cancelled 的任务;/task/v2 开单可传 blocked_by。
-- 可重跑。回滚:先回退 task-writer 代码,再 ALTER TABLE public.tasks DROP COLUMN IF EXISTS blocked_by;(会丢依赖数据,先导出 id,blocked_by)
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS blocked_by text[] NOT NULL DEFAULT '{}'::text[];
