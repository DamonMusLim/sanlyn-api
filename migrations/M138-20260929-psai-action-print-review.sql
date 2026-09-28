-- M138-20260929-psai-action-print-review.sql
-- 0929 核对卡「只拍照片的错」闭环:意图表新增两个 action 值 ——
--   PRINT_LABEL 价签错→按果冻橙现价打纠错签 / NEED_REVIEW 条码·规格·包装·多批次错→老板报告待人看。
-- 现行 CHECK(petstore_shelf_action_intents_action_chk,线上为 LOWER/UP/DELETE/COPY/SET_STOCK/SET_SHELF/SET_PRICE/COLLECT_RIVAL)
-- 不放行新值,按原值列表 + 两个新值重建。
-- 幂等:DROP IF EXISTS 后再 ADD,重跑结果不变(同 M077 对 petstore_stocktake_reason_chk 的写法)。
ALTER TABLE petstore_shelf_action_intents
  DROP CONSTRAINT IF EXISTS petstore_shelf_action_intents_action_chk,
  ADD CONSTRAINT petstore_shelf_action_intents_action_chk
    CHECK (action IN (
      'LOWER','UP','DELETE','COPY','SET_STOCK','SET_SHELF','SET_PRICE','COLLECT_RIVAL',
      'PRINT_LABEL','NEED_REVIEW'
    ));
