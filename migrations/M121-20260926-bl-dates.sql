-- 提单日登记表（Damon 0926「提单日让录提单流程自动带上」）
-- 提单识别接口（/api/bl-ocr）和录提单 skill 读到提单时，按提单号把装船日记在这里；应收到期日从这里起算。
-- 来源优先级 manual > skill > ocr，低的不覆盖高的（逻辑在 api/db/lib/bl-dates.js）。只加表、换视图，不改数据。幂等。
CREATE TABLE IF NOT EXISTS bl_dates (
  bl_no      text PRIMARY KEY,                 -- 提单号（大写去空格）
  bl_date    date NOT NULL,                    -- B/L 上的装船日（Shipped on Board；没有就用签发日）
  source     text NOT NULL CHECK (source IN ('ocr','skill','manual')),
  note       text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  history    jsonb NOT NULL DEFAULT '[]'::jsonb  -- 被覆盖前的旧值
);

-- 到期日起算点：订单上人工填的提单日 → 登记表里的提单日 → 实际开航 ATD → 计划开航 ETD（后两个是估算）
CREATE OR REPLACE VIEW v_ar_due AS
WITH sp AS (
  SELECT o.id AS order_id,
         COALESCE(p1.atd, p2.atd)::date AS atd,
         COALESCE(p1.etd, p2.etd)::date AS sp_etd,
         COALESCE(NULLIF(o.bl_no,''), p1.bl_no) AS bl_key
    FROM orders o
    LEFT JOIN shipping_plans p1 ON p1.id = o.shipping_plan_id
    LEFT JOIN LATERAL (SELECT atd, etd FROM shipping_plans x
                        WHERE o.shipping_plan_id IS NULL AND o.bl_no IS NOT NULL AND x.bl_no = o.bl_no
                        ORDER BY x.id DESC LIMIT 1) p2 ON true
)
SELECT o.id AS order_id, o.order_no, o.company_code, o.bl_no, o.currency,
       COALESCE(o.bl_date, bd.bl_date, sp.atd, sp.sp_etd, o.etd::date) AS anchor_date,
       CASE WHEN o.bl_date IS NOT NULL THEN 'bl_date'
            WHEN bd.bl_date IS NOT NULL THEN 'bl_date'
            WHEN sp.atd IS NOT NULL THEN 'atd'
            WHEN COALESCE(sp.sp_etd, o.etd::date) IS NOT NULL THEN 'etd'
            ELSE 'none' END AS anchor_source,
       COALESCE(NULLIF(o.payment_schedule->>'balance_days','')::int, o.payment_terms_days, 30) AS term_days,
       (NULLIF(o.payment_schedule->>'balance_days','') IS NULL AND o.payment_terms_days IS NULL) AS term_estimated,
       COALESCE(o.bl_date, bd.bl_date, sp.atd, sp.sp_etd, o.etd::date)
         + COALESCE(NULLIF(o.payment_schedule->>'balance_days','')::int, o.payment_terms_days, 30) AS due_date,
       r."应收未收" AS unpaid, r."已收_货款" AS received, r."销售额" AS sales, r."可信度" AS confidence
  FROM orders o
  JOIN sp ON sp.order_id = o.id
  LEFT JOIN bl_dates bd ON bd.bl_no = upper(regexp_replace(sp.bl_key, '\s+', '', 'g'))
  JOIN v_order_receivable r ON r.order_id = o.id
 WHERE COALESCE(o.status,'') NOT IN ('cancelled','void','voided','deleted');
