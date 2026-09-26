-- M115 · 删除脏数据 finance_records / PR-co-babi-2026-05（Damon 2026-09-10 授权「删」）
--
-- 为什么是脏数据：
--   ① 金额 14,960.00 / headcount 1，源自 payroll_sheets 一张 status=CANCELLED 的测试单
--      （company_id='co-babi'、period 2026-05、gross 11000 / net 8030）
--   ② 真实 2026-05 期银行实付是 53,411.30（已由 M112 记为 PR-BABI-2026-05），两者不符
--   ③ record_no 里的 co-babi 是旧孤儿公司码（companies 表无此 code，正码为 BABI）
--   ④ paid_amount=0 但 status=pending，从未对应任何真实付款
--
-- ⚠️ Revert（完整原值，照此可原样恢复）：
-- INSERT INTO finance_records
--   (record_no, direction, category, status, currency, amount, paid_amount,
--    counterparty, counterparty_code, issuing_company, issuing_code,
--    shipment_no, contract_no, order_nos, invoice_no, due_date, paid_date,
--    raw, created_by, created_at, updated_at)
-- VALUES
--   ('PR-co-babi-2026-05','out','工资','pending','CNY',14960.00,0.00,
--    '1人·工资',NULL,'厦门巴匕进出口有限公司','BABI',
--    NULL,NULL,NULL,NULL,DATE '2026-05-28',NULL,
--    '{"net":8030.00,"gross":11000.00,"source":"payroll_sheets","headcount":1,
--      "bank_amount":0.00,"employer_contrib":3960.00,"personal_withhold":2970.00}'::jsonb,
--    'payroll-sync', TIMESTAMPTZ '2026-07-02 22:00:58.934+08', TIMESTAMPTZ '2026-07-02 22:00:58.934+08');
--   （原 id=14 由序列生成，恢复后 id 会变，其余字段一致）

SELECT 'M115_before' AS phase, id, record_no, amount, paid_amount, counterparty,
       issuing_code, created_by, raw
  FROM finance_records
 WHERE record_no = 'PR-co-babi-2026-05';

-- 只删这一条：三重条件锁定，⛔不许波及 payroll-m111 / payroll-m112 建的任何记录
DELETE FROM finance_records
 WHERE record_no = 'PR-co-babi-2026-05'
   AND created_by = 'payroll-sync'
   AND amount = 14960.00;

SELECT 'M115_after_target' AS phase, count(*) AS should_be_zero
  FROM finance_records
 WHERE record_no = 'PR-co-babi-2026-05';

-- 只读核对：本次工资相关记录应剩 8 条（M111 两笔 + M112 六笔），且无 co-babi 残留
SELECT 'M115_check' AS phase, created_by, count(*) AS rows, sum(amount) AS total
  FROM finance_records
 WHERE created_by IN ('payroll-m111','payroll-m112','payroll-sync')
 GROUP BY created_by
 ORDER BY created_by;

SELECT 'M115_check_no_orphan_code' AS phase, count(*) AS should_be_zero
  FROM finance_records
 WHERE record_no LIKE '%co-babi%';
