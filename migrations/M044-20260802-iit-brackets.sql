-- M044 · 个人所得税：综合所得年度税率表（七级超额累进）
--
-- 来源：从简道云「薪酬管理 → 个人所得税税率表」核对拉过来（2026-08-02）。
-- ⚠️ 简道云那套 HR 应用里绝大多数是模版样例数据（员工档案是杭州假人、五险一金只有杭州苏州），
--    **只有这张税率表是真能用的** —— 全国统一、七级、速算扣除数正确，所以只搬这一张。
--
-- 口径：居民个人综合所得，按纳税年度合并计算，适用《个人所得税法》税率表一。
--   应纳税额 = 应纳税所得额 × 税率 − 速算扣除数
--   应纳税所得额 = 年收入 − 60000(基本减除) − 专项扣除(社保医保) − 专项附加扣除 − 依法确定的其他扣除
-- 月度预扣预缴用「累计预扣法」，套的是同一张表（累计应纳税所得额进表），所以这张表够用，不另建月表。

CREATE TABLE IF NOT EXISTS hr_tax_brackets (
  id            SERIAL PRIMARY KEY,
  scheme        TEXT    NOT NULL DEFAULT 'resident_comprehensive_annual', -- 留口子:以后可能加经营所得/年终奖单独计税
  level         INT     NOT NULL,          -- 级数 1..7
  lower_bound   NUMERIC(14,2) NOT NULL,    -- 含
  upper_bound   NUMERIC(14,2),             -- 不含; NULL = 无上限
  rate          NUMERIC(6,4)  NOT NULL,    -- 0.0300 = 3%
  quick_deduct  NUMERIC(14,2) NOT NULL,    -- 速算扣除数
  effective_from DATE   NOT NULL DEFAULT '2019-01-01',
  effective_to   DATE,                     -- NULL = 现行
  source        TEXT,
  UNIQUE (scheme, level, effective_from)
);

COMMENT ON TABLE hr_tax_brackets IS '个税税率表(七级超额累进)。改税率=新增一行带新的 effective_from,别就地改老行,否则历史工资条重算会错。';

INSERT INTO hr_tax_brackets (level, lower_bound, upper_bound, rate, quick_deduct, source) VALUES
  (1,      0.00,   36000.00, 0.0300,      0.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (2,  36000.00,  144000.00, 0.1000,   2520.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (3, 144000.00,  300000.00, 0.2000,  16920.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (4, 300000.00,  420000.00, 0.2500,  31920.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (5, 420000.00,  660000.00, 0.3000,  52920.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (6, 660000.00,  960000.00, 0.3500,  85920.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一'),
  (7, 960000.00,       NULL, 0.4500, 181920.00, 'jdy:个人所得税税率表 / 个人所得税法 税率表一')
ON CONFLICT (scheme, level, effective_from) DO NOTHING;

-- 五险一金比例：简道云那张只有杭州和苏州，**没有厦门**，所以不搬数据、只留结构等真值。
-- 厦门比例要以厦门社保局/公积金中心当期公告为准，人工填了再用；空表 = 显缺,不猜。
CREATE TABLE IF NOT EXISTS hr_insurance_rates (
  id             SERIAL PRIMARY KEY,
  city           TEXT NOT NULL,
  scope          TEXT,                       -- 如「厦门市本级·城镇职工」
  item           TEXT NOT NULL,              -- 养老/失业/医疗/工伤/生育/公积金
  employer_rate  NUMERIC(6,4),
  employee_rate  NUMERIC(6,4),
  base_min       NUMERIC(12,2),
  base_max       NUMERIC(12,2),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  source         TEXT,
  UNIQUE (city, scope, item, effective_from)
);

COMMENT ON TABLE hr_insurance_rates IS '五险一金缴纳比例。厦门数据待人工核实后填入 —— 空着就是「还没有」,算工资时缺这张就报错,不许拿别的城市顶。';
