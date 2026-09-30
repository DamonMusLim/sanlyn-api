-- M144 0930 阿丹申请动作→Damon服务号同意→task-writer执行(action_requests)。见 ~/collab-work/action-approve
create table if not exists public.action_requests (
  id text primary key,
  kind text not null check (kind in ('mail_send', 'task_close')),
  params jsonb not null default '{}'::jsonb,
  summary text not null,
  requested_by text,
  source_session text,
  status text not null check (status in ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  approve_token_hash text not null unique,
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists action_requests_status_expires_idx
  on public.action_requests (status, expires_at);
