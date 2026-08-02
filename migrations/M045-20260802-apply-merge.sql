-- M045 · 应聘/入职合一：申请只进 hr_applicants，店长录用后才进 hr_employees
--
-- 0802 Damon：「新来的？先填资料」和「我要应聘」是同一件事，合并；
--             第一次来是申请认证，要店长同意，申请人自己看到「认证中」；
--             身份证这类材料**入职之后才填**，不在申请时收。
--
-- 架构没重造 —— hr_apply(公开投递) → hr_recruit(一键录用建档) 这条线本来就在，
-- 这次只是把员工端那个会直接写 hr_employees(pending) 的野路子废掉，全部并回这条线。
-- （codex 二审也指出：申请人不该混进花名册，employment_status='pending' 语义会和
--   「待设密码」「资料待补」纠缠不清。采纳。）

-- 申请人自己看状态用的回执号。**只发给提交本人**（存他手机 localStorage），
-- 不做「输手机号查状态」—— 那等于给外人一个手机号枚举接口。
ALTER TABLE hr_applicants ADD COLUMN IF NOT EXISTS apply_token       TEXT;
ALTER TABLE hr_applicants ADD COLUMN IF NOT EXISTS desired_position  TEXT;   -- 意向岗位:店长|店员(只是意向,最终由店长定)
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_applicants_token ON hr_applicants(apply_token) WHERE apply_token IS NOT NULL;

COMMENT ON COLUMN hr_applicants.apply_token IS '申请回执号,给申请人查"认证中/已通过"。绝不支持按手机号查状态(枚举漏洞)。';
COMMENT ON COLUMN hr_applicants.desired_position IS '申请时选的意向岗位,不等于权限。role=manager 只能由店长在录用时写。';

-- 入职后才补的材料：紧急联系人已有(emergency_contact/emergency_phone)，
-- 缺发工资用的银行卡。⚠️ 敏感,后台展示要脱敏。
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_account_no  TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_name        TEXT;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS materials_done_at TIMESTAMPTZ;  -- 资料交齐时间;NULL=还没齐

COMMENT ON COLUMN hr_employees.bank_account_no IS '工资卡号。后台列表只显示后4位,详情页需要权限才看全。';
COMMENT ON COLUMN hr_employees.materials_done_at IS '身份证正反+紧急联系人+工资卡都齐了的时间。NULL=没齐,员工端挂横幅、店长后台标红。资料没齐**不拦打卡**。';

-- 历史遗留：老的 onboard 路子写过 employment_status='pending' 的行。
-- 现在没有这种行(已核实)，但把口径钉死，免得以后又冒出来。
COMMENT ON COLUMN hr_employees.employment_status IS '只有 active|left 两个正常值。pending 已废弃 —— 没录用的人待在 hr_applicants,不进花名册。';
