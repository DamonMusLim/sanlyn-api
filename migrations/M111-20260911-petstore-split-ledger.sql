BEGIN;

-- 因为历史订单必须按当时规则追溯,所以规则表只追加版本,不覆盖旧口径。
CREATE TABLE IF NOT EXISTS petstore_store_settle_rule (
  id bigserial,
  store_code text NOT NULL,
  settle_entity_name text NOT NULL,
  entity_type text NOT NULL,
  merchant_no text,
  platform_fee_mode text NOT NULL DEFAULT 'none',
  platform_fee_rate_bp int NOT NULL DEFAULT 0,
  platform_fee_fixed_fen int NOT NULL DEFAULT 0,
  freight_bearer text NOT NULL DEFAULT 'store',
  effective_from date NOT NULL,
  effective_to date,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 因为每条规则必须有稳定身份,便于订单快照追溯到具体版本。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pk_petstore_store_settle_rule'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT pk_petstore_store_settle_rule PRIMARY KEY (id);
  END IF;
END $$;

-- 因为同一天同一门店只能启用一版规则,否则历史订单无法确定口径。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_petstore_store_settle_rule_store_effective_from'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT uq_petstore_store_settle_rule_store_effective_from
      UNIQUE (store_code, effective_from);
  END IF;
END $$;

-- 因为门店结算规则必须绑定真实门店,避免孤立规则进入账本。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_petstore_store_settle_rule_store'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT fk_petstore_store_settle_rule_store
      FOREIGN KEY (store_code) REFERENCES petstore_stores(code);
  END IF;
END $$;

-- 因为主体类型影响合规判断,只能使用约定枚举值。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_entity_type'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_entity_type
      CHECK (entity_type IN ('own', 'branch', 'independent'));
  END IF;
END $$;

-- 因为平台服务费只能按约定模式计算,不能出现代码无法解释的模式。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_platform_fee_mode'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_platform_fee_mode
      CHECK (platform_fee_mode IN ('none', 'rate', 'fixed'));
  END IF;
END $$;

-- 因为比例费率用整数基点保存,且不能超过订单金额的百分之百。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_platform_fee_rate_bp'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_platform_fee_rate_bp
      CHECK (platform_fee_rate_bp BETWEEN 0 AND 10000);
  END IF;
END $$;

-- 因为固定服务费以分为单位保存,负数会把平台留存变成补贴。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_platform_fee_fixed_fen'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_platform_fee_fixed_fen
      CHECK (platform_fee_fixed_fen >= 0);
  END IF;
END $$;

-- 因为运费归属会影响分账金额,只能落在明确的两种口径内。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_freight_bearer'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_freight_bearer
      CHECK (freight_bearer IN ('store', 'platform'));
  END IF;
END $$;

-- 因为结束日期早于开始日期会制造无法成立的历史区间。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_store_settle_rule_effective_range'
       AND conrelid = 'petstore_store_settle_rule'::regclass
  ) THEN
    ALTER TABLE petstore_store_settle_rule
      ADD CONSTRAINT ck_petstore_store_settle_rule_effective_range
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_settle_rule_one_open_per_store
  ON petstore_store_settle_rule (store_code)
  WHERE effective_to IS NULL;

-- 区间重叠 = 同一天命中两套费率 = 这单该分多少算不出来,必须在写入时就挡住。
CREATE OR REPLACE FUNCTION petstore_settle_rule_no_overlap() RETURNS trigger AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM petstore_store_settle_rule r
     WHERE r.store_code = NEW.store_code
       AND r.id IS DISTINCT FROM NEW.id
       AND r.effective_from <> NEW.effective_from
       AND daterange(r.effective_from, COALESCE(r.effective_to, 'infinity'::date), '[]')
        && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '门店 % 的结算规则生效区间与已有版本重叠(% ~ %)',
      NEW.store_code, NEW.effective_from, COALESCE(NEW.effective_to::text,'至今');
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settle_rule_no_overlap ON petstore_store_settle_rule;
CREATE TRIGGER trg_settle_rule_no_overlap
  BEFORE INSERT OR UPDATE ON petstore_store_settle_rule
  FOR EACH ROW EXECUTE FUNCTION petstore_settle_rule_no_overlap();

CREATE INDEX IF NOT EXISTS idx_petstore_store_settle_rule_store_effective_from
  ON petstore_store_settle_rule (store_code, effective_from DESC);

-- 因为每单生成后必须固定快照,主体改名、调费率、改商品价都不能反写历史。
CREATE TABLE IF NOT EXISTS petstore_order_settlement (
  order_id bigint,
  store_code text NOT NULL,
  settle_entity_name text NOT NULL,
  merchant_no text,
  rule_id bigint,
  basis_fen int NOT NULL,
  goods_fen int NOT NULL,
  freight_fen int NOT NULL,
  platform_fee_fen int NOT NULL,
  store_amount_fen int NOT NULL,
  refund_fen int NOT NULL DEFAULT 0,
  refund_platform_fen int NOT NULL DEFAULT 0,
  refund_store_fen int NOT NULL DEFAULT 0,
  order_paid_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  settled_at timestamptz,
  settle_txn_no text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE petstore_order_settlement
  ADD COLUMN IF NOT EXISTS refund_platform_fen int NOT NULL DEFAULT 0;

ALTER TABLE petstore_order_settlement
  ADD COLUMN IF NOT EXISTS refund_store_fen int NOT NULL DEFAULT 0;

ALTER TABLE petstore_order_settlement
  ADD COLUMN IF NOT EXISTS order_paid_at timestamptz;

-- 因为一张订单只能有一条分账快照,避免重复入账。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pk_petstore_order_settlement'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT pk_petstore_order_settlement PRIMARY KEY (order_id);
  END IF;
END $$;

-- 因为分账快照必须来自真实订单,账本不能凭空生成单据。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_petstore_order_settlement_order'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT fk_petstore_order_settlement_order
      FOREIGN KEY (order_id) REFERENCES petstore_shop_order(id);
  END IF;
END $$;

-- 因为快照需要能追溯到当时命中的规则版本。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_petstore_order_settlement_rule'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT fk_petstore_order_settlement_rule
      FOREIGN KEY (rule_id) REFERENCES petstore_store_settle_rule(id);
  END IF;
END $$;

-- 因为结算状态必须可对账,不能出现自由文本导致统计漏算。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_status'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_status
      CHECK (status IN ('pending', 'settled', 'void'));
  END IF;
END $$;

-- 因为平台留存加门店应分必须等于实收基数,分不平不能入账。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_split_balance'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_split_balance
      CHECK (platform_fee_fen + store_amount_fen = basis_fen);
  END IF;
END $$;

-- 因为订单实收基数必须等于货款加运费快照,防止金额来源不一致。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_basis_balance'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_basis_balance
      CHECK (goods_fen + freight_fen = basis_fen);
  END IF;
END $$;

-- 因为分账金额不能为负,否则会变成反向付款口径。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_non_negative_split'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_non_negative_split
      CHECK (platform_fee_fen >= 0 AND store_amount_fen >= 0);
  END IF;
END $$;

-- 因为退款不能小于零,也不能超过订单实收基数。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_refund_range'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_refund_range
      CHECK (refund_fen >= 0 AND refund_fen <= basis_fen);
  END IF;
END $$;

-- 因为退款拆分必须使用当时快照,不能在视图里按后来规则重算。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_refund_split_non_negative'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_refund_split_non_negative
      CHECK (refund_platform_fen >= 0 AND refund_store_fen >= 0);
  END IF;
END $$;

-- 因为退款拆分必须与总退款金额打平,否则会少结或多结。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_refund_split_balance'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_refund_split_balance
      CHECK (refund_platform_fen + refund_store_fen = refund_fen);
  END IF;
END $$;

-- 因为账本基数来自订单实收,不能保存负数金额。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_petstore_order_settlement_basis_non_negative'
       AND conrelid = 'petstore_order_settlement'::regclass
  ) THEN
    ALTER TABLE petstore_order_settlement
      ADD CONSTRAINT ck_petstore_order_settlement_basis_non_negative
      CHECK (basis_fen >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_petstore_order_settlement_store_status
  ON petstore_order_settlement (store_code, status);

CREATE INDEX IF NOT EXISTS idx_petstore_order_settlement_status_computed_at
  ON petstore_order_settlement (status, computed_at);

CREATE OR REPLACE VIEW v_petstore_settle_recon AS
SELECT
  store_code,
  settle_entity_name,
  (COALESCE(order_paid_at, computed_at) AT TIME ZONE 'Asia/Shanghai')::date AS settle_date,
  count(*) FILTER (WHERE status <> 'void')::bigint AS order_count,
  COALESCE(sum(basis_fen) FILTER (WHERE status <> 'void'), 0)::bigint AS basis_fen,
  COALESCE(sum(platform_fee_fen) FILTER (WHERE status <> 'void'), 0)::bigint AS platform_fee_fen,
  COALESCE(sum(store_amount_fen) FILTER (WHERE status <> 'void'), 0)::bigint AS store_amount_fen,
  COALESCE(sum(refund_fen) FILTER (WHERE status <> 'void'), 0)::bigint AS refund_fen,
  COALESCE(sum(store_amount_fen - refund_store_fen) FILTER (WHERE status <> 'void'), 0)::bigint AS net_store_amount_fen,
  count(*) FILTER (WHERE status = 'settled')::bigint AS settled_order_count,
  COALESCE(sum(store_amount_fen - refund_store_fen) FILTER (WHERE status = 'settled'), 0)::bigint AS settled_amount_fen,
  COALESCE(sum(store_amount_fen - refund_store_fen) FILTER (WHERE status = 'pending'), 0)::bigint AS pending_amount_fen
FROM petstore_order_settlement
GROUP BY
  store_code,
  settle_entity_name,
  (COALESCE(order_paid_at, computed_at) AT TIME ZONE 'Asia/Shanghai')::date;

INSERT INTO petstore_store_settle_rule (
  store_code,
  settle_entity_name,
  entity_type,
  merchant_no,
  platform_fee_mode,
  platform_fee_rate_bp,
  platform_fee_fixed_fen,
  freight_bearer,
  effective_from,
  note
)
VALUES (
  '63350001',
  '(待补:金枋店结算主体全称)',
  'own',
  NULL,
  'none',
  0,
  0,
  'store',
  '2026-01-01',
  '自营店,不抽平台服务费。结算主体全称待补。'
)
ON CONFLICT (store_code, effective_from) DO NOTHING;

COMMENT ON TABLE petstore_store_settle_rule IS '门店结算主体与分账规则版本表: 只记录数据口径,不保存银行卡号,历史订单按生效期追溯。';
COMMENT ON COLUMN petstore_store_settle_rule.store_code IS '门店编码,对应 petstore_stores.code。';
COMMENT ON COLUMN petstore_store_settle_rule.settle_entity_name IS '结算主体全称快照来源,用于确认应结给哪个法律主体。';
COMMENT ON COLUMN petstore_store_settle_rule.entity_type IS '主体类型: own 自营, branch 分公司, independent 独立主体。';
COMMENT ON COLUMN petstore_store_settle_rule.merchant_no IS '收单商户号,卡号和账户信息只保存在持牌机构侧。';
COMMENT ON COLUMN petstore_store_settle_rule.platform_fee_mode IS '平台服务费模式: none 不抽, rate 按比例, fixed 固定。';
COMMENT ON COLUMN petstore_store_settle_rule.platform_fee_rate_bp IS '平台服务费比例,整数基点,不用浮点数存钱。';
COMMENT ON COLUMN petstore_store_settle_rule.platform_fee_fixed_fen IS '固定平台服务费,单位分。';
COMMENT ON COLUMN petstore_store_settle_rule.freight_bearer IS '运费归属口径: store 门店, platform 平台。';
COMMENT ON COLUMN petstore_store_settle_rule.effective_from IS '规则生效开始日期,用于锁定历史订单口径。';
COMMENT ON COLUMN petstore_store_settle_rule.effective_to IS '规则生效结束日期,含当天,NULL 表示仍有效。';

COMMENT ON TABLE petstore_order_settlement IS '每单应分账快照表: 系统只记账本数据,不经手资金,不保存银行卡号。';
COMMENT ON COLUMN petstore_order_settlement.order_id IS '订单 ID,一单一条分账快照。';
COMMENT ON COLUMN petstore_order_settlement.store_code IS '订单所属门店编码快照。';
COMMENT ON COLUMN petstore_order_settlement.settle_entity_name IS '结算主体名称快照,主体后续改名不影响历史。';
COMMENT ON COLUMN petstore_order_settlement.merchant_no IS '订单计算时命中的收单商户号快照,不包含银行卡号。';
COMMENT ON COLUMN petstore_order_settlement.rule_id IS '订单计算时使用的规则版本 ID。';
COMMENT ON COLUMN petstore_order_settlement.basis_fen IS '分账基数,订单实收 pay_fen 快照,单位分。';
COMMENT ON COLUMN petstore_order_settlement.goods_fen IS '货款 total_fen 快照,单位分。';
COMMENT ON COLUMN petstore_order_settlement.freight_fen IS '运费 freight_fen 快照,单位分。';
COMMENT ON COLUMN petstore_order_settlement.platform_fee_fen IS '平台留存金额,单位分。';
COMMENT ON COLUMN petstore_order_settlement.store_amount_fen IS '应分给门店金额,单位分。';
COMMENT ON COLUMN petstore_order_settlement.refund_fen IS '已退款金额快照,单位分。';
COMMENT ON COLUMN petstore_order_settlement.refund_platform_fen IS '退款中平台承担的部分。按比例拆分时若 basis_fen 为 0 必须直接记 0,不许除零; 两部分之和必须等于 refund_fen(有约束兜底)。';
COMMENT ON COLUMN petstore_order_settlement.refund_store_fen IS '退款中门店承担的部分,单位分。';
COMMENT ON COLUMN petstore_order_settlement.order_paid_at IS '订单实际付款时间 paid_at 快照,用于按业务发生日期对账。';
COMMENT ON COLUMN petstore_order_settlement.status IS '结算状态: pending 待结算, settled 已到账, void 订单作废。';
COMMENT ON COLUMN petstore_order_settlement.settle_txn_no IS '银行分账回执号,以后接银行时回填。';
COMMENT ON CONSTRAINT ck_petstore_order_settlement_split_balance ON petstore_order_settlement IS '确保平台留存与门店应分之和等于订单实收基数。';
COMMENT ON CONSTRAINT ck_petstore_order_settlement_basis_balance ON petstore_order_settlement IS '确保货款与运费之和等于订单实收基数。';

COMMIT;
