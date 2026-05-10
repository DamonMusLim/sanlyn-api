-- 2026-05-11 · P0-1 BL three-way isolation
-- Spec: docs/architecture/ORDER-CARD-JUMP-PERMISSION-REGISTRY-v3.2.md §8
--
-- Today shipping_plans has a single `bl_no` column. v3.2 requires three
-- independent BL fields with distinct role visibility:
--
--   bl_no      (= MBL / bl_master) → ocean_partner + internal_ops
--   bl_house   (= HBL)             → internal_ops + customer + import_broker
--   bl_customs (= 报关 BL)         → internal_ops + customs_broker
--
-- We KEEP `bl_no` as the MBL alias (no rename, no drop) to avoid breaking
-- minimax-booking + 30+ read paths during the transition. New columns are
-- additive and nullable.

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS bl_house   TEXT,
  ADD COLUMN IF NOT EXISTS bl_customs TEXT;

-- Documentation comments (helps future me / pgAdmin readers)
COMMENT ON COLUMN shipping_plans.bl_no
  IS 'MBL (Master B/L). Visible: internal_ops + ocean_partner. v3.2 §8.';
COMMENT ON COLUMN shipping_plans.bl_house
  IS 'HBL (House B/L). Visible: internal_ops + customer + import_broker. v3.2 §8.';
COMMENT ON COLUMN shipping_plans.bl_customs
  IS 'Customs B/L (报关提单). Visible: internal_ops + customs_broker. v3.2 §8.';

-- ── Prod migration steps (manual) ─────────────────────────────────
-- 1. SSH 111.229.242.13  (or psql via api.sanlyn.cn bastion)
-- 2. psql ... -f /opt/sanlyn-api/migrations/2026-05-11-bl-three-way.sql
-- 3. Verify: \d shipping_plans  → bl_house / bl_customs columns present
-- 4. No data backfill required (both new columns start NULL).
-- 5. pm2 restart sanlyn-api  (only if api code is also being deployed)
-- ──────────────────────────────────────────────────────────────────
