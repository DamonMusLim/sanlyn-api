# Dry-run / Apply 示例输出 (2026-05-23 真实跑通记录)

> 用 2 条真实 products 行(id 890/891, 当时 factory_code/net_weight/gross_weight/carton_qty 为空,
> cbm 已有值)做的工具验证。验证后已用生成的回滚脚本还原, 生产数据零变更。

## 1. DRY-RUN (默认, 只读, 末尾自动 ROLLBACK)

```
══ safe-backfill-import v4 ══
表=products  匹配键=id  数据列=[factory_code,net_weight,gross_weight,cbm,carton_qty]
模式=🟢 DRY-RUN  策略=只填空  allow-multi=false

匹配键 DB 唯一约束: ✅ 有

── 规划结果 ──
匹配键(有效): 2  跳过-无匹配:1  多行匹配:0
各列实际将变更行数: { factory_code: 2, net_weight: 2, gross_weight: 2, cbm: 0, carton_qty: 2 }
各列当前"空"数(NULL或空串): { factory_code:'529', net_weight:'294', gross_weight:'294', cbm:'230', carton_qty:'22' }

🟢 DRY-RUN 完成(已 ROLLBACK), 未写库.
```

注: `cbm: 0` 将变更 —— 890/891 的 cbm 已有值, 只填空模式正确跳过(证明非破坏)。

## 2. APPLY (真跑, 事务内备份+更新, COMMIT 前写审计/回滚)

```
── APPLY 完成 ──
实际 UPDATE 影响行(累计): 8
📦 备份: public._import_backup_products_20260522215957_d78593
各列"空"数 BEFORE → AFTER:
  factory_code: 529 → 527
  net_weight:   294 → 292
  gross_weight: 294 → 292
  cbm:          230 → 230   (已有值, 未动)
  carton_qty:   22  → 20
📝 审计: ..._demo.csv.audit_20260522215957.tsv (8 单元格)
↩️  精确回滚: ..._demo.csv.rollback_20260522215957.sql
```

## 3. 生成的精确回滚 SQL (片段, 以行主键 id 寻址 + 值守卫)

```sql
BEGIN;
UPDATE public."products" t SET "factory_code" = w.oldv::text
  FROM (VALUES ('890', NULL, 'FDEMO'), ('891', NULL, 'FDEMO')) AS w(rid, oldv, newv)
 WHERE t."id"::text = w.rid AND t."factory_code" IS NOT DISTINCT FROM w.newv::text;
-- ... net_weight / gross_weight / carton_qty 同理 ...
COMMIT;
```

值守卫 `IS NOT DISTINCT FROM w.newv` = 仅当当前值仍等于本次导入写入值才回退, 不会误伤导入后的合法修改。

## 4. 失败安全验证 (真实发生)

首次用 9 字符 factory_code 测试时, 因 `factory_code` 是 `varchar(8)`, DB 报 `value too long`,
**整个事务自动 ROLLBACK** —— 无部分写入、无残留备份表、生产 890/891 仍为 NULL。证明:
坏数据 → 全回滚, 绝不破坏存量。

## 5. 严格 CSV 校验 (真实拒绝)

```
❌ CSV 第 2 行无引号字段内出现裸引号 " (疑似格式损坏)
```
