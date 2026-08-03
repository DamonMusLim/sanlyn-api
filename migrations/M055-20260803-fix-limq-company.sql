-- M055 · 李美倩挂错公司了
-- 0803 Damon：「全是巴匕」。核对无误：
--   · 她的 store_id 一直是 'babi'
--   · 她唯一那次打卡（07-31）是在 BABI-OFFICE，store_code=BABI
--   · company_code 却写着 JINFANG —— 07-31 建档时填错，之后一路带着错
-- 影响：员工端有 company_code='JINFANG' 的门（routes-staff-portal 那道），
--       她本来就该看巴匕的东西，改回去才对。
UPDATE hr_employees SET company_code='BABI' WHERE id=31 AND name='李美倩';

-- 金枋店现在真正的人：汪卫云(JF02) + Damon测试(JF03)；陈杰荣(JF01)已离职。
COMMENT ON COLUMN hr_employees.company_code IS
  'BABI=厦门巴匕(外贸办公室) | JINFANG=宠爱我·金枋店。一张表装两家公司,靠这一列分,
   不另建第二套花名册。开新店在这里加值 + 后端 nextEmployeeCode 配工号前缀。';
