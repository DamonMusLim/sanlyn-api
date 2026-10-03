-- v2026.10.04-1. Apply through deploy-sanlyn-api only. No task data modified.
CREATE TABLE IF NOT EXISTS public.task_weekly_sweep (
  id text PRIMARY KEY,
  sweep_week date NOT NULL,
  task_id text NOT NULL REFERENCES public.tasks(id),
  domain text,
  title text,
  recommendation text NOT NULL CHECK (recommendation IN ('merge','cancel','continue')),
  target_id text REFERENCES public.tasks(id),
  reason text NOT NULL,
  last_event_at timestamptz,
  snapshot jsonb NOT NULL,
  target_snapshot jsonb,
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','approved','rejected','applied','stale')),
  batch_id text,
  approved_by text,
  decision_note text,
  decided_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((recommendation = 'merge') = (target_id IS NOT NULL)),
  CHECK (target_id IS NULL OR target_id <> task_id)
);
CREATE INDEX IF NOT EXISTS task_weekly_sweep_state_idx
  ON public.task_weekly_sweep(state, sweep_week, task_id);
CREATE INDEX IF NOT EXISTS task_weekly_sweep_batch_idx
  ON public.task_weekly_sweep(batch_id);
