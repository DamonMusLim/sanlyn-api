-- M054 · 补上没有工号的人
-- 0803 Damon：「还有员工号码」—— 一键录用建档的人工号是空的。
-- 规则 <店前缀><两位序号>：金枋 JF01…、巴匕 BB01…。
-- ⚠️ 已有的拼音式工号(emp-limq / emp-lincy…)**一律不动** —— 工号是给人记的，不能悄悄改。
WITH t AS (
  SELECT id,
         CASE company_code WHEN 'JINFANG' THEN 'JF' WHEN 'BABI' THEN 'BB' ELSE 'EM' END AS pfx,
         ROW_NUMBER() OVER (PARTITION BY company_code ORDER BY COALESCE(hire_date,created_at::date), id) AS n
    FROM hr_employees
   WHERE employee_code IS NULL OR employee_code = ''
)
UPDATE hr_employees e SET employee_code = t.pfx || LPAD(t.n::text, 2, '0')
  FROM t WHERE e.id = t.id;
