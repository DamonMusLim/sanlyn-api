-- AI 工作能力环 MVP · v2026.10.04-2
-- Generated: 2026-10-04; production data cutoff is supplied by the live snapshot.
-- Draft only. Apply before task-writer, then HUB-0059 in observe mode.
-- Deliberately no historical timestamp backfill: unknown progress remains NULL.
BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS stuck_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stuck_since timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_from text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass AND conname = 'tasks_workloop_stuck_level_check') THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_workloop_stuck_level_check
      CHECK (stuck_level BETWEEN 0 AND 2);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_workloop_active_idx
  ON public.tasks (stuck_level, last_progress_at)
  WHERE status IN ('open', 'doing', 'pending_review');
CREATE INDEX IF NOT EXISTS tasks_workloop_origin_idx
  ON public.tasks (escalated_from) WHERE escalated_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_events_workloop_lookup_idx
  ON public.task_events (task_id, event_type, created_at DESC);

COMMENT ON COLUMN public.tasks.last_progress_at IS
  'Latest substantive settled event; bulk events, wording edits and suspected padding excluded. NULL means unknown.';
COMMENT ON COLUMN public.tasks.stuck_level IS 'Workloop observation: 0 clear, 1 yellow, 2 red. Not approval.';
COMMENT ON COLUMN public.tasks.stuck_since IS 'Start of current stuck episode, not each polling timestamp.';
COMMENT ON COLUMN public.tasks.escalated_from IS 'Repair/reminder source task id; original task remains intact.';

-- Defense in depth for writers outside task-writer. Existing historical done rows
-- are not rewritten or rejected by this migration. Application returns HTTP 400
-- before this trigger; direct SQL writers receive SQLSTATE 23514.
CREATE OR REPLACE FUNCTION public.workloop_require_done_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE card jsonb;
BEGIN
  IF NEW.status <> 'done' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'done' THEN RETURN NEW; END IF;
  END IF;
  IF COALESCE(NEW.result_summary, '') ~*
    '(https?://[^[:space:]]+|(^|[[:space:]])/[^[:space:]]+|(^|[^A-Za-z0-9_])(commit|sha256|md5|task|event|订单|单据)[:=#： ]+[A-Za-z0-9_-]{3,}|(^|[^A-Za-z0-9_])[0-9a-f]{40}([^A-Za-z0-9_]|$))' THEN
    RETURN NEW;
  END IF;
  SELECT metadata INTO card FROM public.task_events
    WHERE task_id = NEW.id AND event_type = 'progress_card'
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(card->'done') = 'array' THEN card->'done' ELSE '[]'::jsonb END) AS d
    WHERE jsonb_typeof(d->'evidence') = 'string' AND btrim(d->>'evidence') <> '') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'done requires progress_card.done[].evidence or a traceable reference in result_summary'
    USING ERRCODE = '23514', CONSTRAINT = 'tasks_done_evidence_required';
END $$;

-- Trigger NOT installed in observe phase (Damon 1004: observe only logs, never blocks).
-- Enforce later in a separate migration: CREATE TRIGGER tasks_workloop_done_evidence
--   BEFORE INSERT OR UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.workloop_require_done_evidence();

COMMIT;
