# 催票按【产品品牌】分类设计 v2（fable 手写 · codex 网络故障时）

## 0. 结论先行（作废 v1）
**v1（多税号/父子公司/两个开票主体）作废**——Damon 澄清：中宠是**一个公司、一个税号、一个开票主体**（VEN-ZC）。「品牌 vs OEM」不是开票主体，是**按产品品牌的管理分类**：
- **品牌** = 中宠自有品牌产品（WANPY 顽皮 / TRULY / JERKYTIME / TING TIME / SNIFFLY / DOGSOME / SOUPTIME …）
- **OEM** = 代工定制（无中宠自有品牌）

分类源头 = **`products.brand`（已存在）**。开票、退税、对账都用**同一个税号**，只是报表/催票按品牌分子组。

## 1. 已查事实
- `products` 有 `brand`、`display_brand`、`factory_code`、`factory_name`。
- 中宠(VEN-ZC)产品 brand 实测分布：WANPY 638 / TRULY 153 / JERKYTIME 106 / TING TIME 24 / SNIFFLY 15 / DOGSOME 15 / SOUPTIME 10 / 空 7。
- `tax-rebate-invoice-gap.js:36-46` 按 `o.contract_no, o.factory, o.factory_code` 聚合 `SUM(oli.factory_subtotal)`，**只连 orders+order_line_items，未连 products**，输出 `{factory, factory_code, due}`（`addFactory` L17-22 按 [factory,factory_code] 累加）。**没有品牌维度 = 根因**。
- 前端催票当前靠公司中文名硬猜品牌（"食品股份"→OEM/"股份"→品牌），**错**：公司名不代表产品品牌。

## 2. 自有品牌清单 + 判定规则（可维护，不硬编码）
- **判定**：`products.brand` 属于「该工厂自有品牌集」→ 品牌；`brand` 为空或不在自有集（客户品牌）→ OEM。
- **清单存哪**（建议）：新增轻量主数据 —— `company_own_brands(company_code, brand, brand_cn, active)`，或 `companies.raw.own_brands = [...]`。中宠 = {WANPY,TRULY,JERKYTIME,TING TIME,SNIFFLY,DOGSOME,SOUPTIME}。规则读表不写死，新增品牌加一行即可。
- 也可复用 `products.display_brand` 若它已表达"对外品牌归属"（需确认语义）。

## 3. 让催票带品牌（后端精确改点）
`tax-rebate-invoice-gap.js`：
- **L37-46 SQL**：加 `LEFT JOIN products p ON p.id = oli.product_id`（若 oli 无 product_id 则按 `oli.sku=p.sku` 关联），SELECT 加 `p.brand`，`GROUP BY` 加 `p.brand`。
- **L17-22 `addFactory`**：加 `brand` 入参，key 改 `[factory, factory_code, brand]`，输出对象加 `brand`。
- **契约兼容**：`invoice_gap_factories[]` 每条**加 `brand` 字段**（`{factory, factory_code, brand, due}`）。契约现有字段名不动（前端向后兼容）；`brand` 为新增可选字段。
- **分类派生**：后端可顺带给每条算 `is_own_brand`（查 own_brands 表），或前端算。建议后端给，规则集中。

## 4. 中宠公司归一（一个税号）
- `VEN-ZC` = 唯一有效中宠主体（税号唯一）。`zc-brand`、`zc-oem` 收敛：`merged_into_code=VEN-ZC`（zc-oem 已是），`zc-brand` 也设 `merged_into_code=VEN-ZC`（它现在是 null）。
- 订单侧：把 `orders.factory_code`/`factory_company_id` 里指向 zc-brand 的统一改成 VEN-ZC（品牌区分交给 product.brand，不再靠公司）。
- **注意**：这跟 v1「拆两个公司」相反——现在是**合成一个**。

## 5. 前端改动（催票）
- 去掉 `DEPT_MAP`/`NAME_DEPT` 公司名硬猜。
- 读 `invoice_gap_factories[].brand`（后端新加），中宠组内**按品牌分子组**：品牌组（各自有品牌可再分 WANPY/TRULY…）+ OEM 组。
- 部门 badge 改「品牌 badge」（品牌名）+ 「OEM」标。
- 等后端字段：`invoice_gap_factories[].brand`（+可选 `is_own_brand`）。

## 6. 迁移步骤（安全可回滚）
1. 建 `company_own_brands` 主数据 + 录中宠自有品牌集。
2. 改 `tax-rebate-invoice-gap.js` 加 products join + brand（灰度：先加字段不改前端）。
3. 前端读 brand 分子组，撤名字硬猜。
4. 数据：`zc-brand`→VEN-ZC 归一 + 订单 code 统一（备份+dry-run）。
回滚：每步独立；后端 brand 是新增字段，撤了前端回退名字兼容（不建议）。

## 7. 决策点（Damon 拍）
1. **自有品牌清单谁维护**：建 own_brands 表由谁录/更新（新品牌上市要加）。
2. **OEM 要不要再细分客户**（哪个客户的代工）：若要，OEM 组按客户再分（需订单带客户品牌/客户）。
3. **历史订单缺 brand 怎么补**：老 oli 没 product 关联或 product 无 brand 的，归 OEM 还是标"待补"。
4. **display_brand vs brand**：用哪个当归属真源（语义确认）。
5. **zc-brand 归一**：历史挂在 zc-brand 上的订单/发票要不要迁到 VEN-ZC。

## 8. 一句话
中宠一个公司一个税号；「品牌/OEM」是 `products.brand` 的产品维度分类；后端在 `tax-rebate-invoice-gap.js` 聚合时经 `order_line_items→products` 带出 `brand`，催票按 公司→品牌 分子组；自有品牌清单进 own_brands 主数据可维护；前端撤掉公司名硬猜。
