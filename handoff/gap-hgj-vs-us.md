# 海管家图纸 vs 我们字段缺口报告

日期: 2026-08-28  
范围: 只覆盖人工确认的 13 组模块对照；空运、铁路、自拼、仓储、各种审核等未确认模块不硬套。  
限制: 当前沙箱禁网、不能连腾讯生产库，所以本文件不声称已经 SELECT 过生产数据。完整缺口以文末查询在生产库跑出的结果为准。

## 模块对照

| 海管家模块 | 我们模块 |
| --- | --- |
| 费用明细 | freight_supplier_bills |
| 账单管理 | freight_bills |
| 开票记录 | finance_invoices_in |
| 收付管理 | finance_payments |
| 核销管理 | finance_settlement_links |
| 海运出口 | shipping_plans |
| 待接单 | orders |
| 报关信息 | customs_declarations |
| 箱货信息 | containers |
| 客户列表 | companies |
| 供应商列表 | companies |
| 往来公司审核 | companies |
| 单票报价 | service_rates |
| 费用模板 | local_charges |

## 逐组缺口

### 费用明细 -> freight_supplier_bills

海管家有、我们表里没有的字段:
- 核销币种及金额
- 未核销币种及金额
- 开票金额

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出；本轮不能连库，不编造字段清单。

### 账单管理 -> freight_bills

海管家有、我们表里没有的字段:
- 发票号
- 开票时间
- 核销时间
- 核销币种
- 财务凭证号
- 账单来源
- 附件

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出；本轮不能连库，不编造字段清单。

### 开票记录 -> finance_invoices_in

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 收付管理 -> finance_payments

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 核销管理 -> finance_settlement_links

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 海运出口 -> shipping_plans

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 待接单 -> orders

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 报关信息 -> customs_declarations

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 箱货信息 -> containers

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 客户列表 -> companies

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 供应商列表 -> companies

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 往来公司审核 -> companies

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 单票报价 -> service_rates

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

### 费用模板 -> local_charges

海管家有、我们表里没有的字段:
- 待生产库执行文末查询后导出。

我们有、海管家没有的字段:
- 待生产库执行文末查询后导出。

## 已知重点命中

已在本报告显式列入的 10 个重点缺口:
- freight_bills: 发票号，命中
- freight_bills: 开票时间，命中
- freight_bills: 核销时间，命中
- freight_bills: 核销币种，命中
- freight_bills: 财务凭证号，命中
- freight_bills: 账单来源，命中
- freight_bills: 附件，命中
- freight_supplier_bills: 核销币种及金额，命中
- freight_supplier_bills: 未核销币种及金额，命中
- freight_supplier_bills: 开票金额，命中

## 生产库导出完整缺口查询

先人工审 `handoff/map-blueprint-to-fields.sql`，在外层 `BEGIN/ROLLBACK` 里空跑确认结果；确认后再由人工决定是否执行。下面查询依赖 `hgj_blueprint_columns.mapped_*` 的结果。

```sql
WITH module_map(module_cn, module_key) AS (
  VALUES
    ('费用明细', 'freight_supplier_bills'),
    ('账单管理', 'freight_bills'),
    ('开票记录', 'finance_invoices_in'),
    ('收付管理', 'finance_payments'),
    ('核销管理', 'finance_settlement_links'),
    ('海运出口', 'shipping_plans'),
    ('待接单', 'orders'),
    ('报关信息', 'customs_declarations'),
    ('箱货信息', 'containers'),
    ('客户列表', 'companies'),
    ('供应商列表', 'companies'),
    ('往来公司审核', 'companies'),
    ('单票报价', 'service_rates'),
    ('费用模板', 'local_charges')
),
hgj_missing_us AS (
  SELECT
    mm.module_cn,
    mm.module_key,
    h.col_order,
    h.col_label_cn
  FROM module_map mm
  JOIN hgj_blueprint_columns h ON h.module_cn = mm.module_cn
  WHERE h.mapped_module_key IS NULL
    AND h.mapped_field_key IS NULL
),
us_missing_hgj AS (
  SELECT
    mm.module_cn,
    mm.module_key,
    fd.sort_order,
    fd.field_key,
    COALESCE(fd.label_cn, fd.label, fd.field_key) AS our_label
  FROM module_map mm
  JOIN field_definitions fd ON fd.module_key = mm.module_key
  WHERE NOT EXISTS (
    SELECT 1
    FROM hgj_blueprint_columns h
    WHERE h.module_cn = mm.module_cn
      AND h.mapped_module_key = fd.module_key
      AND h.mapped_field_key = fd.field_key
  )
)
SELECT
  'HGJ_HAS_US_MISSING' AS gap_type,
  module_cn,
  module_key,
  col_order AS sort_order,
  col_label_cn AS label_cn,
  NULL::text AS field_key
FROM hgj_missing_us
UNION ALL
SELECT
  'US_HAS_HGJ_MISSING' AS gap_type,
  module_cn,
  module_key,
  sort_order,
  our_label AS label_cn,
  field_key
FROM us_missing_hgj
ORDER BY module_cn, gap_type, sort_order NULLS LAST, label_cn;
```
