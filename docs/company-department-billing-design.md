# 公司多部门独立开票主体建模设计

## 0. 结论先行

推荐采用方案 A：在 `companies` 上保留“一个开票主体一行”，新增父子关系和部门属性，例如 `parent_company_code`、`department_code`、`department_name`、`billing_entity_type`。原因是现有订单、进项票、账单、对账已经大量用 `company_code` 或 `companies.id/code` 做主体口径，独立表会带来跨表重映射和双主键风险。

中宠应表达为同一集团下两个有效开票主体：

| 角色 | company code | 公司名 | 开票税号 | 父公司/集团 | 状态 |
| --- | --- | --- | --- | --- | --- |
| OEM 部门开票主体 | `VEN-ZC` | 烟台中宠食品股份有限公司 | 使用该主体真实税号 | 中宠集团 | 有效 |
| 品牌部门开票主体 | `zc-brand` | 烟台中宠股份有限公司 | 使用该主体真实税号 | 中宠集团 | 有效 |
| 历史旧码 | `zc-oem` | 烟台中宠食品股份有限公司 | 历史值保留 | 指向 `VEN-ZC` | 已合并/只做别名 |

核心修复点不是前端按中文名硬分，而是让订单及产品行能指向正确的开票主体 code。`tax-rebate` 的 `invoice_gap_factories` 当前按 `orders.factory_code` 聚合；只要品牌和 OEM 订单都写成 `VEN-ZC`，后续催票、上传进项票、对账都会串主体。

## 1. 已确认现状

### 1.1 `companies` 表结构口径

代码自建表见 [api/db/companies.js](/home/damon/canonical/sanlyn-api/api/db/companies.js:10)：

- 主键：`id SERIAL PRIMARY KEY`。
- 业务编码：`code VARCHAR(16) UNIQUE NOT NULL`。
- 名称：`name_en`、`name_cn`。
- 类型：`type VARCHAR(32) DEFAULT 'operating'`。
- 税号：`tax_id VARCHAR(128)`。
- 其它：`country`、`registration_no`、`bank_accounts`、`address`、`stamps`、`default_seller`、`notes`、时间戳。
- 迁移补列只补 `country/registration_no/bank_accounts/stamps/default_seller/notes`，没有 `parent_company_code`、`department`、`group_code` 等父子部门字段，见 [api/db/companies.js](/home/damon/canonical/sanlyn-api/api/db/companies.js:29)。
- `merged_into_code` 是后续治理补列，见 [migrations/M005-20260628-entity-resolution-cost-adopt.sql](/home/damon/canonical/sanlyn-api/migrations/M005-20260628-entity-resolution-cost-adopt.sql:40)。

仓库里已有 `company-departments` 接口，但它操作的是 `customers` 表的集团/部门模型，不是供应商 `companies` 模型，见 [api/db/company-departments.js](/home/damon/canonical/sanlyn-api/api/db/company-departments.js:33)。不能直接解决中宠供应商侧多开票主体。

### 1.2 中宠当前数据事实

按已查事实直接采用：

- `companies.id=44 code=VEN-ZC name="烟台中宠食品股份有限公司" type=factory merged_into_code=null`，当前 OEM 主体。
- `companies.id=1 code=zc-brand name="烟台中宠股份有限公司" type=null merged_into_code=null`，当前品牌主体，但未标类型、未纳入父子关系。
- `companies.id=2 code=zc-oem name="烟台中宠食品股份有限公司" merged_into_code=VEN-ZC`，历史旧码，已合并进 `VEN-ZC`。
- `tax-rebate` 接口的 `invoice_gap_factories` 中，品牌和 OEM 两个不同中文名行的 `factory_code` 都是 `VEN-ZC`，导致代码无法区分部门。

历史合并脚本明确把 `zc-oem` 合并到 `VEN-ZC`，并说明曾迁移 `orders.factory_code` 和 `products.factory_code` 引用，见 [migrations/data/D20260628-data-fixes.sql](/home/damon/canonical/sanlyn-api/migrations/data/D20260628-data-fixes.sql:5)。

## 2. 当前关键链路

### 2.1 催票/退税 invoice gap

`tax-rebate.js` 月度主查询把报关退税 `finance_export_rebates` 通过 `contract_no` 连到 `orders`，再连 `order_line_items/products/companies`。工厂名称使用 `COALESCE(comp.name_cn, comp_o.name_cn, p.factory_code, o.factory_code)`，见 [api/db/tax-rebate.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate.js:190) 到 [api/db/tax-rebate.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate.js:211)。

真正计算 `invoice_gap_factories` 的逻辑在 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:25)：

- 先从 `ferRows.contract_no` 拆合同号，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:6)。
- 应开金额按 `orders.contract_no, orders.factory, orders.factory_code` 聚合，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:36) 到 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:46)。
- 输出对象只有 `{ factory, factory_code, due }`，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:17)。
- 已收票金额从 `finance_invoices_in.contract_nos/customs_nos` 匹配，不按税号分主体，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:55) 到 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:68)。

根因定位：`invoice_gap_factories` 本身没有部门维度，只信任 `orders.factory_code`。如果品牌部门订单在 `orders.factory_code` 或产品行 `products.factory_code` 中被合并/回填为 `VEN-ZC`，聚合时已经没有可恢复的主体 code。中文名还能不同，说明 `orders.factory` 或历史名称字段保留了“股份/食品”的字符串，但 code 层已经塌缩。

### 2.2 工厂开票申请门户

`invoice-portal.js` 生成开票申请时通过 `orders.factory_company_id` 关联 `companies.id` 获取工厂名称和税号，见 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:56) 到 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:63)。

门户返回：

- `factory.name = companies.name_cn`
- `factory.tax_id = companies.tax_id`
- `buyer.tax_id = buyer companies.tax_id`，无值时兜底巴匕税号，见 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:81) 到 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:85)。

发票上传写入 `finance_invoices_in` 时同样依赖 `orders.factory_company_id -> companies`，写 `seller_name`、`seller_tax_id`、`seller_company_code`、`factory_id`、`contract_nos`，见 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:93) 到 [api/db/invoice-portal.js](/home/damon/canonical/sanlyn-api/api/db/invoice-portal.js:111)。

这说明：如果订单的 `factory_company_id` 指向品牌主体，开票申请税号可以正确；如果只改 `factory_code` 不改 `factory_company_id`，门户仍可能拿错税号。

### 2.3 进项票、销项票、账单、对账字段

进项票上传公共函数写 `finance_invoices_in.seller_name/seller_tax_id/seller_company_code/buyer_company_code/contract_nos/customs_nos`，见 [api/db/factory-invoice-upload.js](/home/damon/canonical/sanlyn-api/api/db/factory-invoice-upload.js:106) 到 [api/db/factory-invoice-upload.js](/home/damon/canonical/sanlyn-api/api/db/factory-invoice-upload.js:147)。

工厂进项票对账按 `seller_company_code = g.factory_code` 匹配，见 [api/db/factory-invoice-reconcile.js](/home/damon/canonical/sanlyn-api/api/db/factory-invoice-reconcile.js:230) 到 [api/db/factory-invoice-reconcile.js](/home/damon/canonical/sanlyn-api/api/db/factory-invoice-reconcile.js:285)。所以品牌/OEM 若同 code，会把进项票归入同一工厂对账池。

销项票 `finance_invoices_out` 在对账配置中使用 `seller_company_code` 和 `contract_nos`，见 [api/db/recon/configs/ar_customer.json](/home/damon/canonical/sanlyn-api/api/db/recon/configs/ar_customer.json:15)。这说明销项票也应继续绑定具体开票主体，而不是只绑定集团。

货代/账单侧 `freight_supplier_bills` 初始表包含 `supplier`、`amount`、`currency` 等字段，见 [api/db/migrate-freight.js](/home/damon/canonical/sanlyn-api/api/db/migrate-freight.js:43)。后续账单中心已经新增并使用 `supplier_company_code`、`payer_company_code`，查询按 `supplier_company_code` 做供应商口径过滤，见 [api/db/freight-supplier-bills.js](/home/damon/canonical/sanlyn-api/api/db/freight-supplier-bills.js:149) 到 [api/db/freight-supplier-bills.js](/home/damon/canonical/sanlyn-api/api/db/freight-supplier-bills.js:154)，付款/应收索引见 [migrations/M006-20260629-bill-center-two-sided-payment.sql](/home/damon/canonical/sanlyn-api/migrations/M006-20260629-bill-center-two-sided-payment.sql:20)。

### 2.4 订单工厂归属

后台创建订单强制要求 `factory_code`，并写入 `orders.factory_code`，见 [api/db/orders.js](/home/damon/canonical/sanlyn-api/api/db/orders.js:292) 到 [api/db/orders.js](/home/damon/canonical/sanlyn-api/api/db/orders.js:348)。

订单列表按 `orders.factory_code` 左联 `companies.code`，见 [api/db/orders.js](/home/damon/canonical/sanlyn-api/api/db/orders.js:747)。客户自助下单 V3 把 `body.factory_code` 适配进 legacy `factory`，再生成 `factoryCodeForCol` 写订单列，见 [api/db/order-create-v2.js](/home/damon/canonical/sanlyn-api/api/db/order-create-v2.js:797) 到 [api/db/order-create-v2.js](/home/damon/canonical/sanlyn-api/api/db/order-create-v2.js:892)。

因此目标状态必须是：订单的 `factory_code` 与 `factory_company_id` 都指向同一个“开票主体公司行”。只修其中一个会继续在某些页面串账。

## 3. 建模方案对比

### 方案 A：`companies` 自引用父公司 + 部门字段，部门也是 company 行

建议字段：

- `parent_company_code text null references companies(code)`：集团/父公司。为空表示集团根或独立公司。
- `department_code text null`：如 `brand`、`oem`。
- `department_name text null`：如“品牌部门”“OEM部门”。
- `billing_entity_type text not null default 'legal_entity'`：可取 `group_root`、`billing_department`、`legal_entity`、`alias`。
- 可选 `is_billing_entity boolean default true`：能否作为开票主体。

数据原则：

- 每个能独立开票、独立账单、独立对账的主体必须是一条 `companies` 行，并有自己的 `code/name_cn/tax_id`。
- 父公司只表达集团归属和展示汇总，不参与订单/发票/账单明细，除非 Damon 决定父公司本身也能开票。
- `merged_into_code` 只表示历史旧码重定向，不能用于表达部门归属。

催票如何分：`invoice_gap_factories` 聚合维度仍用 `billing_company_code = orders.factory_code` 或更稳的 `orders.factory_company_id -> companies.code`，但输出同时带 `parent_company_code/department_code/tax_id`。品牌和 OEM 因 code 不同天然分开。

开票税号如何取：开票申请继续从 `orders.factory_company_id -> companies.tax_id` 取；若缺 `factory_company_id`，按 `orders.factory_code -> companies` 补齐。父公司税号不参与部门发票。

退税/对账如何不串：`finance_invoices_in.seller_company_code`、`factory_invoice_reconcile.g.factory_code`、`freight_supplier_bills.supplier_company_code/payer_company_code` 均存具体部门主体 code。集团汇总只做上卷查询。

优点：

- 最贴合现有代码，改动小。
- `companies.tax_id` 已存在，天然承载开票主体。
- `orders.factory_code`、`finance_invoices_in.seller_company_code`、`freight_supplier_bills.*_company_code` 都能继续用 company code。
- 可逐步迁移，历史旧码可通过 `merged_into_code` 保持兼容。

缺点：

- 父公司也是 `companies` 行，会和“可开票主体”混在同一表，需要 `billing_entity_type/is_billing_entity` 明确语义。
- 需要治理所有引用：同一业务不要有时用 `factory_code`、有时用 `factory_company_id` 指到不同主体。

推荐：采用。

### 方案 B：新增 `company_departments` 表，部门带税号

结构示例：

- `company_departments(id, company_code, department_code, department_name, tax_id, billing_name, is_billing_entity)`
- 订单、发票、账单新增 `billing_department_id` 或 `billing_department_code`。

催票如何分：`invoice_gap_factories` 必须从订单或产品行拿 `billing_department_id`，不能只拿 `factory_code`。否则仍会塌缩到公司。

开票税号如何取：门户需要从 `orders.billing_department_id -> company_departments.tax_id` 取，而不是 `companies.tax_id`。

退税/对账如何不串：`finance_invoices_in`、`finance_invoices_out`、`freight_supplier_bills` 都要新增部门引用，或者把现有 `seller_company_code` 升级为“公司+部门复合键”。

优点：

- 语义最纯粹，父公司和部门实体分表。
- 可表达“部门不是法人但有内部核算口径”的场景。

缺点：

- 与现有系统大量 `company_code` 口径冲突。
- 订单、发票、账单、权限、门户、对账都要加新外键，迁移面大。
- 如果部门实际就是独立开票主体，`companies.tax_id` 会被绕开，形成双模型。

不推荐作为当前主方案。它适合未来需要非常复杂组织架构、且愿意重构所有主体引用时再做。

### 方案 C：保留一个公司 code，用 `tax_id/name` 或中文名规则区分

做法是继续让 `VEN-ZC` 表示中宠，催票/开票时按 `orders.factory` 中文名、`finance_invoices_in.seller_name` 或税号判断品牌/OEM。

催票如何分：前端或 SQL 按名称包含“食品/股份”硬分。

开票税号如何取：需要在代码里针对 `VEN-ZC` 特判不同税号。

退税/对账如何不串：依赖文本匹配，无法稳定保证。

优点：短期不改结构。

缺点：

- 当前问题正是这个方案造成的。
- 名称变体、简称、OCR 识别、历史发票都会导致误分。
- `seller_company_code` 相同，对账池必然混在一起。

不推荐，仅可作为临时补丁。

## 4. 中宠目标数据形态

### 4.1 推荐目标

新增或规范字段后，中宠应为：

| id | code | name_cn | type | tax_id | parent_company_code | department_code | department_name | billing_entity_type | merged_into_code |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 可新建 | `ZC-GROUP` | 中宠集团 | `group` 或 `holding` | 空或集团税号 | null | null | null | `group_root` | null |
| 44 | `VEN-ZC` | 烟台中宠食品股份有限公司 | `factory` | OEM 主体税号 | `ZC-GROUP` | `oem` | OEM部门 | `billing_department` | null |
| 1 | `zc-brand` | 烟台中宠股份有限公司 | `factory` 或 `trade_factory` | 品牌主体税号 | `ZC-GROUP` | `brand` | 品牌部门 | `billing_department` | null |
| 2 | `zc-oem` | 烟台中宠食品股份有限公司 | `factory` | 可保留历史值 | `ZC-GROUP` 或 null | `oem` 或 null | 历史OEM旧码 | `alias` | `VEN-ZC` |

说明：

- `zc-brand` 不应合并进 `VEN-ZC`。它是独立开票主体，不是重复公司。
- `zc-oem` 已经是旧码，应继续作为别名/历史引用，不再承接新订单、新发票、新账单。
- 父公司 `ZC-GROUP` 的 code 仅作建议，实际 code 需要 Damon 决定。若不想新建父公司行，可让两个主体 `parent_company_code = 'ZC-GROUP'` 先为空，但这会少一个集团汇总锚点。
- `type` 建议先沿用现有可接受值，不强行引入新枚举；语义放在 `billing_entity_type`。

### 4.2 中宠订单目标

新增订单：

- 品牌部门订单：`orders.factory_code = 'zc-brand'`，`orders.factory_company_id = companies.id(zc-brand)`，产品行/产品主数据若能确定品牌主体，也应写 `products.factory_code = 'zc-brand'`。
- OEM 部门订单：`orders.factory_code = 'VEN-ZC'`，`orders.factory_company_id = 44`。

历史订单：

- 需要按业务证据分批回填。不能只按中文名一次性全量改，因为合同、发票、报关、产品主数据可能存在混用。
- 最小安全口径：先只回填仍未开票、未对账、未完成退税的活跃订单；历史已完成单据保持原 code，并用只读映射或审计说明解释。

## 5. `factory_code` 冲突根因与改法

### 5.1 根因

根因不是 `tax-rebate.js` 前端展示，而是订单/产品主体 code 已经不足以表达品牌和 OEM：

1. 历史数据治理把 `zc-oem` 合并到 `VEN-ZC`，并迁移过 `orders.factory_code`、`products.factory_code`，见 [migrations/data/D20260628-data-fixes.sql](/home/damon/canonical/sanlyn-api/migrations/data/D20260628-data-fixes.sql:5)。
2. `invoice_gap_factories` 从 `orders.factory_code` 聚合，不读取 `companies.tax_id`、不读取部门字段，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:36)。
3. 当前输出只包含 `factory/factory_code/due`，没有 `company_id/tax_id/parent_company_code/department_code`，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:17)。
4. 已收票匹配也只按合同/报关号累加金额，未要求 `seller_company_code` 等于当前工厂主体，见 [api/db/tax-rebate-invoice-gap.js](/home/damon/canonical/sanlyn-api/api/db/tax-rebate-invoice-gap.js:90)。这会进一步放大串票风险。

### 5.2 后端改法

建议分两层修。

第一层：修源头数据和订单归属。

- 建单/选工厂 UI 必须让用户选择具体开票主体 code：品牌选 `zc-brand`，OEM 选 `VEN-ZC`。
- `orders.factory_code`、`orders.factory_company_id` 必须一致。
- 产品主数据 `products.factory_code` 若用于自动带出工厂，也必须保留品牌/OEM主体区别。
- 禁止把 `zc-brand` 通过 `merged_into_code` 归并到 `VEN-ZC`。

第二层：修 `loadInvoiceGapByCustoms` 聚合。

目标 SQL 应优先使用 `orders.factory_company_id` 对应的 `companies.code`，再回退 `orders.factory_code`，并带出税号和部门字段：

```sql
SELECT
  o.contract_no,
  COALESCE(c_id.code, o.factory_code) AS billing_company_code,
  COALESCE(c_id.name_cn, c_code.name_cn, o.factory) AS billing_company_name,
  COALESCE(c_id.tax_id, c_code.tax_id) AS billing_tax_id,
  COALESCE(c_id.parent_company_code, c_code.parent_company_code) AS parent_company_code,
  COALESCE(c_id.department_code, c_code.department_code) AS department_code,
  SUM(COALESCE(oli.factory_subtotal, 0))::numeric AS due
FROM orders o
JOIN order_line_items oli ON oli.order_id = o.id
LEFT JOIN companies c_id ON c_id.id = o.factory_company_id
LEFT JOIN companies c_code ON c_code.code = o.factory_code
WHERE o.contract_no = ANY($1::text[])
  AND COALESCE(o.status, '') <> 'cancelled'
GROUP BY
  o.contract_no,
  COALESCE(c_id.code, o.factory_code),
  COALESCE(c_id.name_cn, c_code.name_cn, o.factory),
  COALESCE(c_id.tax_id, c_code.tax_id),
  COALESCE(c_id.parent_company_code, c_code.parent_company_code),
  COALESCE(c_id.department_code, c_code.department_code);
```

输出建议从：

```json
{ "factory": "...", "factory_code": "VEN-ZC", "due": 123 }
```

升级为兼容扩展：

```json
{
  "factory": "烟台中宠股份有限公司",
  "factory_code": "zc-brand",
  "billing_company_code": "zc-brand",
  "billing_company_name": "烟台中宠股份有限公司",
  "billing_tax_id": "...",
  "parent_company_code": "ZC-GROUP",
  "department_code": "brand",
  "due": 123
}
```

第三层：已收票金额也要按主体过滤。

当前 `received` 只要合同号或报关号命中就累加。应改为：对每个 `invoice_gap_factories` 分组，累加 `finance_invoices_in` 时要求 `seller_company_code = billing_company_code`；若旧票缺 `seller_company_code`，才回退 `seller_tax_id = billing_tax_id` 或 `seller_name` 精确匹配，并标记为 `legacy_match`。否则品牌票可能抵扣 OEM 的催票差额。

## 6. 影响面

### 6.1 催票分组

影响最大。`tax-rebate` 当前按 `orders.factory_code` 输出 `invoice_gap_factories`，前端临时按中文名拆分。改造后：

- 后端直接输出 `billing_company_code/department_code/tax_id`。
- 前端按 `billing_company_code` 分组，中文名只展示。
- `invoice_gap` 总额仍可按报关单汇总，但明细必须按主体拆开。

### 6.2 开票申请税号

`invoice-portal.js` 已经从 `orders.factory_company_id -> companies.tax_id` 取税号，方向正确。但要补规则：

- 新订单必须写 `factory_company_id`。
- 缺 `factory_company_id` 时可从 `factory_code` 回填或运行一次数据修复。
- 对中宠品牌订单，`factory_company_id` 必须指向 `zc-brand`。

### 6.3 进项票核对

进项票写入 `seller_company_code` 和 `seller_tax_id`。后续核对必须以 `seller_company_code` 为第一匹配键：

- `finance_invoices_in.seller_company_code = orders.billing_company_code`。
- OCR 识别到的 `seller_tax_id` 应与 `companies.tax_id` 校验；不一致进入人工复核。
- 旧票没有 code 时，用税号补 code，不能只用名称。

### 6.4 退税

退税主表按报关单/合同聚合，但退税资料和进项票缺口需要按开票主体拆。否则一个报关单内若含多个主体，会出现：

- OEM 开票已齐但品牌未齐，被误判已齐。
- 品牌发票金额抵掉 OEM 应开金额。
- 工厂门户看到不属于自己的报关/开票缺口。

### 6.5 账单与对账

账单中心已有 `supplier_company_code/payer_company_code`。原则是所有账单明细都挂具体开票主体：

- 供应商应付：`supplier_company_code` 是实际收款/开票主体。
- 客户/工厂付款方：`payer_company_code` 是实际承担账单主体。
- 集团视图通过 `companies.parent_company_code` 上卷，不改明细口径。

## 7. 迁移步骤与验证点

### 步骤 1：只建结构字段

建议新增：

- `companies.parent_company_code`
- `companies.department_code`
- `companies.department_name`
- `companies.billing_entity_type`
- `companies.is_billing_entity`

验证点：

- `companies.code` 唯一性不变。
- 所有旧查询不依赖新增字段，默认值不影响现有接口。
- `merged_into_code` 语义不变，只用于旧码重定向。

回滚：

- 新字段未被业务写入前可直接忽略。
- 若已写入，先导出字段值再置空，不影响旧字段。

### 步骤 2：回填中宠主体关系

回填目标：

- `VEN-ZC` 标为 `department_code='oem'`，`department_name='OEM部门'`，`parent_company_code='ZC-GROUP'`。
- `zc-brand` 标为 `department_code='brand'`，`department_name='品牌部门'`，`parent_company_code='ZC-GROUP'`，补真实 `tax_id`。
- `zc-oem` 保留 `merged_into_code='VEN-ZC'`，标为 `alias` 或保持只读旧码。

验证点：

- `zc-brand.merged_into_code IS NULL`。
- `VEN-ZC.tax_id` 与 `zc-brand.tax_id` 不同且都非空。
- 新订单选项里能同时看到两个中宠主体，且展示同一父集团。

回滚：

- 清空新增字段即可恢复现状。
- 不回滚 `tax_id` 的正确值，除非确认填错。

### 步骤 3：回填订单/产品主体

先做只读审计：

- 找出 `orders.factory_code='VEN-ZC'` 但 `orders.factory` 或关联产品/历史资料显示品牌主体的订单。
- 找出 `factory_company_id` 与 `factory_code` 不一致的订单。
- 找出 `products.factory_code='VEN-ZC'` 但应归品牌主体的 SKU。

回填策略：

- 未开票/未对账/未退税订单优先改到正确主体。
- 已完成历史单据先不迁，除非 Damon 决定重算历史报表。
- 每次回填记录审计：订单号、原 code、新 code、依据、操作人、时间。

验证点：

- 对同一报关月，中宠 `invoice_gap_factories` 能出现 `VEN-ZC` 和 `zc-brand` 两个 code。
- `orders.factory_company_id -> companies.code` 与 `orders.factory_code` 一致率为 100%。
- 品牌订单的开票门户返回品牌税号。

回滚：

- 依据审计表按订单恢复原 `factory_code/factory_company_id`。
- 产品主数据回滚不应影响已经锁定主体的历史订单。

### 步骤 4：改 `tax-rebate` 聚合

改 `tax-rebate-invoice-gap.js`：

- 聚合维度改为 `billing_company_code`。
- 输出部门、父公司、税号字段。
- 已收票金额按 `seller_company_code` 过滤，旧票才税号/名称兜底。

验证点：

- 中宠品牌/OEM 不再同为 `VEN-ZC`。
- 同一合同/报关号下多主体时，每个主体的 due/received/gap 单独正确。
- 老前端读取 `factory/factory_code/due` 不报错。

回滚：

- 保留旧输出字段，新字段是兼容扩展。
- 若发现对账异常，可临时切回旧 received 计算，但前端不应再按中文名拆分。

### 步骤 5：前端去掉中文名硬分

前端改为：

- 用 `billing_company_code` 或兼容的 `factory_code` 分组。
- 展示 `billing_company_name`、`department_name`、`tax_id`。
- 删除“食品/股份”字符串判断。

验证点：

- 改名、简称、OCR 名称变化不影响分组。
- 中宠两个主体分别展示各自催票金额和已收票金额。

回滚：

- 后端仍输出旧字段，前端可回退到旧展示，但不建议恢复中文硬分。

## 8. Damon 需要拍板的决策点

1. 父公司是否必须有一条 `companies` 行。推荐有，用于集团汇总；但父公司是否可开票需要明确。
2. 父公司 code 用什么。建议 `ZC-GROUP`，但要符合现有 code 命名和长度约束。
3. `type` 是否扩展枚举。推荐短期不依赖 `type` 表达部门，新增 `billing_entity_type`。
4. `zc-brand` 的正式 code 是否保留小写。现有代码有些地方会 `.toUpperCase()` 或截断到 8 位，例如 [api/db/order-create-v2.js](/home/damon/canonical/sanlyn-api/api/db/order-create-v2.js:887)。若未来订单入口会把 `zc-brand` 转成 `ZC-BRAND`，需要统一 code 大小写策略。
5. 历史发票/账单是否迁移。推荐只迁未闭环业务；已完成历史保持原样并通过审计说明。
6. `finance_invoices_in` 旧票缺 `seller_company_code` 时，是否允许按税号自动补 code。推荐允许，但必须只在税号唯一命中时补。
7. 产品主数据是否需要“一 SKU 多供应主体”。若品牌/OEM 共享 SKU 但开票主体不同，单一 `products.factory_code` 可能不够，需要订单行锁定主体。
8. 工厂门户权限是否按部门主体隔离。推荐按 `company_code` 直接隔离，集团账号另做上卷权限。

## 9. 推荐实施原则

- 明细永远挂具体开票主体，集团只做上卷汇总。
- `tax_id` 是校验字段，不是主关联键；主关联键仍用 `companies.code/id`。
- `merged_into_code` 只解决历史旧码，不解决组织层级。
- `orders.factory_code` 与 `orders.factory_company_id` 必须一致，否则不同模块会继续分裂。
- 任何需要开票、催票、对账的流程都不得再靠中文名判断主体。
