# BOM 成本联动预警系统 · 蓝图 v0.1
> 状态：框架冻结，待产品供货商信息完整率 >80% 后实施
> 起草日期：2026-05-02
> 预计实施：~2026 Q4

---

## 背景
- 3000+ SKU，原材料/海运费波动频繁
- 手动改价效率极低，容易漏发客户
- 目标：原材料涨价 → 系统自动算出影响产品 → 推送预警 → Sanlyn 确认 → 发客户

---

## 数据模型（待建表）

### `raw_materials` 原材料价格表
```sql
CREATE TABLE raw_materials (
  id          VARCHAR(50) PRIMARY KEY,   -- e.g. "chicken-meat"
  name        VARCHAR(100) NOT NULL,     -- 鸡肉
  name_en     VARCHAR(100),
  unit        VARCHAR(20) DEFAULT 'KG',
  price       NUMERIC(10,4) NOT NULL,    -- 当前单价
  currency    VARCHAR(10) DEFAULT 'CNY',
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  VARCHAR(100),
  notes       TEXT
);
```

### `product_bom` 品类级 BOM（Phase 1 用品类打标，不做 SKU 级）
```sql
CREATE TABLE product_bom (
  id              SERIAL PRIMARY KEY,
  scope           VARCHAR(20) NOT NULL CHECK (scope IN ('sku','category','brand')),
  scope_value     VARCHAR(100) NOT NULL,  -- e.g. 'CA-03H' / 'treat' / 'WANPY'
  material_id     VARCHAR(50) REFERENCES raw_materials(id),
  ratio           NUMERIC(5,4) NOT NULL,  -- 成本占比 e.g. 0.65 = 65%
  notes           TEXT
);
-- 例：treat 品类 → 鸡肉 60% + 包材 15% + 其他 25%
```

### `cost_alerts` 成本预警记录
```sql
CREATE TABLE cost_alerts (
  id              SERIAL PRIMARY KEY,
  triggered_by    VARCHAR(50),            -- 哪个原材料涨价触发
  affected_skus   TEXT[],                 -- 受影响的 SKU 列表
  old_cost_est    NUMERIC(10,4),
  new_cost_est    NUMERIC(10,4),
  delta_pct       NUMERIC(6,2),           -- 涨幅 %
  status          VARCHAR(20) DEFAULT 'pending',  -- pending/reviewed/sent/dismissed
  reviewed_by     VARCHAR(100),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 核心逻辑（伪代码）

```
触发条件：PATCH /api/db/raw-materials/:id  （更新原材料价格）

1. 找到所有引用该原材料的 BOM 记录（scope: sku/category/brand）
2. 展开受影响的 SKU 列表
3. 对每个 SKU：
   new_cost = SUM(material.price × bom.ratio)
   if new_cost > product.factory_price × 0.90:  ← 阈值可配置
     → 写入 cost_alerts
4. 企微/邮件推送给 Sanlyn：
   "⚠ 鸡肉涨价 12%，影响 143 个 SKU，建议调价"
5. Sanlyn 在 AdminPanel 审核 → 一键生成新报价 → 发客户
```

---

## 实施分阶段

### Phase 1（数据就绪后，约 3-4 天）
- [ ] 建 `raw_materials` 表 + CRUD API
- [ ] 建 `product_bom` 表，按**品类**打标（treat/dry/wet × 鸡/鸭/羊/鱼）
- [ ] 价格更新触发重算 + cost_alerts 写入
- [ ] 企微推送预警消息
- [ ] AdminPanel 预警 Dashboard（看哪些 SKU 超阈值）

### Phase 2（成熟后）
- [ ] SKU 级精确 BOM（工厂端录入）
- [ ] 海运费指数接入（上海出口集装箱运价指数 SCFI）
- [ ] 自动生成客户报价单 PDF，一键发邮件
- [ ] 历史涨价记录 + 价格趋势图

---

## 前置条件（实施前必须满足）
- [ ] `products` 表 `factory_code` 完整率 > 80%
- [ ] 供货商联系信息完整（用于通知工厂确认）
- [ ] 各品类主要原材料已梳理（鸡/鸭/羊/牛/鱼/甘薯/包材）

---

## API 设计（预留）
```
GET    /api/db/raw-materials          列出原材料价格
POST   /api/db/raw-materials          新增
PATCH  /api/db/raw-materials          更新价格（触发重算）
GET    /api/db/cost-alerts            预警列表
PATCH  /api/db/cost-alerts            审核（reviewed/sent/dismissed）
POST   /api/db/cost-alerts/send       发送报价给客户
```

---

## 备注
- Phase 1 品类级 BOM 误差约 ±10%，够用于预警，不适合精确报价
- 原材料价格来源：工厂反馈 / 行业指数 / 手动录入（初期）
- 海运费可接入：上海航运交易所 SCFI（有公开 API）
