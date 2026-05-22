# B 类批量导入模板 — 使用说明 (2026-05-23)

> 配套脚本: `scripts/safe-backfill-import.mjs`
> 第一铁律: **绝不破坏存量数据**。默认只填空字段、按唯一键 UPDATE、不 INSERT、不 DROP。

## 通用规则

1. **第一列 = 匹配键 (match key)**，必须是该表的唯一键，否则脚本拒绝运行。
2. **第二行是示例**，键值 `__EXAMPLE_DELETE_THIS_ROW__` 永不匹配，导入前请删除。
3. **空单元格 = 不动该列**。只有填了值的单元格才会写入。
4. **默认只填 DB 中为 NULL 的字段**；已有值的字段不覆盖（除非加 `--force-overwrite` 并经 Damon 确认）。
5. 列名必须精确匹配下表；出现允许列表以外的列，脚本拒绝运行（防误改敏感列如价格/company_code）。

---

## products_backfill_template.csv

匹配键: **`id`** (products.sku **不唯一**——同 SKU 有多个尺寸变体，最多 7 行；用 sku 匹配会一次改多行且 net_weight/cbm 因变体而异 → 危险，故默认禁用 sku 键)

| 列 | 必填 | 单位 / 格式 | 说明 |
|---|---|---|---|
| `id` | ★匹配键 | 整数 | products 表主键(唯一)。从数据管理台导出 |
| `factory_code` | 可选 | 文本 | 工厂代码(529条缺)；同 SKU 各变体通常相同 |
| `net_weight` | 可选 | kg, 三位小数 | **每箱净重**(294条缺)；按变体不同 |
| `gross_weight` | 可选 | kg, 三位小数 | **每箱毛重**(294条缺) |
| `cbm` | 可选 | m³, 三位小数 | **每箱体积**(230条缺) |
| `carton_qty` | 可选 | 整数 | 每箱件数(22条缺) |
| `box_l` / `box_w` / `box_h` | 可选 | cm, 一位小数 | 箱规尺寸(可推算 cbm) |
| `brand_authorization_no` | 可选 | 文本 | 品牌授权编号(027新列, 报关行查验) |
| `factory_registration_no` | 可选 | 文本 | 工厂出口备案号(027新列, 宠物食品合规) |
| `shelf_life_days` | 可选 | 整数(天) | 保质期(1条缺) |

### D2 已拍板: products 两条通道

| 字段 | 通道 | 模板 | 命令 |
|---|---|---|---|
| `net_weight` / `gross_weight` / `cbm` / `carton_qty` (变体级, 各尺寸不同) | **必须按 id** | `products_backfill_template.csv` | `--table products` (默认 id) |
| `factory_code` / `brand_authorization_no` / `factory_registration_no` (产品级, 各变体相同) | **可按 sku 批量** | `products_backfill_BY_SKU_template.csv` | `--table products --match-key sku --allow-multi` |
| box_l/box_w/box_h / shelf_life_days | 按 id | 主模板 | `--table products` |

> sku 通道脚本内置硬限制: 用 `--match-key sku` 时, CSV 只允许出现 factory_code/brand_authorization_no/factory_registration_no 三列; 出现变体级字段直接报错(防同 sku 多变体被填成同一净重)。

---

## orders_backfill_template.csv

匹配键: **`id`** (orders 主键, DB 有唯一索引)。
注: `order_no` 虽 96/96 值唯一, 但 DB **无唯一约束**, 脚本要求匹配键必须有真实唯一索引(防竞态/脏数据), 故用 `id`。`contract_no` 有 2 个重复值更不可作键。从数据管理台导出订单时带上 id 列。

| 列 | 必填 | 格式 | 说明 |
|---|---|---|---|
| `id` | ★匹配键 | 整数 | orders 主键(唯一索引) |
| `pi_no` | 可选 | 文本 | PI 编号(027新列, 与 contract_no 分离) |
| `sc_no` | 可选 | 文本 | SC 编号(027新列) |

---

## shipping_plans_backfill_template.csv

匹配键: **`id`** (唯一 259/259；`shipment_no` 67/259、`bl_no` 228/259 均**不唯一**(拼箱共用)，不可作键)

| 列 | 必填 | 单位 / 格式 | 说明 |
|---|---|---|---|
| `id` | ★匹配键 | 整数 | shipping_plans 主键(唯一) |
| `doc_cutoff` | 可选 | 日期 YYYY-MM-DD | 文件截止日(027新列) |
| `cargo_cutoff` | 可选 | 日期/时间戳 | 进箱截止(现 0/259 填充) |
| `booking_no` | 可选 | 文本 | 订舱号(现 1/259 填充) |
| `so_no` | 可选 | 文本 | Shipping Order 号 |
| `hbl_no` | 可选 | 文本 | House B/L 号(027新列) |
| `mbl_no` | 可选 | 文本 | Master B/L 号(027新列) |
| `vessel` | 可选 | 文本 | 船名(现 125/259) |
| `etd` | 可选 | 日期 YYYY-MM-DD | 预计开船(现 171/259) |
| `container_type` | 可选 | ISO 值 `20GP`/`40GP`/`40HQ`/`45HQ` | 用标准 ISO，勿用 `40hq`/`HC40` |

---

## 导入流程 (脚本)

```bash
# 1. dry-run (默认, 不写库): 打印将更新行数 + 各列填充前后对比
node scripts/safe-backfill-import.mjs --table products --file products_backfill.csv

# 2. Damon 看 dry-run 报告确认无误后, 真跑 (自动先备份受影响表):
node scripts/safe-backfill-import.mjs --table products --file products_backfill.csv --apply

# 可选开关:
#   --match-key <col>   覆盖默认匹配键 (仅限该表唯一键白名单)
#   --allow-multi       允许一个键匹配多行 (仅 products+sku 场景, 需 Damon 确认)
#   --force-overwrite   覆盖已有非空值 (默认只填空, 需 Damon 确认)
```
