-- M114 · 修 M112 里 PR-BABI-2026-03 的 headcount：3 → 7
-- 依据：2026-04-16 那批银行实付 53,411.30 = 代发 37,411.30（5 人）+ 李一鸣 8,000 + 邱楚涵 8,000 = 7 人。
--   M112 (r5) 里 codex 自填了 3，属业务数据错误（不影响金额与闭环，金额 53,411.30 无误）。
-- Revert: 把 raw->'headcount' 改回 3、counterparty 改回 '工资批次·3人'。
-- 幂等：按固定值赋值，重跑结果相同。

SELECT 'M114_before' AS phase, record_no, amount, counterparty,
       raw->>'headcount' AS headcount, raw->>'composition' AS composition
  FROM finance_records
 WHERE record_no = 'PR-BABI-2026-03';

UPDATE finance_records
   SET raw = jsonb_set(raw, '{headcount}', '7'::jsonb, true),
       counterparty = '工资批次·7人',
       updated_at = now()
 WHERE record_no = 'PR-BABI-2026-03'
   AND created_by = 'payroll-m112';

SELECT 'M114_after' AS phase, record_no, amount, counterparty,
       raw->>'headcount' AS headcount, raw->>'composition' AS composition
  FROM finance_records
 WHERE record_no = 'PR-BABI-2026-03';

-- 顺带只读核对：六笔批次的 headcount 现状（拆不到人的仍为 null，是对的）
SELECT 'M114_check_all' AS phase, record_no, amount, counterparty, raw->>'headcount' AS headcount
  FROM finance_records
 WHERE created_by = 'payroll-m112'
 ORDER BY record_no;
