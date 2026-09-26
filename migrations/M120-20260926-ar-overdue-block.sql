-- 信保超期出运拦截（Damon 0926 定）—— 第一步：到期日按提单日算 + 每个买家的超期风险
-- 背景：信保 EC202601240 拒赔 =「买方上一票超过应付款日 30 天仍出运」。新条款：30% 定金 + 70% 提单日后 45 天。
-- ⛔ 现在是【影子模式】：只算、只提示，不拦任何操作；收款挂接补齐后（独立任务）再开硬拦。
-- 只加列、建视图，不改任何数据。幂等可重跑。

-- ① 提单日：B/L 上印的日期（装船日）= 尾款到期日的起算点。以前系统里没有这个字段（只有计划 ETD / 实际 ATD）。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bl_date date;
COMMENT ON COLUMN orders.bl_date IS '提单日（B/L 上的装船/签发日），应收尾款到期日的起算点；收到提单时填';

-- ② 每票的尾款到期日
--    起算点优先级：提单日 bl_date → 船实际开航 ATD → 计划开航 ETD（后两个标「估算」）
--    账期：订单 payment_schedule.balance_days → payment_terms_days → 默认 30（标「估算」）
CREATE OR REPLACE VIEW v_ar_due AS
WITH sp AS (
  SELECT o.id AS order_id,
         COALESCE(p1.atd, p2.atd)::date AS atd,
         COALESCE(p1.etd, p2.etd)::date AS sp_etd
    FROM orders o
    LEFT JOIN shipping_plans p1 ON p1.id = o.shipping_plan_id
    LEFT JOIN LATERAL (SELECT atd, etd FROM shipping_plans x
                        WHERE o.shipping_plan_id IS NULL AND o.bl_no IS NOT NULL AND x.bl_no = o.bl_no
                        ORDER BY x.id DESC LIMIT 1) p2 ON true
)
SELECT o.id AS order_id, o.order_no, o.company_code, o.bl_no, o.currency,
       COALESCE(o.bl_date, sp.atd, sp.sp_etd, o.etd::date) AS anchor_date,
       CASE WHEN o.bl_date IS NOT NULL THEN 'bl_date'
            WHEN sp.atd IS NOT NULL THEN 'atd'
            WHEN COALESCE(sp.sp_etd, o.etd::date) IS NOT NULL THEN 'etd'
            ELSE 'none' END AS anchor_source,
       COALESCE(NULLIF(o.payment_schedule->>'balance_days','')::int, o.payment_terms_days, 30) AS term_days,
       (NULLIF(o.payment_schedule->>'balance_days','') IS NULL AND o.payment_terms_days IS NULL) AS term_estimated,
       COALESCE(o.bl_date, sp.atd, sp.sp_etd, o.etd::date)
         + COALESCE(NULLIF(o.payment_schedule->>'balance_days','')::int, o.payment_terms_days, 30) AS due_date,
       r."应收未收" AS unpaid, r."已收_货款" AS received, r."销售额" AS sales, r."可信度" AS confidence
  FROM orders o
  JOIN sp ON sp.order_id = o.id
  JOIN v_order_receivable r ON r.order_id = o.id
 WHERE COALESCE(o.status,'') NOT IN ('cancelled','void','voided','deleted');

-- ③ 可信欠款：只有「查遍了确实没收到」(催收看板 A) 或「挂了水单但没收满」(C) 才算数；
--    B「钱可能到了没挂账」/ D「证据不足」和挂不上收款的，一律不拦，只进对账。
--    ⚠️ 催收看板 ar_chase_board 是快照表（不自动刷新），按 提单号 对到订单。
CREATE OR REPLACE VIEW v_ar_due_trusted AS
SELECT d.*,
       cb.grade AS chase_grade,
       (d.unpaid > 0 AND (cb.grade IN ('A','C') OR d.confidence = '部分收款')) AS trusted_unpaid,
       CASE WHEN d.unpaid > 0 AND d.due_date IS NOT NULL THEN CURRENT_DATE - d.due_date END AS days_past_due
  FROM v_ar_due d
  LEFT JOIN LATERAL (SELECT left(c."核查状态", 1) AS grade FROM ar_chase_board c
                      WHERE c."提单" = d.bl_no AND d.bl_no IS NOT NULL
                      ORDER BY c."欠款" DESC LIMIT 1) cb ON true;

-- ④ 每个买家（按法人 company_code，信保按买家算）的风险等级
--    block = 有可信欠款超过到期日 30 天（信保「已知风险后出运」线）
--    warn  = 有可信欠款已超期但未满 30 天，或 7 天内到期
--    check = 只有挂不上/证据不足的欠款（先对账，不拦）
CREATE OR REPLACE VIEW v_buyer_ar_risk AS
SELECT company_code,
       CASE WHEN bool_or(trusted_unpaid AND days_past_due > 30) THEN 'block'
            WHEN bool_or(trusted_unpaid AND days_past_due > -7) THEN 'warn'
            WHEN bool_or(unpaid > 0 AND NOT trusted_unpaid) THEN 'check'
            ELSE 'ok' END AS risk,
       max(days_past_due) FILTER (WHERE trusted_unpaid) AS max_days_past_due,
       count(*) FILTER (WHERE trusted_unpaid AND days_past_due > 30) AS n_block,
       sum(unpaid) FILTER (WHERE trusted_unpaid AND days_past_due > 30) AS amt_block,
       count(*) FILTER (WHERE unpaid > 0 AND NOT trusted_unpaid) AS n_unverified,
       sum(unpaid) FILTER (WHERE unpaid > 0 AND NOT trusted_unpaid) AS amt_unverified,
       count(*) FILTER (WHERE trusted_unpaid AND (anchor_source <> 'bl_date' OR term_estimated)) AS n_estimated_due
  FROM v_ar_due_trusted
 WHERE company_code IS NOT NULL
 GROUP BY company_code;
