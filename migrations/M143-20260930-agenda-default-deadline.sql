-- M143 今日待办一律带截止时间(Damon 0930「任务不要写全天」)
-- 派任务的脚本没填 at_time 时,按北京时间「派出时刻+2小时,取整点,最早10:00、最晚22:00」补上;
-- 下架过期/过期类更急:+1小时。已有 at_time 的不动;公告(notice)不动。
CREATE OR REPLACE FUNCTION hr_day_agenda_default_deadline() RETURNS trigger AS $$
DECLARE
  base timestamp := (now() AT TIME ZONE 'Asia/Shanghai');
  add_h int := CASE WHEN NEW.title LIKE '%过期%' THEN 1 ELSE 2 END;
  h int;
BEGIN
  IF NEW.at_time IS NULL AND COALESCE(NEW.kind,'') <> 'notice' THEN
    h := extract(hour FROM base)::int + add_h + CASE WHEN extract(minute FROM base) > 0 THEN 1 ELSE 0 END;
    h := GREATEST(10, LEAST(22, h));
    NEW.at_time := make_time(h, 0, 0);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hr_day_agenda_default_deadline ON hr_day_agenda;
CREATE TRIGGER trg_hr_day_agenda_default_deadline BEFORE INSERT ON hr_day_agenda
  FOR EACH ROW EXECUTE FUNCTION hr_day_agenda_default_deadline();

-- 补已派还没做的:过期类 11:00,其余 17:00(跨天欠着的会显示红色=超时)
UPDATE hr_day_agenda SET at_time = CASE WHEN title LIKE '%过期%' THEN time '11:00' ELSE time '17:00' END
 WHERE at_time IS NULL AND COALESCE(kind,'') <> 'notice' AND status = 'open';
