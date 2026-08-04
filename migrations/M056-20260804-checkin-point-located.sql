-- M056 · 打卡点标定留痕
-- 0804 Damon：开门前要显示「你离店多远」。但两个打卡点的 lat/lng 一直是空的，
-- 而且没有任何地图 key 能把地址转成坐标 —— 只能站在店门口标一次。
-- 谁标的、什么时候标的必须留痕：这一下决定了以后所有「离店多远」的基准。
ALTER TABLE hr_checkin_points ADD COLUMN IF NOT EXISTS located_by TEXT;
ALTER TABLE hr_checkin_points ADD COLUMN IF NOT EXISTS located_at TIMESTAMPTZ;
COMMENT ON COLUMN hr_checkin_points.located_by IS '谁站在门口标的这个坐标。员工端只允许标一次(lat 为空时),要改走后台。';
