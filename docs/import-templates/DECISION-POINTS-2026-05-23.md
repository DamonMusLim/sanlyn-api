# B 类导入 · 待 Damon 拍板的决策点 (2026-05-23)

> 这些是导入工具/数据设计中需要 Damon 定夺的点，**不擅自决定**。

## D1 · shipping_plans 是否新增 `container_qty` 列?

- 现状: shipping_plans 无 container_qty 列。4 行 container_type 内嵌数量(`HC40,HC40,HC40`/`40HQ×2`/`20GP×3`/`2x40HC`)，027 未规范化(避免丢数量)。
- 选项 A: 新增 `container_qty` 列 → 这 4 行可规范化(type→ISO, 数量入新列)。
- 选项 B: 不加列, 保持 4 行原样, 人工维护。
- **影响导入模板**: 若加列, shipping_plans 模板增一列 container_qty。

## D2 · products 产品级字段是否允许用 sku 批量填?

- 现状: `products.sku` 不唯一(1256/1404, 同 SKU 最多 7 个尺寸变体)。脚本默认用 `id` 匹配(唯一)。
- **产品级字段**(各变体相同): `factory_code` / `brand_authorization_no` / `factory_registration_no`
  - 选项 A: 仍按 id 逐行填(精确, 但 529 条要逐行给 id)。
  - 选项 B: 允许 `--match-key sku --allow-multi` 一次填同 sku 全部变体行(省事, 但需确认这些字段确实变体间相同)。
- **变体级字段**(按变体不同): `net_weight` / `gross_weight` / `cbm` / `carton_qty` → **只能按 id**, 严禁 sku 批量。
- **请定**: 产品级字段是否走 sku+allow-multi 通道?

## D3 · orders 匹配键用 `id` 还是 `order_no`?

- 脚本要求匹配键必须有 DB 唯一索引(防竞态/脏数据)。`order_no` 值虽唯一(96/96)但**无唯一约束**, `id` 有(PK)。
- 现默认: `id`。
- 选项: (A) 维持 id; (B) 给 order_no 加唯一约束(需另起一个小 migration), 之后可用 order_no 匹配。
- **请定**: 是否要为 order_no 加唯一约束以便用更友好的键导入?

## D4 · 是否允许 `--force-overwrite` 覆盖已有非空值?

- 默认: 只填空(NULL/空串), 已有值不覆盖。
- 若某些字段 Damon 确认现有值是错的、要用新数据覆盖 → 需 `--force-overwrite --yes-overwrite` 双开关。
- **请定**: 本轮哪些字段(如有)需要覆盖? 默认全部只填空。

## D5 · 备份快照保留策略

- 每次 --apply 在 DB 内建一张 `_import_backup_<table>_<时间戳>_<随机>` 全表快照。
- 这些表会累积。**请定**: 确认导入稳定后多久清理(脚本回滚 SQL 末尾附 DROP 命令, 默认保留)。

---

*待 Damon 逐条回复后, 再据此调整模板/默认键, 然后才进入真实数据导入轮次。*
