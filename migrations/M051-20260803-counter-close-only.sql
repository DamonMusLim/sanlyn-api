-- M051 · 「买单台面」只留闭店那条
-- 0803 Damon：「上班不用看台面吧？应该是下班。」—— 对，早上台面还没人用过，没什么好查的；
-- 一天下来单据、袋子、样品堆在那才是问题。
UPDATE hr_checklist_items SET is_active=false
 WHERE company_code='JINFANG' AND phase='open' AND title='买单台面清爽';
UPDATE hr_checklist_items SET seq=2
 WHERE company_code='JINFANG' AND phase='open' AND title='货架巡一遍';
