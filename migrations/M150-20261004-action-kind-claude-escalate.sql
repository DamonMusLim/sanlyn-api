-- [1004] action_requests 允许新动作 claude_escalate(升 Claude 逐单批准,Damon 定 1A)
-- 可重跑:先删同名约束再按新白名单加回
ALTER TABLE public.action_requests DROP CONSTRAINT IF EXISTS action_requests_kind_check;
ALTER TABLE public.action_requests ADD CONSTRAINT action_requests_kind_check
  CHECK (kind IN (mail_send, task_close, claude_escalate));
