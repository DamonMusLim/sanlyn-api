-- M142 扫码失败留档(Damon 0930:扫码错误要记录,后期看店员问题);写入方 ~/bin/petstore-data-tasks.py
-- 背景:Damon 0930「系统后台有扫码错误的问题,这些要记录下来,后期就可以看到店员问题」
-- 写入方:petstore-data-tasks.py(每轮 INSERT ... ON CONFLICT DO NOTHING,幂等)
-- 库:腾讯任务中心 PG(与 petstore_ops_row / tasks 同库,sanlyn-api DATABASE_URL)
-- ⚠️ 库是 SQL_ASCII:本表全部列只存数字条码/ASCII 分类值/少量中文备注,值由脚本侧
--    dollar-quote(pw.lit)传入,不在 SQL 里对中文做 left()/substr() 截断。

CREATE TABLE IF NOT EXISTS petstore_scan_miss_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL,          -- 扫码时刻(北京时间换算后的绝对时刻)
  device_no    text,                          -- 收银设备号(kiosk-qr.jsonl 的 deviceNo)
  barcode      text NOT NULL,                 -- 实际扫出来的内容(可能是错码/链接)
  class        text NOT NULL CHECK (class IN ('barcode_typo','not_in_gdc','not_product_code','ok_now','repeat')),
  matched_code text,                          -- barcode_typo 时=后6位命中的我方 product_code
  note         text,                          -- 分类依据/口径说明
  shift_staff  text,                          -- 当时打卡在岗店员(hr_staff_checkin,按天)
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ts, device_no, barcode)             -- 幂等锚点:同轮/重跑不堆重复
);

CREATE INDEX IF NOT EXISTS idx_psm_device_ts ON petstore_scan_miss_log (device_no, ts DESC);
CREATE INDEX IF NOT EXISTS idx_psm_class_ts  ON petstore_scan_miss_log (class, ts DESC);

-- 验收(db-migrate 执行后回读,判据可数):
--   \d petstore_scan_miss_log            → 列/CHECK/UNIQUE 与本文件一致
--   重跑 petstore-data-tasks.py --apply 两轮 → 第二轮新增行数 = 0(幂等)
