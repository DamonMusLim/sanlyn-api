-- M049 · 点检清单砍到只剩「卫生 + 货架整齐」
--
-- 0802 Damon：「目前就卫生，以及货架的整齐。」
-- 之前那 6+6 条是我按一般宠物店铺开的，超出他现在实际要管的范围。
-- 停用的条目**没有删**（is_active=false），哪天要加回来把标志翻回 true 就行。

UPDATE hr_checklist_items SET is_active=false WHERE company_code='JINFANG';

-- 上班先做（2条）
INSERT INTO hr_checklist_items (company_code, phase, seq, title, hint, need_photo, is_active) VALUES
 ('JINFANG','open' ,1,'卫生过一眼','昨晚闭店干不干净：地面、笼具、洗护间。没做干净的拍一张', true , true),
 ('JINFANG','open' ,2,'货架巡一遍','歪的扶正、乱的归位、空的记下来',                       true , true),
-- 走之前做（2条）
 ('JINFANG','close',1,'卫生做完','地面拖一遍、笼具清一遍、垃圾清出去',                     true , true),
 ('JINFANG','close',2,'货架归位','白天翻乱的扶正归位，价签对得上',                         false, true)
ON CONFLICT DO NOTHING;

-- 万一重复插入过同名条目，只留一条
UPDATE hr_checklist_items i SET is_active=false
 WHERE company_code='JINFANG' AND is_active=true
   AND id > (SELECT min(j.id) FROM hr_checklist_items j
              WHERE j.company_code=i.company_code AND j.phase=i.phase AND j.title=i.title
                AND j.is_active=true);
