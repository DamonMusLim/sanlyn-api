BEGIN;

CREATE TABLE IF NOT EXISTS petstore_takeout_picks (
  order_no TEXT NOT NULL,
  product_code TEXT NOT NULL,
  barcode TEXT,
  quantity NUMERIC NOT NULL DEFAULT 0,
  picked NUMERIC NOT NULL DEFAULT 0,
  manual_count INTEGER NOT NULL DEFAULT 0,
  picker_employee_id INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  PRIMARY KEY (order_no, product_code)
);

CREATE INDEX IF NOT EXISTS idx_petstore_takeout_picks_order
  ON petstore_takeout_picks(order_no);

CREATE INDEX IF NOT EXISTS idx_petstore_takeout_picks_picker
  ON petstore_takeout_picks(picker_employee_id);

COMMENT ON TABLE petstore_takeout_picks IS '宠物店外卖拣货本地计数；本期不写回果冻橙 pickedV2';
COMMENT ON COLUMN petstore_takeout_picks.manual_count IS '手动+1次数，用于复盘条码损坏/散装场景';

COMMIT;
