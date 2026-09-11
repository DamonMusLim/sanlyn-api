BEGIN;

CREATE TABLE IF NOT EXISTS petstore_price_observation (
  obs_date date NOT NULL,
  store_code text NOT NULL,
  product_code text NOT NULL,
  product_name text NOT NULL DEFAULT '',
  spec text NOT NULL DEFAULT '',
  barcode text,
  price_fen integer NOT NULL,
  in_stock boolean NOT NULL DEFAULT false,
  collected_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE petstore_price_observation IS
'三家宠物店公开售价学习库：只存商品名、条码、规格、售价、库存有无等公开层字段；不存进价、供应商、销量、毛利或接口原始包，避免保存其他公司经营层商业秘密。';
COMMENT ON COLUMN petstore_price_observation.obs_date IS '采集日，按 Asia/Shanghai 口径生成，用于每日售价快照。';
COMMENT ON COLUMN petstore_price_observation.store_code IS '门店白名单编码：63350001金枋、63350002万科里、63350003小树林，只允许这三家进入学习库。';
COMMENT ON COLUMN petstore_price_observation.product_code IS '果冻橙 productCode，同一门店内商品快照主键的一部分。';
COMMENT ON COLUMN petstore_price_observation.product_name IS '公开商品名，来自货架或线上页面可见信息。';
COMMENT ON COLUMN petstore_price_observation.spec IS '公开规格，来自包装或线上页面可见信息。';
COMMENT ON COLUMN petstore_price_observation.barcode IS 'upcCode，可空；用于跨店归一化对齐的公开天然键。';
COMMENT ON COLUMN petstore_price_observation.price_fen IS '公开售价，单位分；钱不用 numeric/float，避免精度问题。';
COMMENT ON COLUMN petstore_price_observation.in_stock IS '只记录是否有货，不记录具体库存数，避免进入经营层数据。';
COMMENT ON COLUMN petstore_price_observation.collected_at IS '采集落库时间。';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'petstore_price_observation_pkey'
      AND conrelid = 'petstore_price_observation'::regclass
  ) THEN
    ALTER TABLE petstore_price_observation
      ADD CONSTRAINT petstore_price_observation_pkey
      PRIMARY KEY (obs_date, store_code, product_code);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'petstore_price_observation_price_fen_check'
      AND conrelid = 'petstore_price_observation'::regclass
  ) THEN
    ALTER TABLE petstore_price_observation
      ADD CONSTRAINT petstore_price_observation_price_fen_check
      CHECK (price_fen > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'petstore_price_observation_store_code_check'
      AND conrelid = 'petstore_price_observation'::regclass
  ) THEN
    ALTER TABLE petstore_price_observation
      ADD CONSTRAINT petstore_price_observation_store_code_check
      CHECK (store_code IN ('63350001','63350002','63350003'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_petstore_price_observation_barcode_obs_date
  ON petstore_price_observation (barcode, obs_date);

CREATE INDEX IF NOT EXISTS idx_petstore_price_observation_obs_date_store_code
  ON petstore_price_observation (obs_date, store_code);

CREATE OR REPLACE VIEW v_petstore_price_spread AS
WITH latest AS (
  SELECT obs_date
    FROM petstore_price_observation
   GROUP BY obs_date
  HAVING count(DISTINCT store_code) = 3
   ORDER BY obs_date DESC
   LIMIT 1
)
SELECT
  jf.product_code,
  jf.product_name,
  jf.barcode,
  jf.price_fen AS jf_fen,
  wk.price_fen AS wk_fen,
  xsl.price_fen AS xsl_fen,
  round((wk.price_fen + xsl.price_fen)::numeric / 2)::int AS other_avg_fen,
  (jf.price_fen - round((wk.price_fen + xsl.price_fen)::numeric / 2)::int) AS diff_fen,
  round(
    (jf.price_fen - (wk.price_fen + xsl.price_fen)::numeric / 2)
    / ((wk.price_fen + xsl.price_fen)::numeric / 2) * 100,
    1
  ) AS diff_pct,
  (jf.price_fen = wk.price_fen AND wk.price_fen = xsl.price_fen) AS same_all
FROM latest l
JOIN petstore_price_observation jf
  ON jf.obs_date = l.obs_date
 AND jf.store_code = '63350001'
JOIN petstore_price_observation wk
  ON wk.obs_date = l.obs_date
 AND wk.store_code = '63350002'
 AND wk.product_code = jf.product_code
JOIN petstore_price_observation xsl
  ON xsl.obs_date = l.obs_date
 AND xsl.store_code = '63350003'
 AND xsl.product_code = jf.product_code;

COMMENT ON VIEW v_petstore_price_spread IS
'最新采集日三店公开售价价差视图；只基于售价字段计算，不含进价、供应商、销量、毛利等经营层字段。';

COMMIT;
