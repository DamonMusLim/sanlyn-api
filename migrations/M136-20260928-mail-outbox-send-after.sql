-- M136: 发件台定时发送 —— Damon 0929「到点提醒+一键发,不自动发……或者我同意了,有时间可以发送」。
-- send_after = 这封信最早可以离开的时间。NULL = 立刻可发(现有行为,存量 33 行全部为 NULL,行为零变化)。
-- 它只决定「什么时候发」,⛔ 不决定「要不要发」——要不要发仍由 reviewMailOutbox/send 那四道闸把关
-- (requireHumanMailActor / 质检 live pass / 角色闸 / findDuplicateSentMail)。
-- 配套: order-collab-sender.mjs 的 claimOne() 与 claimDeskOne() 各加
--        AND (send_after IS NULL OR send_after <= now())
ALTER TABLE mail_outbox ADD COLUMN IF NOT EXISTS send_after timestamptz;
