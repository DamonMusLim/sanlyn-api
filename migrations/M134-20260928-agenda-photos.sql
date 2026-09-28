-- M134: 店员「客户要实拍」待办的照片(Damon 0928 拍板)。
-- 流程:AI 客服判出顾客要实物照片 → POST /api/db/hr-photo-todo 建 hr_day_agenda(kind='photo')
--      → 店员按货位找到货、在 App 里拍照完成 → 照片落这张表 → 客服台按会话取图发给顾客。
-- 一条待办可以有多张照片(重拍/补拍都留着,⛔不覆盖)。

CREATE TABLE IF NOT EXISTS hr_agenda_photos (
  id            BIGSERIAL PRIMARY KEY,
  agenda_id     BIGINT NOT NULL REFERENCES hr_day_agenda(id),
  photo_path    TEXT NOT NULL,   -- 相对 /opt/sanlyn-uploads 的路径;⛔不是公网 URL(那个目录没挂 nginx),取图走 GET /api/db/hr-photo-todo?photo_id=
  employee_id   INTEGER,
  employee_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_agenda_photos_agenda ON hr_agenda_photos (agenda_id);
