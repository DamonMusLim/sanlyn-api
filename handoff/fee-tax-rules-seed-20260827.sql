-- 人工确认后执行：0827 已确证费目税率种子。
-- 可外层包 BEGIN/ROLLBACK 空跑；本文件不自带 COMMIT。
-- 不回填 freight_supplier_bills.tax_rate/tax_amount，历史账单税率是当时事实。

WITH seed_rows (cost_category, default_tax_rate, invoice_type, effective_from, note) AS (
  VALUES
    (
      '陆运费/拖车费',
      0.09,
      '增值税专票',
      DATE '2026-08-27',
      '依据: 中创物流 0827 微信「陆运费可以开9%的专票」+ Damon「拖车一定要9%这个跑不了」。'
    ),
    (
      '海运费/港杂费/THC',
      0,
      '增值税免税票',
      DATE '2026-08-27',
      '依据: 中创物流 0827 微信「海运费和港杂费thc等，开增值税免税票」。'
    )
),
inserted AS (
  INSERT INTO fee_tax_rules (
    cost_category,
    default_tax_rate,
    invoice_type,
    effective_from,
    note
  )
  SELECT
    cost_category,
    default_tax_rate,
    invoice_type,
    effective_from,
    note
  FROM seed_rows
  ON CONFLICT (cost_category, invoice_type, effective_from) DO UPDATE
  SET
    default_tax_rate = EXCLUDED.default_tax_rate,
    note = EXCLUDED.note
  RETURNING 1
)
SELECT
  (SELECT COUNT(*) FROM seed_rows)::int AS seed_rows,
  (SELECT COUNT(*) FROM inserted)::int AS upserted_rows;
