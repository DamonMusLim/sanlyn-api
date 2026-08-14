-- M069: 货代账单 payer 防误归属清查 (M067/M068 已占用; 对应 brief 的 M067 规则)
-- 幂等: 只处理非 voided/absorbed、payer=BABI、且按 BL/link_plan_id 查无我方订单的账单行。

WITH target AS (
  SELECT b.id, b.bl_no
    FROM freight_supplier_bills b
   WHERE BTRIM(COALESCE(b.payer_company_code, '')) = 'BABI'
     AND COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
     AND NULLIF(BTRIM(b.bl_no), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM orders o
        WHERE o.deleted_at IS NULL
          AND (
            BTRIM(o.bl_no) = BTRIM(b.bl_no)
            OR (
              b.link_plan_id IS NOT NULL
              AND o.shipping_plan_id::text = b.link_plan_id::text
            )
          )
     )
),
updated AS (
  UPDATE freight_supplier_bills b
     SET payer_company_code = NULL,
         updated_at = now()
    FROM target t
   WHERE b.id = t.id
   RETURNING b.bl_no
),
inserted AS (
  INSERT INTO tasks (id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
  SELECT DISTINCT
         'payer-' || BTRIM(bl_no),
         '货代账单待归属',
         '货代账单待归属: 无我方订单却挂巴匕应付',
         'open',
         'payer-guard',
         'logistics',
         BTRIM(bl_no),
         now(),
         now()
    FROM updated
   WHERE NULLIF(BTRIM(bl_no), '') IS NOT NULL
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM updated) AS payer_cleared_count,
  (SELECT COUNT(*) FROM inserted) AS tasks_created_count;
