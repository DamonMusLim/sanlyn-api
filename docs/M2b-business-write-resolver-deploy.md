# M2b Business Write Resolver

本次只补空字段，不覆盖人工值，不碰金额、价格、重量、状态、申报货值。

## 文件

- `api/internal/business-write-resolver.mjs`
- `migrations/M035-20260723-ai-business-write-resolver-grants.sql`

## tencent 部署步骤

1. 备份活机文件：

```bash
cd /opt/sanlyn-api-test
bak="backups/$(date +%Y%m%d-%H%M%S)-m2b"
mkdir -p "$bak"
cp -a api/internal "$bak"/
```

2. 拷贝 resolver 到活机：

```bash
install -m 750 api/internal/business-write-resolver.mjs /opt/sanlyn-api-test/api/internal/business-write-resolver.mjs
```

3. 用 owner/superuser 执行增量权限：

```bash
psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/M035-20260723-ai-business-write-resolver-grants.sql
```

4. 越权自检，切到 `sanlyn_ai_resolver` 后执行迁移文件末尾 6 条 SQL，必须全部失败。

## dry-run

环境变量必须使用受限角色 `sanlyn_ai_resolver`。

```bash
cd /opt/sanlyn-api-test
printf '{"action":"link_bl_orders","sample_limit":20}\n' | node api/internal/business-write-resolver.mjs
printf '{"action":"link_oli_product","sample_limit":20}\n' | node api/internal/business-write-resolver.mjs
printf '{"action":"fill_factory_from_oli_product","sample_limit":20}\n' | node api/internal/business-write-resolver.mjs
```

每个 dry-run 输出 `candidate_count`、样本、候选 SQL hash。歧义来源不会进入候选。

## 灰度 apply

首批硬上限 5 条，传更大的 `limit` 也会被 resolver 压到 5。

```bash
printf '{"action":"link_bl_orders","apply":true,"limit":5}\n' | node api/internal/business-write-resolver.mjs
printf '{"action":"link_oli_product","apply":true,"limit":5}\n' | node api/internal/business-write-resolver.mjs
printf '{"action":"fill_factory_from_oli_product","apply":true,"limit":5}\n' | node api/internal/business-write-resolver.mjs
```

## 验证 SQL

```sql
SELECT action, count(*) AS n, count(*) FILTER (WHERE verified) AS verified
FROM ai_business_write_audit
WHERE created_at > now() - interval '1 hour'
GROUP BY action
ORDER BY action;

SELECT id, order_nos FROM shipping_plans
WHERE id IN (
  SELECT target_pk::int FROM ai_business_write_audit
  WHERE action='link_bl_orders' AND created_at > now() - interval '1 hour'
);

SELECT id, product_id FROM order_line_items
WHERE id IN (
  SELECT target_pk::int FROM ai_business_write_audit
  WHERE action='link_oli_product' AND created_at > now() - interval '1 hour'
);

SELECT id, factory_company_id FROM orders
WHERE id IN (
  SELECT target_pk::int FROM ai_business_write_audit
  WHERE action='fill_factory_from_oli_product' AND created_at > now() - interval '1 hour'
);
```

如果线上 `orders` 的工厂列不是 `factory_company_id`，最后一条按 `information_schema` 查到的真实列名替换。
