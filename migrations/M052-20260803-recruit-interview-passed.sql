-- M052 · 招聘加「面试通过」状态 + 认证时间
-- 0803 Damon：「我如果面试通过这样的，包括他的认证时间」
--
-- 状态机（只能往前走）：new 新投递 → reviewing 看过了 → interview 约面试
--                      → interview_passed 面试通过 → hired 已录用；rejected 不合适（随时可去）
ALTER TABLE hr_applicants ADD COLUMN IF NOT EXISTS interviewed_at TIMESTAMPTZ;
COMMENT ON COLUMN hr_applicants.interviewed_at IS '面试通过的时间(Damon 说的「认证时间」)。录用时若还没填,自动补上。';
COMMENT ON COLUMN hr_applicants.reviewed_by  IS '谁批的。以登录态为准,不信前端手填的「经办人」。';
COMMENT ON COLUMN hr_applicants.status IS 'new|reviewing|interview|interview_passed|hired|rejected。只能往前走,后端拒绝倒退 —— 已录用的人被改回新投递会让申请人手机上从「通过了」变回「认证中」。';

-- 把已经录用的两条补上认证时间和经办人（当时是 Damon 让我在会话里批的）
UPDATE hr_applicants
   SET interviewed_at = COALESCE(interviewed_at, reviewed_at),
       reviewed_by    = COALESCE(reviewed_by, 'damon')
 WHERE status='hired';
