-- M135: 店员 App 业务页「员工能看哪些格子」由老板在后台勾选(Damon 0928:给员工的权限尽量少)。
-- 存格子名(中文,跟页面上一致);NULL = 用代码里的默认最小集。老板/店长(role manager 等)不受限。
ALTER TABLE hr_org_settings ADD COLUMN IF NOT EXISTS staff_biz_tiles JSONB;
