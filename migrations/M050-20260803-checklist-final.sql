-- M050 · 卫生放白天、晚上只清垃圾；加「买单台面」
--
-- 0803 Damon 拍板：
--   ①「白天做卫生，也不用深度」—— 他最早的直觉就是「一上班就看到整理」，是对的。
--      两班制是我提的、他当时同意，但实际上他只有一个人上到 22:00，
--      再让人做深度卫生 = 22:30 才走，而下班不打卡，那段时间既没记录也没工资。
--      → 卫生挪到开门前做（12:00 开门，11:30 到店），开门时店是干净的，客人第一眼就看到。
--   ②「垃圾晚上清」—— 宠物店的垃圾（猫砂/粮渣/湿粮罐）过夜招虫招味，这条没得选。
--   ③「检查买单台面重要」—— 客人第一眼和最后一眼都在这，也是钱在的地方。
--
-- 📷 的用意：Damon 是甩手掌柜，人不在店里。每天三张照片 = 他在外面就知道店里什么样。

UPDATE hr_checklist_items SET is_active=false WHERE company_code='JINFANG';

INSERT INTO hr_checklist_items (company_code, phase, seq, title, hint, need_photo, is_active) VALUES
 -- 上班先做：开门前把店收拾出来
 ('JINFANG','open' ,1,'卫生过一眼','地面、笼具、洗护间。不用深度做，脏的擦掉、乱的收起来', true , true),
 ('JINFANG','open' ,2,'买单台面清爽','台面不留杂物，收银机/扫码枪/袋子归位',                true , true),
 ('JINFANG','open' ,3,'货架巡一遍','歪的扶正、乱的归位、空的记下来',                        true , true),
 -- 走之前做：只留必须晚上做的
 ('JINFANG','close',1,'垃圾清出去','猫砂、粮渣、湿粮罐过夜招虫招味，当天的当天清',          true , true),
 ('JINFANG','close',2,'买单台面收干净','台面清空、单据收好、袋子补上',                      true , true),
 ('JINFANG','close',3,'货架归位','白天翻乱的扶正，价签对得上',                              false, true)
ON CONFLICT DO NOTHING;

-- 同名条目只留一条（防重复插入）
UPDATE hr_checklist_items i SET is_active=false
 WHERE company_code='JINFANG' AND is_active=true
   AND id > (SELECT min(j.id) FROM hr_checklist_items j
              WHERE j.company_code=i.company_code AND j.phase=i.phase AND j.title=i.title
                AND j.is_active=true);
