-- M013-20260704 修正在职员工归属主体:孤儿值 company_id='27' → 真实厦门巴匕 companies.id='37'
-- Damon 2026-07-04 批准（工资-医社保专题第①步）。
-- 背景：'27' 与 'co-babi' 均不指向 companies 表任何行（孤儿值）；厦门巴匕真实实体
--       = companies.id=37 (code=BABI, is_sanlyn_entity=t)。employees.company_id 为裸 varchar 无外键。
-- 幂等：WHERE company_id='27' 重跑影响0行；dry-run 已验证恰好命中5个 ACTIVE 员工、无其它行波及。
UPDATE employees
   SET company_id = '37',
       updated_at = now()
 WHERE company_id = '27';
