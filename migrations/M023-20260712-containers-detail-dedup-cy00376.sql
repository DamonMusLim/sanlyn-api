-- M023-20260712: CY00376 柜子 4→8 虚增修复 + 同模式全表清壳(幂等)
-- 病因: 订舱时按 container_qty 存了 N 个 {container_type} 占位壳,
--       录真柜的调用方把带 container_no 的真柜条目追加在壳后面,
--       containers_detail 数组长度翻倍,UI 显示柜数虚增。
-- 规则: 仅处理「真柜数(带 container_no) = container_qty 且仍残留壳」的行,
--       删掉全部壳、保留真柜原顺序。真柜不足 qty 的行不动(壳还有占位意义)。
-- 验证(修完应为 0 行):
--   SELECT id, shipment_no FROM shipping_plans
--   WHERE deleted_at IS NULL AND jsonb_typeof(containers_detail::jsonb)='array'
--     AND (SELECT count(*) FROM jsonb_array_elements(containers_detail::jsonb) e
--          WHERE COALESCE(e->>'container_no','')<>'') = container_qty
--     AND (SELECT count(*) FROM jsonb_array_elements(containers_detail::jsonb) e
--          WHERE COALESCE(e->>'container_no','')='') > 0;
-- 截至 2026-07-12 仅命中 1 行: id=416 / CY00376 (4 壳 + 4 真柜 → 4 真柜)。

UPDATE shipping_plans sp
SET containers_detail = (
      SELECT jsonb_agg(t.e ORDER BY t.ord)
      FROM jsonb_array_elements(sp.containers_detail::jsonb) WITH ORDINALITY t(e, ord)
      WHERE COALESCE(t.e->>'container_no','') <> ''
    ),
    updated_at = now()
WHERE sp.deleted_at IS NULL
  AND sp.containers_detail IS NOT NULL
  AND jsonb_typeof(sp.containers_detail::jsonb) = 'array'
  AND (SELECT count(*) FROM jsonb_array_elements(sp.containers_detail::jsonb) e
       WHERE COALESCE(e->>'container_no','') <> '') = COALESCE(sp.container_qty, -1)
  AND (SELECT count(*) FROM jsonb_array_elements(sp.containers_detail::jsonb) e
       WHERE COALESCE(e->>'container_no','') = '') > 0;
