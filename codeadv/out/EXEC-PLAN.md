# 旧码迁 CN-000xx 安全执行方案审议

日期: 2026-07-18
范围: 只给方案,不执行 SQL,不迁移,不改代码,不部署。

## 结论摘要

1. **OCEANBABY 暂列不迁例外,按我方主体锚点处理。**
   理由: 它是 `type=sanlyn_entity` 我方主体,426 个引用不是普通供应商/客户引用;代码里 `doc-data.js` 明确把 `OCEANBABY` 当默认 seller profile 路径的一部分,且 seller_profiles/stamps/单据抬头是法务与银行资料锚点。它与 BABI 一样会进入开票、收款账户、单据模板、印章选择链路。除非先完成“我方主体 code 是否也全面 CN 化”的产品决策和模板/token兼容,否则迁它比迁外部公司风险高。
2. **中宠三账户不合并,但可分别给独立 CN 码;不要用 tax_id 把它们折叠。**
   `VEN-ZC`、`zc-oem`、`zc-brand` 是 1 法人 3 账户/部门可见性模型,迁移目标应是“3 行主体各自 code 变 CN-000xx,并保留旧码别名”,不是合并为一行。`zc-oem` 若只是停用别名,也不要删除;建议作为 inactive/merged_into_code 指向其独立新码或保留旧码 alias,直到确认 0 活跃引用。
3. **迁移必须是单事务:锁旧 company 行 + 先备份映射快照 + 改 companies.code + 同事务改所有 code 引用列/数组/JSONB。**
   不能只改 `companies.code`,否则 JWT scope、客户档、印章、账单、任务和协同链接会断。

## OCEANBABY 决策

建议: **本轮不迁 OCEANBABY**。

依据:

- `api/db/doc-data.js` 中注释写明当前默认 seller 曾固定走 `OCEANBABY`,实际读取 `seller_profiles.code`;这说明它不只是业务往来方 code,还是单据签发主体入口。
- `api/db/seller-profiles.js` 暴露 `seller_profiles.code`、银行账号、税号、印章等内部签发资料;这类 code 改动会影响 PI/SC/IV/贷记单/收款账户选择。
- `api/db/companies.js` 的 seed 里有 `BABI`、`OB` 等 Sanlyn group 主体;我方主体历史短码有锚点属性。BABI 已明确不动,OCEANBABY 同类但不是同一个法务锚点,应先建“我方主体迁移专案”再动。

可接受的替代方案:

- 若 Damon 明确要求所有我方主体也 CN 化,先做只读审计: `seller_profiles.code`, `customer_stamps.company_code`, `bank_accounts.company_code`, `orders.seller_code`, `finance_invoices_out.seller_company_code`, `finance_invoice_drafts.seller_company_code`, `finance_payments.issuing_co` 的实值分布。
- 建 `company_aliases(company_code=new_cn, alias_text='OCEANBABY')`,代码解析走 alias 后,再灰度迁引用。不要直接改 seller_profiles 主键式 code。

## 中宠系决策

锁定模型:

- `VEN-ZC`: 食品供应商/工厂主体,可迁为规划中的 `CN-00051`。
- `zc-oem`: OEM 部买家/工厂协同账号,不与 `VEN-ZC` 合并;若停用,也作为旧码 alias 或 inactive 主体保留回溯。
- `zc-brand`: 品牌部买家,841 引用最高;迁移必须单独分批、先演练。

建议:

- 三者都可拥有各自 CN 码,但 **tax_id 相同不触发合并**。这里“tax_id=公司唯一身份”的常规规则被中宠锁定模型覆盖,因为 visibility_scope/部门账户互不可见是业务边界。
- `zc-brand` 不先迁第一批。先迁 0 引用和低引用供应商,用审计 SQL 证明模板覆盖完整后,再做 `zc-brand` 单独批次。
- 给每个旧码写 `company_aliases` 和 `companies.merged_into_code` 作为读兼容/回滚索引,但运行期仍应把真实引用列更新为新 CN。

## 代码勘察出的引用点清单

必须纳入迁移候选的 code 文本列:

- 主数据: `companies.code`, `companies.merged_into_code`, `company_aliases.company_code`, `entity_resolution_log.suggested_company_code`, `entity_resolution_log.chosen_company_code`。
- 客户/账号/租户: `customers.company_code`, `customers.parent_company_code`, `customers.company_codes` 或同名数组列, `accounts.company_code`, `accounts.company_codes`, `tenants.company_code`。
- 订单/产品: `orders.company_code`, `orders.factory_code`, `orders.seller_code`, `orders.middleman_code`, `orders.raw->>'companyCode'`, `orders.raw->>'factoryCompanyCode'`, `orders.raw->>'factory_code'`, `products.factory_code`, `products.raw->>'factoryCode'`, `order_line_items` 里若存在冗余 `factory_code/company_code` 也要以 live schema 为准检查。
- 海运/协同: `shipping_plans.company_code`, `shipping_plans.local_charges_code`, `loading_collab_sheets.factory_code`, `customs_draft_sheets.owner_company_code`, `inspection_request_sheets.owner_company_code`, `cert_application_sheets.owner_company_code`, `trucking_pickup_sheets.owner_company_code`, `trucking_evidence_sheets.owner_company_code`, `doc_revision_sheets.owner_company_code`。
- 货代账单/对账: `freight_supplier_bills.supplier_company_code`, `freight_supplier_bills.payer_company_code`, `active_freight_supplier_bills` 是视图但要刷新确认列存在。
- 财务/单据: `finance_invoices_in.seller_company_code`, `finance_invoices_in.buyer_company_code`, `finance_invoices_out.seller_company_code`, `finance_invoice_drafts.seller_company_code`, `credit_notes.company_code`, `bank_accounts.company_code`, `bank_slips.beneficiary_company_code`, `company_billing_policies.company_code`。
- 退税/发票协同: `customs_invoice_status.factory_code`, `invoice_customs_links.factory_code`, `invoice_points.factory_code`, `customs_advice.company_code`, `invoice_collab_confirm_overrides` 里若有 payload JSONB company code 也要扫。
- 任务/事件/证书: `tasks.company_code`, `tasks.factory_company_code`, `collaboration_threads.factory_company_code`, `company_certs.company_code`, `export_certs.company_code`, `recurring_orders.company_code`, `recurring_orders.factory_code`, `brand_applications.applicant_company_code`, `company_brand_permissions.company_code`, `company_own_brands.company_code` 若 live schema 存在。
- 网络/关系: `partner_relationships.company_code_a`, `partner_relationships.company_code_b`, `factory_invites.invited_by`, `factory_invites.referred_by`, `customers.referred_by` 这类有些是用户/销售字段,迁前要按实值确认是否存 company code。
- 印章/签发主体: `seller_profiles.code`, `customer_stamps.company_code`, `companies.stamps` JSONB 内若嵌 code。
- token/meta: `magic_links.meta` JSONB 内的 `company_code`, `companyCode`, `company_codes`, `factory_code`, `supplier_company_code`, `payer_company_code`, `company_label` 等文本 key;`meta.company_id` 是 id 关联,不用随 code 改但要校验关联显示。
- JSONB/数组残留: 所有 `raw`, `payload`, `meta`, `fields_json`, `declaration`, `inspection`, `application_data`, `pickup`, `evidence`, `revision_data`, `commission_model`, `line_items` 中出现旧码的 key,不能用盲替换,只对白名单 key 更新。

非 code 但要注意的 id 关联:

- `shipping_plans.forwarder_company_id/customer_company_id/factory_company_id/trucking_company_id` 和 `magic_links.meta.company_id` 走 `companies.id`,改 code 不影响 FK,但显示名/权限 token 仍可能读 `companyCode`。
- `drivers.trucking_company_id`、`driver_reviews.rater_company_id` 在代码里有 UUID/公司 id 混用迹象;不要把它们当 CN code 盲改。

## 原子迁移 SQL 模板

以下是模板,不是可直接执行脚本。正式执行前必须由人工用 live schema 生成列存在清单。

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS company_code_migration_audit (
  batch_id text NOT NULL,
  table_name text NOT NULL,
  pk text NOT NULL,
  column_name text NOT NULL,
  old_code text NOT NULL,
  new_code text NOT NULL,
  old_value jsonb,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, table_name, pk, column_name)
);

SELECT id, code, name_cn, name_en, tax_id, type
  FROM companies
 WHERE code = :old_code
 FOR UPDATE;

-- 前置硬校验:
-- 1) :old_code <> 'BABI'
-- 2) NOT EXISTS (SELECT 1 FROM companies WHERE code=:new_code)
-- 3) 中宠三账户批次必须 old_code/new_code 一对一,不得多旧码指向同一 new_code
-- 4) 若 tax_id 非空且撞其他公司,必须人工确认是同公司还是中宠锁定例外

INSERT INTO company_code_migration_audit(batch_id, table_name, pk, column_name, old_code, new_code, old_value)
SELECT :batch_id, 'orders', id::text, 'company_code', :old_code, :new_code, to_jsonb(company_code)
  FROM orders WHERE company_code=:old_code
ON CONFLICT DO NOTHING;
UPDATE orders SET company_code=:new_code WHERE company_code=:old_code;

INSERT INTO company_code_migration_audit(batch_id, table_name, pk, column_name, old_code, new_code, old_value)
SELECT :batch_id, 'accounts', id::text, 'company_codes', :old_code, :new_code, to_jsonb(company_codes)
  FROM accounts WHERE company_codes @> ARRAY[:old_code]::text[]
ON CONFLICT DO NOTHING;
UPDATE accounts
   SET company_codes = array_replace(company_codes, :old_code, :new_code)
 WHERE company_codes @> ARRAY[:old_code]::text[];

INSERT INTO company_code_migration_audit(batch_id, table_name, pk, column_name, old_code, new_code, old_value)
SELECT :batch_id, 'orders', id::text, 'raw.companyCode', :old_code, :new_code, raw
  FROM orders WHERE raw->>'companyCode'=:old_code
ON CONFLICT DO NOTHING;
UPDATE orders
   SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{companyCode}', to_jsonb(:new_code::text), true)
 WHERE raw->>'companyCode'=:old_code;

UPDATE companies
   SET code=:new_code, merged_into_code=NULL, updated_at=NOW()
 WHERE code=:old_code;

INSERT INTO company_aliases(company_code, alias_text, normalized_alias, source, confidence, status, created_by)
VALUES(:new_code, :old_code, lower(trim(:old_code)), 'manual', 1, 'active', 'company-code-migration')
ON CONFLICT (normalized_alias) DO UPDATE
  SET company_code=EXCLUDED.company_code, status='active';

COMMIT;
```

执行器应由 live schema 自动生成每列 SQL:

```sql
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema='public'
   AND (
     column_name IN ('company_code','factory_code','supplier_company_code','payer_company_code',
                     'seller_company_code','buyer_company_code','owner_company_code',
                     'applicant_company_code','tenant_code','parent_company_code',
                     'company_code_a','company_code_b','middleman_code','seller_code',
                     'beneficiary_company_code')
     OR column_name LIKE '%company_code%'
     OR column_name LIKE '%factory_code%'
   )
 ORDER BY table_name, column_name;
```

## 分批顺序

1. **Batch 0: 纯审计,不写。**
   生成旧码到新码映射、live schema 引用列、每列命中数、JSONB 命中样本、唯一约束冲突报告。
2. **Batch 1: 引用 0 的旧码。**
   先迁 `FAC-013/015/...`、`FS`、`GM`、`OB`、`TT`、`VEN-CL/GD` 等 0 引用项。但 OCEANBABY/OB 若确认是我方主体或 seller 锚点,从 Batch 1 剔除。
3. **Batch 2: 低引用外部主体。**
   `FAC-023`, `VEN-LP`, `YBT`, `VEN-WHYT`, `AL`, `VEN-YH`, `VEN-DS` 等,每批 1-5 个,跑完只读验收。
4. **Batch 3: 中引用供应商/货代/工厂。**
   `FX`, `RC`, `FAC-014`, `HBN`, `HH`, `CL`, `VEN-TY`, `CY`, `VEN-LL`, `DSD`, `VEN-SS`, `td`。财务/货代账单列必须覆盖后再进。
5. **Batch 4: 中宠单独批。**
   先 `VEN-ZC -> CN-00051` 这类较低引用,再 `zc-oem` 停用/迁移,最后 `zc-brand`。`zc-brand` 必须独立事务、独立回滚包、独立验收。
6. **Batch 5: OCEANBABY/BABI 类我方主体。**
   默认不执行。只有在另一个“我方主体 CN 化”决策通过后才进入。

## 回退方案

- 每批必须写 `company_code_migration_audit`,保存 `batch_id/table/pk/column/old_value`。
- 回滚只能按 batch 逆序做,且先锁 `companies` 新码行。
- 文本列回滚: `UPDATE table SET col=old_code WHERE pk=:pk AND col=new_code`。
- 数组列回滚: 使用审计表 `old_value` 整列恢复,不要再次 `array_replace`,防止同数组有多个迁移 code。
- JSONB 回滚: 恢复审计中的整个 JSONB 旧值,不要盲改 key。
- 回滚前检查新码是否已有迁后新增业务数据;若有,不能自动回滚,必须人工决定是迁回、保留还是拆分。

## 验收检查

每批执行后只读检查:

- `companies.code` 新码存在,旧码不存在或仅作为 `company_aliases.alias_text` 存在。
- 所有 code 列旧码计数为 0,`company_aliases` 旧码计数为 1。
- `accounts.company_code/company_codes` 无旧码,重新签发 JWT 后 scope 正常。
- `orders/products/freight_supplier_bills/finance_invoices_*` 的新码引用计数 = 迁前旧码引用计数。
- `magic_links.meta` 中有效未过期链接无旧码;若为历史过期链接,可保留但要确认不会用于权限判断。
- 中宠验收额外查: 三个新 CN 账户互不可见,brand/OEM/supplier 权限没有串。

## 主要风险清单

1. **最容易漏的是 `magic_links.meta` 和 JWT/account scope。** 代码多处从 token/meta/companyCodes 判权限,只改业务表会造成链接 403 或越权/漏权。
2. **`seller_profiles.code` 与 `customer_stamps.company_code` 是单据/印章锚点。** BABI 已锁不动;OCEANBABY 若迁,需要先改模板和银行账户读取策略。
3. **中宠 tax_id 相同但不能合并。** 如果执行器按 tax_id 自动去重,会破坏 3 账户 visibility_scope。
4. **JSONB 不能全库字符串替换。** `raw` 里可能含历史备注、文件名、合同号或审计说明;只能改白名单 key。
5. **外键/唯一约束顺序。** `companies.code` 有 UNIQUE,部分表有 `REFERENCES companies(code)` 如 `company_aliases/company_billing_policies/finished_goods_inventory`;若 FK 是 immediate,先改引用列会指向不存在新码,先改 companies 又可能被旧引用挡住。正式 SQL 要根据 live FK `ON UPDATE CASCADE` 情况决定:优先给 FK 加 `ON UPDATE CASCADE` 或用 deferrable 事务;不能假设。
6. **断号选择不是唯一风险。** 新 CN 码必须先查不存在,且不能与 `BD-00078` 等非 CN 编码混用规划。
7. **tax_id 空的主体不要先补猜。** `zc-brand/CY/DSD/HBN` 等空税号可先迁 code,但必须标记 `tax_id_missing`;不能为了迁移编税号。若公司名重复,先人工判定是否同公司/别名/部门账户。
8. **名称重复不能重复建档。** 迁移是 rename/update 引用,不是 insert 新 company;若必须 insert 新 CN 行,先证明旧行不能改 code 并保留 id 映射。
9. **视图与缓存。** `active_freight_supplier_bills` 是视图,不用直接更新,但依赖基表列;执行后要刷新连接池/让长事务结束,避免旧计划缓存。
10. **OCEANBABY 与 `OB` 可能是两个历史锚点。** `companies.js` seed 有 `OB: Ocean Baby`;实测高引用是 `OCEANBABY`。迁前必须确认二者是否同法人/同 seller profile,不能合并猜测。

## 不确定点

- 本方案基于代码静态勘察和 Claude 给出的 DB 实测摘要,未连接 live DB,所以表是否存在、列类型、FK deferrability、触发器状态必须由人工在 DB 上确认。
- `order_line_items`、`finance_invoices_in/out`、`bank_slips` 等表的完整 DDL 不在单一迁移文件内,需以 live `information_schema` 为准。
- `magic_links.meta` 的 key 没有集中 schema,只能通过样本审计确定最终白名单。
