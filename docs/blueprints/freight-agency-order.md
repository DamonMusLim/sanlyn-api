# Freight Agency 代运订单 · 蓝图 v0.1
> 状态：框架冻结，待 Procurement 流程稳定后实施
> 起草日期：2026-05-02

---

## 背景与场景

### 典型客户：福新 (FX) · SNIFFLY 品牌
- 有自己的产品（SNIFFLY 猫粮系列）
- **没有报关人员**，出口流程全靠 Sanlyn 代理
- 愿意用 Sanlyn 系统录货物信息
- Sanlyn 帮他们做：报关 + 订舱 + 出口 + BL

### 另一类：爱舒乐 (AS) · 不愿给资料
- 只让 Sanlyn 跑船，不共享产品数据
- 报关信息最少化（品名/重量/HS 够用就行）
- 不进产品主数据库

---

## 两种子模式

| 模式 | 典型客户 | 资料完整度 | 系统配合度 |
|------|----------|----------|----------|
| `agency_full` | 福新 FX | 完整（愿意录） | 高，主动用系统 |
| `agency_lite` | 爱舒乐 AS | 最小化 | 低，只给必要字段 |

---

## 与现有 Procurement 的区别

| | Procurement | Freight Agency |
|--|-------------|----------------|
| 工厂绑定 | 必须绑定 products 表工厂 | 填供货商名字（文本，不进主数据） |
| 选品 | 从产品库选 SKU | 自由填写货物描述 |
| 定价 | 出厂价 + Sanlyn 加价 | 无产品价格，只有运费/代理费 |
| 单据流 | PI → SC → IV → PL → BL | 直接 BL + 报关单（跳过 PI/SC） |
| 利润 | 产品差价 + 运费 | 纯代理费 / 海运费 |
| 产品图 | 需要 | 不需要 |

---

## 前端改动（OrderCreateV3）

### Step 1 新增 Order Type 选择
```
○ Procurement     — 采购出口（现有流程）
● Freight Agency  — 代运出口（新增）
    ├── Full Mode  — 客户配合录系统（福新）
    └── Lite Mode  — 最小化录入（爱舒乐）
```

选 Freight Agency 后：
- 工厂选择 → 改为「供货商」文本输入（不关联 factories 表）
- 右侧 Buyer 卡片新增「代理服务」标签

### Step 3 Container 改动
- 不显示「产品库」选品入口
- 改为自由填写货物行：
  ```
  货物描述 | HS Code | 件数 | GW(KG) | CBM | 备注
  ```
- Full Mode：多行，可逐行录
- Lite Mode：只填总重 + 总 CBM + 一行货描

---

## 后端改动

### orders 表新增字段
```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS
  order_type VARCHAR(20) DEFAULT 'procurement'
  CHECK (order_type IN ('procurement', 'agency_full', 'agency_lite'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS
  agency_supplier VARCHAR(200);  -- 供货商名字（文本，不关联 factories）

ALTER TABLE orders ADD COLUMN IF NOT EXISTS
  agency_cargo JSONB DEFAULT '[]';
  -- [{desc, hs_code, pkgs, gw_kg, cbm, note}]
```

### 报关逻辑
- Procurement：从 products 表取 declaration_name / hs_code（现有逻辑）
- Agency：从 `agency_cargo[]` 取，Sanlyn 人工核对后确认

---

## 福新 (FX) 专项价值
- 福新没报关人员 → Sanlyn 是他们唯一出口通道
- Full Mode 让福新在系统里自己填货物信息
- Sanlyn 审核后直接出单（报关单 / BL）
- 对福新：**替代他们招报关专员的成本**
- 对 Sanlyn：**稳定的代理费收入 + 粘性**

---

## 实施前提
- [ ] Procurement 流程 Step 1-3 完全稳定上线
- [ ] 福新工厂端账号注册（factory portal V3 已有入口）
- [ ] 代理费计费规则确认（按票？按重量？按 CBM？）

---

## API 预留
```
POST /api/db/order-create-v2   body.order_type = 'agency_full' | 'agency_lite'
                               body.agency_supplier = '福新实业'
                               body.agency_cargo = [{...}]
```
现有 order-create-v2 加字段兼容，不新建表。

