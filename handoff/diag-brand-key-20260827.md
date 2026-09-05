# 品牌授权查空诊断：中宠多码

日期：2026-08-27
范围：只诊断，不改查询逻辑。

## 结论

新建订单页的 Supplier 下拉由 `/api/db/order-create-v2?action=factory-by-buyer` 提供；选中后，前端把返回行的 `companyCode || prefix || name` 当作 `factoryCode` 传给 `/api/db/factory-brands`。

当前后端 `/api/db/factory-brands` 不做实体码解析，直接用 `factory_brands.factory_code = $1` 查品牌。因此下拉 value 为 `CN-00051` 时，只会查 `factory_brands.factory_code='CN-00051'`。brief 已给定真库事实是 WANPY 授权在 `CN-00040`、`zc-brand`、`VEN-ZC`、`ZC`、`petbaby` 等码上，没有挂在 `CN-00051` 上，所以页面显示空品牌。

当前 sandbox 阻止连接本机 Postgres：`connect EPERM 127.0.0.1:5432`，且本机无 `psql`。所以第 3、4 项要求的真库逐行值和全库条数本轮未能由我直接查出；下面列出应在有 DB 权限环境执行的只读 SQL。

## 1. Supplier 下拉来源

前端入口：`public/assets/index.js`，实际 `data#orders` bundle 中存在：

```js
fetch(to+"/api/db/order-create-v2?action=factory-by-buyer&buyerCode="+encodeURIComponent(s) ...)
```

后端来源：`api/db/order-create-v2.js` 的 `factory-by-buyer` 分支。

关键查询原文：

```sql
SELECT pr.company_code_b AS code,
       pr.role_at_hop
  FROM partner_relationships pr
 WHERE pr.company_code_a = $1
   AND pr.relationship_type = 'customer_factory'
   AND pr.status = 'active'
```

随后非 trader 的 `company_code_b` 会去 `factories` 表 hydrate：

```sql
SELECT f.company_code, f.name AS name_cn, f.name_short, f.po_prefix, f.ports, f.address,
       c.name_en, c.address_cn, c.address_en, c.currency, c.addresses
  FROM factories f
  LEFT JOIN customers c ON (c.company_code = f.company_code OR c.name_cn = f.name)
 WHERE f.company_code = ANY($1::text[])
```

返回给前端时使用：

```js
companyCode: row.company_code || ""
```

因此 `CN-00051` 这个 value 的最可能来源是 `partner_relationships.company_code_b='CN-00051'`，并由 `factories.company_code='CN-00051'` hydrate 成 Supplier 下拉项。

验证 SQL：

```sql
SELECT pr.company_code_a, pr.company_code_b, pr.relationship_type, pr.status, pr.role_at_hop
  FROM partner_relationships pr
 WHERE pr.company_code_b IN ('CN-00051','VEN-ZC','zc-brand','zc-oem','ZC','petbaby')
    OR pr.company_code_a IN ('CN-00051','VEN-ZC','zc-brand','zc-oem','ZC','petbaby')
 ORDER BY pr.company_code_a, pr.company_code_b;
```

## 2. 工厂品牌查询方

后端文件：`api/db/factory-brands.js`

函数：默认导出的 `handler(req, res)`。

请求参数：

```js
const factoryCode = (req.query.factoryCode || "").trim();
const buyerCompanyCode = (req.query.buyerCompanyCode || "").trim();
```

品牌查询 SQL 原文：

```sql
SELECT brand, status, source
  FROM factory_brands
 WHERE factory_code = $1 AND status = 'active'
 ORDER BY brand
```

买家授权查询 SQL 原文：

```sql
SELECT brand FROM company_brand_permissions
 WHERE tenant_code = 'SANLYN'
   AND company_code = $1
   AND visibility IN ('full','rfq')
```

用键：

- 工厂有哪些品牌：`factory_brands.factory_code = req.query.factoryCode`
- 买家是否授权：`company_brand_permissions.company_code = req.query.buyerCompanyCode`

前端调用：

```js
var s = a.companyCode || a.prefix || a.name;
var c = to+"/api/db/factory-brands?factoryCode="+encodeURIComponent(s);
o && o.companyCode && (c += "&buyerCompanyCode="+encodeURIComponent(o.companyCode));
```

这里没有把 `CN-00051` 解析为 `ZC`/`VEN-ZC`/`zc-brand`/`zc-oem`。

## 3. 四码之间的库内关联字段

本轮未能直接查真库。应执行：

```sql
SELECT 'customers' AS table_name, id::text, company_code AS code,
       name_cn, name_en, role_type::text AS type,
       tax_no::text AS tax_id, group_code::text, group_name::text,
       parent_company_code::text, is_active::text
  FROM customers
 WHERE company_code IN ('CN-00051','VEN-ZC','zc-brand','zc-oem','ZC','petbaby')
    OR name_cn ILIKE '%中宠%'
    OR name_en ILIKE '%CHINA PET%'
UNION ALL
SELECT 'companies' AS table_name, id::text, code,
       name_cn, name_en, type,
       tax_id, NULL, NULL, NULL, NULL
  FROM companies
 WHERE code IN ('CN-00051','VEN-ZC','zc-brand','zc-oem','ZC','petbaby')
    OR name_cn ILIKE '%中宠%'
    OR name_en ILIKE '%CHINA PET%'
UNION ALL
SELECT 'factories' AS table_name, id::text, company_code AS code,
       name AS name_cn, NULL AS name_en, NULL AS type,
       NULL AS tax_id, NULL, NULL, NULL, is_active::text
  FROM factories
 WHERE company_code IN ('CN-00051','VEN-ZC','zc-brand','zc-oem','ZC','petbaby')
    OR name ILIKE '%中宠%'
 ORDER BY table_name, code;
```

仓库内可参考但非真库的线索：

- `companies_import.json` 中 `CN-00051`：`name_cn=烟台中宠食品股份有限公司`，`tax_no=913700007337235643`，`short_name=CP`。
- `api/db/seed-zc-group.js` 试图把 `CN-00051` 作为 `customers` 的 `group_code='ZC'` 根，并创建 `ZC-OEM`、`ZC-BRAND` 两个子码。
- `api/db/migrate-upstream-type.js` 同时出现小写 `zc-brand`、`zc-oem` 和 `CN-00051`，说明代码历史上大小写和实体层级并未统一。

## 4. 其它工厂多码/错码清单

本轮未能直接查真库条数。建议用以下只读 SQL 找出三类 code 集合对不上：

```sql
WITH p AS (
  SELECT DISTINCT NULLIF(BTRIM(factory_code), '') AS code
    FROM products
   WHERE NULLIF(BTRIM(factory_code), '') IS NOT NULL
),
fb AS (
  SELECT DISTINCT NULLIF(BTRIM(factory_code), '') AS code
    FROM factory_brands
   WHERE NULLIF(BTRIM(factory_code), '') IS NOT NULL
),
c AS (
  SELECT DISTINCT NULLIF(BTRIM(company_code), '') AS code
    FROM customers
   WHERE NULLIF(BTRIM(company_code), '') IS NOT NULL
  UNION
  SELECT DISTINCT NULLIF(BTRIM(code), '') AS code
    FROM companies
   WHERE NULLIF(BTRIM(code), '') IS NOT NULL
),
all_codes AS (
  SELECT code FROM p UNION SELECT code FROM fb UNION SELECT code FROM c
)
SELECT a.code,
       (p.code IS NOT NULL) AS in_products,
       (fb.code IS NOT NULL) AS in_factory_brands,
       (c.code IS NOT NULL) AS in_company_master
  FROM all_codes a
  LEFT JOIN p  ON p.code = a.code
  LEFT JOIN fb ON fb.code = a.code
  LEFT JOIN c  ON c.code = a.code
 WHERE NOT (p.code IS NOT NULL AND fb.code IS NOT NULL AND c.code IS NOT NULL)
 ORDER BY a.code;
```

条数：

```sql
WITH mismatch AS (
  -- paste the SELECT above without ORDER BY
)
SELECT COUNT(*)::int AS mismatch_code_count FROM mismatch;
```

针对疑似同实体多码，可先按名称/税号聚类：

```sql
SELECT COALESCE(NULLIF(tax_id,''), NULLIF(tax_no,''), NULLIF(credit_code,''), name_cn, name_en) AS entity_key,
       jsonb_agg(jsonb_build_object('source', src, 'id', id, 'code', code, 'name_cn', name_cn, 'name_en', name_en, 'tax', COALESCE(tax_id,tax_no,credit_code))) AS rows,
       COUNT(*) AS n
  FROM (
    SELECT 'customers' src, id::text, company_code code, name_cn, name_en, tax_no, NULL::text tax_id, NULL::text credit_code FROM customers
    UNION ALL
    SELECT 'companies', id::text, code, name_cn, name_en, NULL, tax_id, NULL FROM companies
    UNION ALL
    SELECT 'factories', id::text, company_code, name, NULL, NULL, NULL, NULL FROM factories
  ) s
 GROUP BY entity_key
HAVING COUNT(*) > 1
 ORDER BY n DESC, entity_key;
```

## 5. 修法建议

方案 A：查询侧码解析。

在 `/api/db/factory-brands` 内新增只读解析步骤：收到 `factoryCode=CN-00051` 后，先解析同一实体的允许码集合，再查 `factory_brands.factory_code = ANY($codes)`，买家授权仍按 buyer code 独立判断。解析来源必须是确定性的字段，例如显式 parent/group 关系、唯一税号、或受控映射；不要靠中文名模糊匹配。

影响面：小，集中在品牌展示/产品过滤链路。风险是解析规则写错会把别的工厂品牌带进来。只有在“唯一税号命中”或“显式 alias 表”下启用，才不会把别的工厂授权带偏。

方案 B：建实体别名映射表。

新增 `company_code_aliases` 或 `entity_code_aliases`，字段至少包含 `entity_id`、`alias_code`、`canonical_code`、`alias_type`、`status`、`source`、`created_at`。所有品牌/工厂/产品授权查询先把输入 code 解析成同一实体的 alias 集合，再查授权。

影响面：中等，需要迁移和少量查询接入，但长期最稳。这个方案最不容易把别的工厂授权带偏，因为每个 alias 都是人工确认的显式关系；禁止按名称自动合并，只允许 `status='active'` 的人工/迁移确认 alias 生效。

方案 C：补齐授权数据到当前下拉 code。

把 `factory_brands`/`factory_brand_authorizations` 中 `ZC`、`VEN-ZC` 的 WANPY 授权复制到 `CN-00051`。

影响面：表面最小，但不推荐作为根治。它会继续复制多码债务，后续 `products.factory_code`、订单主体、发票主体仍可能分裂；只适合作为临时人工数据修补，且必须逐品牌逐工厂确认。

推荐：先做 B，若上线周期紧，可做 A 作为读侧兼容，但解析来源必须来自显式 alias 或唯一税号，不允许名称模糊。
