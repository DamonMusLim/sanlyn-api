# 开票对账合并方案：催票能力并入报关单开票协同

## 0. 结论先行

本次调研只读代码，未改业务代码。当前工作树没有 `CustomsCollabModule.jsx`、`InvoiceChasingModule.jsx`、`OrphanInvoicePanel.jsx` 这三个 React 文件；可见前端只有 `public/customs-collab-factory.html`、`public/factory-invoice-reconcile.html` 以及后端 API。数据库连接变量本地也不可用，`psql` 未安装，因此 4,029,421 / 1,450,929 的生产金额不能在本机复算；本文把金额差异落到代码级 SQL/字段证据，并给出有库环境复核 SQL。

核心判断：`customs-collab` 的“已开”不是工作流 confirm，而是 `invoice_customs_links` 显式绑定到报关单后的 `finance_invoices_in`；`tax-rebate` 的“已收 received”是直接在 `finance_invoices_in.contract_nos/customs_nos` 上按合同/报关号命中。两边的应开金额来源也不同：`customs-collab` 优先报关单 `finance_export_rebates.raw.items[].amount`，`tax-rebate-invoice-gap` 用订单行 `order_line_items.factory_subtotal`。所以 403 万 vs 145 万最可能来自两类差异叠加：

1. `customs-collab` 只认 `invoice_customs_links` 的显式报关单绑定，很多已到账进项票只有 `contract_nos` 没有 `invoice_customs_links`，在协同台算 0。
2. `customs-collab` 应开金额优先税局/报关明细金额，`tax-rebate` 应开金额用工厂含税小计，两者不是同一业务口径。
3. 范围也不完全相同：`customs-collab` 从订单集合反推报关 key，再按 `b.export_date` 过滤；`tax-rebate` 直接按 `finance_export_rebates.export_date` 月份过滤。

合并建议：合并后“已开/已收”统一以真实进项票 `finance_invoices_in` 为事实源；但展示层区分两个概念：`received_amount` = 已到账进项票金额，`linked_amount` = 已人工绑定/归档到报关单金额，`manual_confirm_status` = 工厂/财务人工确认状态。不要让 confirm 状态覆盖进项票事实。

## 1. 三个模块的现状

### 1.1 报关单开票协同：`customs-collab`

端点：`/api/db/customs-collab`，在 `server.js:267` 挂载。支持 `action=list/detail/confirm/upload/upload_slip/correction/factory_list`，见 `api/db/customs-collab.js:954-966`。

它的列表主流程在 `fetchRows()`，见 `api/db/customs-collab.js:176-317`：

- 范围：`rangeFromQuery()` 默认当前月，过滤 `b.export_date >= start` 且 `< end`，见 `api/db/customs-collab.js:53-60`、`api/db/customs-collab.js:176-179`。
- 订单候选：`ord` CTE 只取非取消、已出运/有 BL 的订单，见 `api/db/customs-collab.js:194-214`。
- 报关单范围：`fer_base` 从 `finance_export_rebates` 按 `customs_no` 聚合；`keyed` 用 `fer_base.contract_no = orders.contract_no` 关联，`decl_key = COALESCE(f.customs_no, ord.bl_no, ord.order_no)`；最终 `b` 按 `factory_code, decl_key` 分组，见 `api/db/customs-collab.js:215-252`。这解释了“28 张报关单范围”的来源：不是直接 `finance_export_rebates` 月份全量，而是“满足订单状态的订单 + 能按合同连到 fer 的真实 customs_no + 否则 BL/订单号兜底”。
- 应开：`system_expected_amount = COALESCE(MAX(fer_declare), SUM(declare_value), SUM(purchase_value))`，见 `api/db/customs-collab.js:246-248`。其中 `fer_declare` 是 `finance_export_rebates.raw.items[].amount` 求和，`declare_value` 只对 `order_no ILIKE '%-DG-%'` 用 `declare_amount_per_box * qty_ctn`，否则兜底 `factory_subtotal/total_amount_factory`，见 `api/db/customs-collab.js:201-205`、`api/db/customs-collab.js:219-221`。
- 人工应开：`effective_expected_amount = COALESCE(s.manual_expected_amount, b.system_expected_amount)`，见 `api/db/customs-collab.js:266-267`。
- 已开/已上传：`uploaded_amount` 只从 `invoice_customs_links l JOIN finance_invoices_in fii` 取，要求 `l.customs_no=b.customs_no`、`l.link_status='active'`、`fii.review_status NOT IN ('void','red_ink')`，见 `api/db/customs-collab.js:279-287`。
- 差额：`diff_amount = effective_expected_amount - uploaded_amount`，见 `api/db/customs-collab.js:270-273`。

状态判定由 `customs-collab-status.js` 决定：

- `ensureCustomsStatus()` 会为报关单创建/更新 `customs_invoice_status`，初始状态为 `need_amount` 或 `pending_confirm`，见 `api/db/customs-collab-status.js:50-117`。
- `uploadedForCustoms()` 与列表同口径，只认 `invoice_customs_links`，见 `api/db/customs-collab-status.js:119-139`。
- `nextStatus()`：无票时，若已有 `expected_amount_confirmed_at` 则 `confirmed_wait_invoice`，否则 `pending_confirm`；有票后按差额判 `matched`、`partial_uploaded`、`over_issued`，见 `api/db/customs-collab-status.js:141-159`。
- `handleConfirm()` 只把 `customs_invoice_status.status` 改为 `confirmed_wait_invoice`，并写 `expected_amount_confirmed_at/by`，不写入发票金额，见 `api/db/customs-collab.js:391-437`。所以 confirm 不是“已开票”。
- `handleCorrection()` 的 `complete` 可把状态设成 `completed`；`review_match/review_mismatch` 改的是 `finance_invoices_in.review_status`；`void/red_ink/unbind` 改发票或链接状态，见 `api/db/customs-collab.js:576-656`。

### 1.2 催票/退税：`tax-rebate` + `tax-rebate-invoice-gap`

端点：`/api/db/tax-rebate`，在 `server.js:622` 挂载。它不是纯催票端点，还维护退税状态、品名行发票映射、退税资料视图，不能随催票页一起删除。

范围和主表：

- 月份来自 `finance_export_rebates.export_date`，`list=months` 直接查 `finance_export_rebates`，见 `api/db/tax-rebate.js:151-158`。
- 月度明细 `WHERE fer.export_date >= start AND fer.export_date < end`，见 `api/db/tax-rebate.js:293-310`。
- 主查询以 `finance_export_rebates fer` 为基表，按 `fer.contract_no` 左连 `orders`、`order_line_items`、`products`、`companies`，见 `api/db/tax-rebate.js:190-215`。

催票差额：

- `loadInvoiceGapByCustoms(pool, ferRows)` 从 `ferRows.contract_no` 拆合同，见 `api/db/tax-rebate-invoice-gap.js:25-31`。
- 应开：按 `orders.contract_no, orders.factory, orders.factory_code, brand` 聚合 `SUM(oli.factory_subtotal)`，见 `api/db/tax-rebate-invoice-gap.js:41-56`。这里已经带 `oli.brand/p.brand` 和 `company_own_brands`，见 `api/db/tax-rebate-invoice-gap.js:35-40`、`api/db/tax-rebate-invoice-gap.js:46-54`。
- 已收 received：扫描 `finance_invoices_in`，如果 `contract_nos::text ILIKE '%合同号%'` 或 `customs_nos::text LIKE '%报关号%'` 即算入，见 `api/db/tax-rebate-invoice-gap.js:64-80`、`api/db/tax-rebate-invoice-gap.js:99-105`。
- 差额：`invoice_gap = Math.max(0, due - received)`，见 `api/db/tax-rebate-invoice-gap.js:107-112`。
- 页面上另有“进项票是否存在”判断，使用数组重叠 `customs_nos && allCustomsNos` 或 `contract_nos && allContracts`，见 `api/db/tax-rebate.js:333-369`；注意这与 `invoice_gap` 里的 `::text ILIKE` 不是完全同一个匹配实现。
- `invoice_status` 仍基于 `finance_export_rebates.invoice_nos` 是否有值，见 `api/db/tax-rebate.js:373-377`；这和 `finance_invoices_in` 事实源并不完全一致。

`tax-rebate` 的 PATCH 还会维护 `finance_rebate_inv_map`、兼容插入 `finance_invoices_in` 并追加 `finance_export_rebates.invoice_nos`，见 `api/db/tax-rebate.js:61-110`。这属于退税/资料层，不应在合并催票页时误删。

### 1.3 工厂开票对账：`factory-invoice-reconcile`

端点：`/api/db/factory-invoice-reconcile`，在 `server.js:266` 挂载。它更像“按工厂、月份、合同汇总”的对账台：

- 范围：`range_contracts` 从 `finance_export_rebates` 按 `export_date` 取 `contract_no, period, customs_no`，见 `api/db/factory-invoice-reconcile.js:206-211`。
- 应开：订单行汇总优先 `factory_subtotal`，兜底 `orders.total_amount_factory/subtotal`，见 `api/db/factory-invoice-reconcile.js:212-247`。
- 已开：`finance_invoices_in` 要求 `seller_company_code = g.factory_code`，且 `contract_nos/customs_nos` 与分组合同/报关号数组相交，见 `api/db/factory-invoice-reconcile.js:268-285`。
- 状态：`missing/matched/pending/amount_mismatch`，见 `api/db/factory-invoice-reconcile.js:68-75`。

这个模块的口径比 `tax-rebate` 更严格，因为它要求卖方主体匹配；比 `customs-collab` 更宽，因为不要求 `invoice_customs_links` 显式报关单绑定。

## 2. 口径对账表

| 项 | `customs-collab` | `tax-rebate` / 催票 | `factory-invoice-reconcile` | 合并建议 |
|---|---|---|---|---|
| 范围基表 | 订单 `orders` + `finance_export_rebates` 合同匹配，按 `decl_key` 形成行 | `finance_export_rebates` 月度全量 | `finance_export_rebates` 月度合同 | 合并目标台行仍以 `finance_export_rebates.customs_no` 为主，保留订单兜底但单独标 `source=order_fallback` |
| 月份字段 | `b.export_date = COALESCE(fer_export_date, order_date)` | `fer.export_date` | `fer.export_date` | 月度筛选统一用 `finance_export_rebates.export_date`；兜底行不进正式统计或单列 |
| 应开 | `COALESCE(fer.raw.items.amount, DG报关价, factory_subtotal/total_amount_factory)` | `SUM(order_line_items.factory_subtotal)` | `SUM(factory_subtotal)` 兜底总额 | 开票催办用工厂含税应开 `factory_subtotal`；报关金额单列展示，不再参与未开票缺口 |
| 已开/已收 | `invoice_customs_links` 显式绑定报关单后的 `finance_invoices_in.amount_incl_tax` | `finance_invoices_in` 按 `contract_nos/customs_nos` 命中 | `finance_invoices_in` 按主体 + 合同/报关号命中 | 事实源统一 `finance_invoices_in`；先按主体 + 合同/报关号计算 `received_amount`，显式绑定金额叫 `linked_amount` |
| 工作流状态 | `customs_invoice_status.status`，confirm 后 `confirmed_wait_invoice` | 退税状态 `rebate_lifecycle_status`、资料状态、`invoice_nos` | 发票审核状态 `review_status` | 工作流状态保留为人工协同状态，不代表真实已开票 |
| 品牌/OEM | 当前列表无 brand | `invoice_gap_factories` 已输出 `brand/is_own_brand` | 无品牌 | 从 `tax-rebate-invoice-gap` 的品牌逻辑迁入 `customs-collab` list/detail |
| 孤票 | 无 | 依赖 `invoice-orphan-match` | 无 | 复用 `invoice-orphan-match`，并补挂载端点 |

## 3. 为什么会差 3 倍

### 3.1 不是 confirm 造成“已开=0”，而是绑定表口径造成

代码证据反证了“`customs-collab` 已开=只算 workflow confirm 过”的猜测：

- `customs-collab` 的 `uploaded_amount` 来自 `invoice_customs_links` + `finance_invoices_in`，见 `api/db/customs-collab.js:279-287`。
- `confirm` 只更新 `customs_invoice_status.status='confirmed_wait_invoice'` 和确认时间/人，见 `api/db/customs-collab.js:424-434`。
- 状态机在无发票时才看 `expected_amount_confirmed_at` 决定 `confirmed_wait_invoice`，见 `api/db/customs-collab-status.js:151-153`。

所以真正的问题是：大量已到账进项票可能只写了 `finance_invoices_in.contract_nos`，没有写 `invoice_customs_links(customs_no, invoice_id)`。这些票会被 `tax-rebate` received 算入，但不会被 `customs-collab` uploaded 算入。

### 3.2 应开金额不是同一口径

`customs-collab` 优先用 `finance_export_rebates.raw.items[].amount` 作为报关明细金额，见 `api/db/customs-collab.js:219-221`、`api/db/customs-collab.js:246-248`。`tax-rebate-invoice-gap` 用 `order_line_items.factory_subtotal`，见 `api/db/tax-rebate-invoice-gap.js:43-56`。

如果报关金额与工厂含税采购金额不同，`customs-collab.summary.expected_amount` 与 `tax-rebate.summary.invoice_gap_total` 的基数天然不一致。合并后不能把“报关金额差额”解释为“工厂未开票缺口”。

### 3.3 范围也不一致

`customs-collab` 先筛订单状态，再通过合同连 `finance_export_rebates`，并允许 BL/订单号兜底成 `customs_no`，见 `api/db/customs-collab.js:194-252`。`tax-rebate` 则直接取 `finance_export_rebates` 月度行，见 `api/db/tax-rebate.js:293-310`。

这会导致两个现象：

- `customs-collab` 的“28 张”不一定等于 4-6 月 `finance_export_rebates` 全部报关单数。
- 如果一个 `finance_export_rebates.contract_no` 包含多个合同号，`tax-rebate-invoice-gap` 会拆分，见 `api/db/tax-rebate-invoice-gap.js:6-10`；`customs-collab` 的 `fer_base` 用 `MAX(fer.contract_no)` 并按等值 `f.contract_no=ord.contract_no`，见 `api/db/customs-collab.js:216-237`，对多合同字符串更脆弱。

### 3.4 生产核验 SQL

在有库环境执行以下只读 SQL，可把 4,029,421 与 1,450,929 拆成“应开差异、发票匹配差异、范围差异”三块。

```sql
-- A. customs-collab 等价范围与金额：注意 from/to 改成实际 4-6 月
WITH ord AS (
  SELECT o.id AS order_id, o.order_no, o.contract_no, o.bl_no,
         COALESCE(o.factory_code, c_id.code,
           (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
            WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) AS factory_code,
         o.created_at::date AS order_date,
         CASE WHEN o.order_no ILIKE '%-DG-%'
              THEN (SELECT NULLIF(SUM(oli.declare_amount_per_box*oli.qty_ctn),0) FROM order_line_items oli WHERE oli.order_id=o.id)
              ELSE NULL END AS declare_value,
         COALESCE((SELECT NULLIF(SUM(oli.factory_subtotal),0) FROM order_line_items oli WHERE oli.order_id=o.id),
                  NULLIF(o.total_amount_factory,0)) AS purchase_value
  FROM orders o
  LEFT JOIN companies c_id ON c_id.id=o.factory_company_id
  WHERE (COALESCE(o.status,'') IN ('shipped','delivered','completed','closed','archived','done','received')
         OR COALESCE(o.bl_no,'') <> '')
    AND COALESCE(o.status,'') <> 'cancelled'
),
fer_base AS (
  SELECT fer.customs_no, MAX(fer.contract_no) AS contract_no, MIN(fer.export_date) AS export_date,
         CASE WHEN COUNT(i.item)=0 THEN NULL ELSE ROUND(SUM(NULLIF(i.item->>'amount','')::numeric),2) END AS declare_amount
  FROM finance_export_rebates fer
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
  ) AS i(item) ON true
  GROUP BY fer.customs_no
),
b AS (
  SELECT COALESCE(f.customs_no, NULLIF(ord.bl_no,''), ord.order_no) AS customs_no,
         MAX(ord.contract_no) AS contract_no,
         COALESCE(MIN(f.export_date), MIN(ord.order_date)) AS export_date,
         ord.factory_code,
         COALESCE(MAX(f.declare_amount), NULLIF(SUM(ord.declare_value),0), NULLIF(SUM(ord.purchase_value),0)) AS expected
  FROM ord LEFT JOIN fer_base f ON f.contract_no=ord.contract_no
  GROUP BY ord.factory_code, COALESCE(f.customs_no, NULLIF(ord.bl_no,''), ord.order_no)
)
SELECT COUNT(*) AS customs_count,
       ROUND(SUM(expected),2) AS expected_amount,
       ROUND(SUM(COALESCE(u.uploaded,0)),2) AS linked_uploaded_amount,
       ROUND(SUM(expected-COALESCE(u.uploaded,0)),2) AS diff_amount
FROM b
LEFT JOIN LATERAL (
  SELECT SUM(fii.amount_incl_tax) AS uploaded
  FROM invoice_customs_links l
  JOIN finance_invoices_in fii ON fii.id=l.invoice_id
  WHERE l.customs_no=b.customs_no
    AND l.link_status='active'
    AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink')
) u ON true
WHERE b.export_date >= DATE '2026-04-01' AND b.export_date < DATE '2026-07-01';
```

```sql
-- B. tax-rebate/invoice-gap 等价口径：工厂含税应开 vs finance_invoices_in 合同/报关命中
WITH fer AS (
  SELECT customs_no, contract_no
  FROM finance_export_rebates
  WHERE export_date >= DATE '2026-04-01' AND export_date < DATE '2026-07-01'
),
fer_contracts AS (
  SELECT customs_no, regexp_split_to_table(COALESCE(contract_no,''), '[\/,，;；\s]+') AS contract_no
  FROM fer
),
due AS (
  SELECT fc.customs_no, SUM(COALESCE(oli.factory_subtotal,0)) AS due
  FROM fer_contracts fc
  JOIN orders o ON o.contract_no=fc.contract_no AND COALESCE(o.status,'') <> 'cancelled'
  JOIN order_line_items oli ON oli.order_id=o.id
  GROUP BY fc.customs_no
),
received AS (
  SELECT f.customs_no, SUM(fi.amount_incl_tax) AS received
  FROM fer f
  JOIN finance_invoices_in fi ON
       fi.contract_nos::text ILIKE '%' || COALESCE(f.contract_no,'') || '%'
       OR fi.customs_nos::text LIKE '%' || f.customs_no || '%'
  GROUP BY f.customs_no
)
SELECT COUNT(*) AS fer_count,
       ROUND(SUM(d.due),2) AS due_amount,
       ROUND(SUM(COALESCE(r.received,0)),2) AS received_amount,
       ROUND(SUM(GREATEST(0, d.due-COALESCE(r.received,0))),2) AS gap_amount
FROM fer f
LEFT JOIN due d USING(customs_no)
LEFT JOIN received r USING(customs_no);
```

```sql
-- C. 找出 tax-rebate 能算到但 customs-collab 算不到的进项票
WITH target AS (
  SELECT customs_no, regexp_split_to_table(COALESCE(contract_no,''), '[\/,，;；\s]+') AS contract_no
  FROM finance_export_rebates
  WHERE export_date >= DATE '2026-04-01' AND export_date < DATE '2026-07-01'
),
tax_hit AS (
  SELECT DISTINCT t.customs_no, fi.id, fi.invoice_no, fi.amount_incl_tax, fi.contract_nos, fi.customs_nos
  FROM target t
  JOIN finance_invoices_in fi
    ON fi.contract_nos::text ILIKE '%' || t.contract_no || '%'
    OR fi.customs_nos::text LIKE '%' || t.customs_no || '%'
)
SELECT th.*
FROM tax_hit th
LEFT JOIN invoice_customs_links l
  ON l.invoice_id=th.id AND l.customs_no=th.customs_no AND l.link_status='active'
WHERE l.invoice_id IS NULL
ORDER BY th.amount_incl_tax DESC NULLS LAST;
```

## 4. 目标形态

目标台：`报关单开票协同 / CustomsCollabModule`。一行 = 一个正式报关单 `finance_export_rebates.customs_no`；对历史缺报关单但订单已出运的兜底行可显示，但不计入正式缺口 KPI，避免污染退税口径。

每行保留现有能力：

- 确认金额：`confirm`，仍写 `customs_invoice_status.expected_amount_confirmed_at/by`。
- 改金额：`correction override_amount`。
- 完成：`correction complete`。
- 多开/少开/已核对：由进项票事实金额和人工状态共同展示，底层继续复用 `reconcileStatus()`。

每行新增“未开票处理”区：

1. 发开票链接：按该报关单关联的 `order_nos` 复用 `/api/db/invoice-portal?action=gen&order_no=...`。如果一张报关单有多个订单，前端可展示多个链接；长期建议新增一个“报关单级链接”封装多个 order，但不要在 `customs-collab.js` 重写门户上传逻辑。
2. 孤票配对入口：打开 `invoice-orphan-match?action=suggestions` 的建议列表，可从当前行带入 `customs_no/contract_no/factory_code` 做前端预筛；确认时调用 `POST action=bind` 写 `finance_invoices_in.contract_nos`。然后由 `customs-collab` 的 received/link 口径刷新。
3. 品牌标注：显示 `brand`、`is_own_brand`，规则复用 `tax-rebate-invoice-gap.js` 当前 `company_own_brands` + `oli.brand/p.brand` 的逻辑。
4. 催办状态位：建议新增轻量状态字段，不复用退税状态。字段可以落在 `customs_invoice_status.raw` 或新增 `invoice_chase_status` 表：`customs_no, factory_code, last_sent_at, last_sent_by, chase_status, note, updated_at`。第一期若避免建表，可先只用发链接时间和 `received_amount < due_amount` 派生“待催/已发链接/已收票/异常”。

展示字段建议：

- `expected_invoice_amount`：工厂含税应开，来自订单行 `factory_subtotal`。
- `declaration_amount`：报关金额，来自 `finance_export_rebates.raw.items[].amount`，只做对照。
- `received_amount`：进项票事实到账金额，来自 `finance_invoices_in` 主体 + 合同/报关号匹配。
- `linked_amount`：已显式绑定到 `invoice_customs_links` 的金额。
- `diff_amount = expected_invoice_amount - received_amount`。
- `manual_confirm_status = customs_invoice_status.status`。

## 5. 后端改点

### 5.1 `api/db/customs-collab.js`

建议改 `fetchRows()`，不要重写 `invoice-portal` 和 `invoice-orphan-match`：

1. 行范围收敛：`fer_base` 应保留 `finance_export_rebates.customs_no` 为主；`keyed` 当前 `LEFT JOIN fer_base f ON f.contract_no=ord.contract_no` 对多合同字符串不稳，建议改为先拆 `fer.contract_no`，或以 `finance_export_rebates` 为基表 LEFT JOIN orders。改点在 `api/db/customs-collab.js:215-252`。
2. 补 `order_nos` 字段：当前输出字段名是 `order_no`，实际 `STRING_AGG(DISTINCT order_no, ',')`，见 `api/db/customs-collab.js:245`、`api/db/customs-collab.js:310`。合并后建议新增 `order_nos` 数组或逗号串，保留 `order_no` 兼容。
3. 补 `expected_invoice_amount`：新增订单行 `SUM(oli.factory_subtotal)` 口径，避免继续把 `fer_declare` 当催票应开。当前 `system_expected_amount` 可保留为历史字段，但前端“未开票缺口”应读新字段。改点在 `api/db/customs-collab.js:194-252`。
4. 补 `received_amount`：新增一个 LATERAL，从 `finance_invoices_in` 按 `contract_nos/customs_nos` 命中，并要求 `seller_company_code = b.factory_code`；旧票缺主体时再回退 `seller_name` 精确匹配或仅作为 `legacy_received_amount`。当前 `uploaded_amount` 的 LATERAL 在 `api/db/customs-collab.js:279-287`，应保留并改名语义为 `linked_amount` 或同时输出 `uploaded_amount` 兼容。
5. 补品牌字段：复用 `tax-rebate-invoice-gap.js:35-56` 的 `company_own_brands`、`oli.brand/p.brand` 逻辑，按 `customs_no + factory_code + brand` 聚合后输出 `invoice_gap_factories` 或 `brand_groups`。不要把品牌规则写死在前端。
6. 补孤票提示：可新增 `orphan_candidate_count`，查询 `finance_invoices_in` 中 `contract_nos` 为空、卖方匹配当前工厂、金额接近当前行/品牌组应开金额的数量；具体建议仍让前端调用 `invoice-orphan-match` 展开。
7. `handleDetail()` 已能按 `customs_no/contract_no/bl_no` 找订单并生成发票模板，见 `api/db/customs-collab.js:766-915`。可把 `invoice_template.order_no` 作为发链接的候选来源之一，但正式发链接仍应基于 list 的 `order_nos`。

### 5.2 `api/db/invoice-portal.js`

当前 `invoice-portal` 是订单级：

- `GET ?action=gen&order_no=X` 签发链接，见 `api/db/invoice-portal.js:38-49`。
- 门户 GET 根据 `order_no` 查订单、工厂、买方、报关明细，见 `api/db/invoice-portal.js:54-86`。
- 上传发票写入 `finance_invoices_in`，设置 `seller_company_code/factory_id/contract_nos/source/review_status`，见 `api/db/invoice-portal.js:89-113`。

合并第一期无需改它。`customs-collab` 前端拿到 `order_nos` 后逐个调用 `action=gen` 即可。需要注意：`invoice-portal` 上传只写 `contract_nos`，不写 `customs_nos`，也不写 `invoice_customs_links`。这正是当前两边差异的来源之一。合并后应让 `customs-collab` 的 `received_amount` 能识别这类票；如果财务确认后需要归档到报关单，再由孤票配对/人工绑定写 `invoice_customs_links`。

### 5.3 `api/db/invoice-orphan-match.js`

文件存在但未挂载；`server.js` 里只有 `factory-invoice-reconcile/customs-collab/invoice-portal/tax-rebate` 等挂载，未见 `/api/db/invoice-orphan-match`。`invoice-orphan-match.js:1-3` 也只是“mount建议”。

当前能力：

- `GET action=suggestions`：找 `finance_invoices_in` 中 `contract_nos` 为空的孤票，按卖方和金额与订单合同应开金额匹配，见 `api/db/invoice-orphan-match.js:197-240`。
- `POST action=bind`：把孤票绑定到 `finance_invoices_in.contract_nos`，不覆盖已有合同，见 `api/db/invoice-orphan-match.js:243-292`。
- `POST action=reconcile`：对已绑定进项票按合同金额更新 `review_status`，见 `api/db/invoice-orphan-match.js:294-336`。

合并前必须先在 `server.js` 挂载端点；否则前端入口不可用。第二期可增强 `bind`：除了写 `contract_nos`，在传入 `customs_no` 时同步插入 `invoice_customs_links`，这样 `linked_amount` 与 `received_amount` 会收敛。第一期不要把这套建议算法复制到 `customs-collab.js`。

### 5.4 `api/db/tax-rebate-invoice-gap.js`

这是另一协同会话维护的数据层，合并涉及它必须标为跨线依赖，不应在本次前端合并中擅改。可复用思路/SQL，但不要直接改字段契约：

- 契约字段在文件头写明 `invoice_due_amount / invoice_received_amount / invoice_gap / invoice_gap_factories` 不可改名，见 `api/db/tax-rebate-invoice-gap.js:1-4`。
- 品牌/OEM 规则已在此实现，见 `api/db/tax-rebate-invoice-gap.js:35-56`、`api/db/tax-rebate-invoice-gap.js:89-97`。

### 5.5 `api/db/factory-invoice-reconcile.js`

不作为合并目标，但它有一个值得借鉴的已开票口径：`seller_company_code = factory_code` + `contract_nos/customs_nos` 数组相交，见 `api/db/factory-invoice-reconcile.js:268-285`。这比 `tax-rebate` 的 `::text ILIKE` 更安全。合并后的 `received_amount` 建议采用这个方向，并对历史非数组/旧票做兼容。

## 6. 前端与菜单退役

### 6.1 当前工作树可见前端

`public/customs-collab-factory.html` 是工厂端协同页，使用 `/api/db/customs-collab`：

- `factory_list`：见 `public/customs-collab-factory.html:118-121`。
- 上传发票：`action=upload`，见 `public/customs-collab-factory.html:123-127`。
- 上传水单：`action=upload_slip`，见 `public/customs-collab-factory.html:129-139`。
- 开票模板详情：`action=detail`，见 `public/customs-collab-factory.html:178-188`。

`public/factory-invoice-reconcile.html` 是工厂开票对账页，调用 `/api/db/factory-invoice-reconcile`。

本工作树未找到 `CustomsCollabModule.jsx`、`InvoiceChasingModule.jsx`、`OrphanInvoicePanel.jsx`。因此具体 React 组件迁移应在前端仓库/分支补充调研。本文后续以 API 和模块职责给迁移清单。

### 6.2 要搬到 `CustomsCollabModule` 的能力

1. 列表每行增加“未开票处理”按钮组：发链接、孤票配对、品牌标注、催办状态。
2. “发链接”调用 `/api/db/invoice-portal?action=gen&order_no=...`，若 `order_nos` 多个则弹出订单列表。
3. “孤票配对”入口调用 `/api/db/invoice-orphan-match?action=suggestions`，按当前行 `factory_code/contract_no/customs_no` 前端过滤；绑定调用 `POST action=bind`。
4. 品牌标注显示 `brand_groups` 或 `invoice_gap_factories`，支持 `is_own_brand` 标签。
5. 催办位展示：`未发链接 / 已发链接 / 已收部分 / 缺口异常 / 已核对`，数据来自 `last_sent_at + received_amount + diff_amount + manual_confirm_status`。

### 6.3 催票页退役条件

只有以下能力全部搬完，才能下线 `InvoiceChasingModule` 菜单项 `id=invoice_chasing`：

- 报关单维度能看到 `expected_invoice_amount/received_amount/diff_amount`，且金额与 `tax-rebate-invoice-gap` 在同一范围内可解释。
- 能从每行发开票链接，并能看到链接已发/最近发送时间。
- 能进入孤票配对，至少支持 suggestions + bind。
- 能展示品牌/OEM 子组，尤其是中宠自有品牌/OEM。
- `tax-rebate` 的退税状态、资料状态、品名行发票映射仍有入口或被其它退税页面承接。

不能删除的后端：

- `/api/db/tax-rebate`：仍服务退税月份、退税状态、品名行映射、资料状态；不能因催票页退役而删。
- `/api/db/tax-rebate/*`：`tax-rebate-links.js` 是进项票×退税单 N:M 分配，见 `server.js:612-618`；不能删。
- `tax-rebate-invoice-gap.js`：数据层跨线依赖，字段契约不可随意改。

菜单下线建议：

1. 第一阶段隐藏 `invoice_chasing` 主菜单，但保留路由直达和灰度开关。
2. 第二阶段在旧页面顶部提示“已迁移到报关单开票协同”，保留只读 2 周。
3. 第三阶段删除菜单注册和前端组件，不删除 `tax-rebate` API。

## 7. 迁移步骤

### 阶段 1：口径影子对账

1. 在有库环境执行第 3.4 节 SQL，输出 4-6 月三张表：`customs_linked`、`tax_received`、`tax_hit_not_linked`。
2. 确认 403 万差额中有多少来自“未显式 `invoice_customs_links` 绑定”的进项票。
3. 确认 `customs-collab` 28 张与 `finance_export_rebates` 4-6 月报关单总数差异，列出 missing customs_no。
4. 决策：正式范围是否以 `finance_export_rebates` 为准。建议以它为准。

### 阶段 2：后端灰度补字段

只扩展 `customs-collab?action=list/detail` 返回字段，不改旧字段含义：

- `order_nos`
- `expected_invoice_amount`
- `declaration_amount`
- `received_amount`
- `linked_amount`
- `brand_groups` 或 `invoice_gap_factories`
- `portal_link_status`
- `orphan_candidate_count`

旧前端继续读 `effective_expected_amount/uploaded_amount/diff_amount`，新前端灰度读新字段。

### 阶段 3：接入现成端点

1. 挂载 `/api/db/invoice-orphan-match`。
2. `CustomsCollabModule` 增加发链接入口，调用 `invoice-portal?action=gen`。
3. 增加孤票配对 Drawer，调用 `invoice-orphan-match`。
4. 增加品牌/OEM 展示和筛选。

### 阶段 4：口径切换

1. KPI 卡片“差额/未开票缺口”切到 `expected_invoice_amount - received_amount`。
2. 原 `uploaded_amount` 改文案为“已归档/已绑定”，避免误解为真实已收票。
3. `manual_confirm_status` 保留为人工流程，不作为金额事实。

### 阶段 5：催票页退役

1. 灰度隐藏菜单 `invoice_chasing`。
2. 观察一轮月度对账，确认没有用户仍依赖旧页独有能力。
3. 删除前端菜单和组件；保留 `/api/db/tax-rebate` 和数据层。

## 8. 回滚方案

- 后端补字段是新增字段，前端可随时回滚读取旧字段。
- `invoice-orphan-match` 挂载可保留；若有问题，只隐藏前端入口。
- 发链接继续走既有 `invoice-portal`，不改变上传链路；若合并 UI 出问题，工厂仍可用旧链接上传。
- 菜单隐藏采用配置开关；发现催票能力遗漏时恢复 `invoice_chasing` 菜单即可。
- 不删除 `tax-rebate` API，因此退税板块可独立运行。

## 9. 决策点

1. `customs-collab` 的 28 张 vs 催票 4-6 月范围：建议以 `finance_export_rebates.export_date` 的报关单为正式范围，订单兜底行单列。
2. 应开金额：建议未开票缺口用 `order_line_items.factory_subtotal`；报关金额保留为对照字段。
3. 已开/已收金额：建议事实口径用 `finance_invoices_in` 主体 + 合同/报关号匹配；显式绑定单独展示。
4. 历史 confirm 状态：建议保留，改名为“人工已确认/待开票”，不参与金额抵扣。
5. `invoice_customs_links` 是否批量回填：建议先影子比对，再只对高置信合同/报关号一一对应的票回填；多合同、多报关号必须人工确认。
6. `tax-rebate-invoice-gap` 是否改口径：这是跨线依赖，不在本合并中擅改；若要改，单独开数据层任务。
7. 中宠自有品牌/OEM：当前代码使用 `company_own_brands` + `oli.brand/p.brand`，但历史订单缺 brand 时如何归类，需要业务确认。

## 10. 最小可执行任务清单

1. 执行核验 SQL，确认 403 万与 145 万差异构成。
2. `customs-collab?action=list` 新增字段，不改变旧字段。
3. 挂载 `invoice-orphan-match`。
4. `CustomsCollabModule` 每行接入发链接、孤票配对、品牌/OEM、催办状态。
5. KPI 切到新口径：应开 = 工厂含税小计；已收 = 真实进项票；绑定 = 归档状态。
6. 灰度隐藏 `invoice_chasing` 菜单，保留 `tax-rebate` API。
