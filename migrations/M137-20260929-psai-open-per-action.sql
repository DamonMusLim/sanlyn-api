-- 0929:店员核对卡同一件商品可能同时报「货位错」和「库存不对」→ 两条意图要能同时排队。
-- 原唯一约束按 product_code 一件只许一条未完成意图,第二条插不进(改货位/改库存互相卡死)。改成按 (product_code, action)。
DROP INDEX IF EXISTS ux_psai_open;
CREATE UNIQUE INDEX IF NOT EXISTS ux_psai_open ON petstore_shelf_action_intents (product_code, action)
  WHERE status IN ('proposed', 'approved', 'applying');
