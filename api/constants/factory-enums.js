// api/constants/factory-enums.js — B2-1
// 工厂执行闭环包共享枚举。前端、后端、迁移脚本一律从此文件读取，禁止硬编码字符串字面量。
//
// 任务编号：B2-1-FACTORY-BACKEND-CONTRACT-API-001
// 口径来源：GPT 对 B2 扫描 + 总方案的带修改通过裁决。
//
// 注意：
//   - accepted ≠ completed
//     accepted = 工厂提交物 / 交付内容已被接受（可继续收尾）
//     completed = 整个任务闭环完成
//   - 不允许通知状态回退到 unread（业务规则，handler 里校验）

export const FACTORY_TASK_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "waiting_upload",
  "uploaded",
  "under_review",
  "accepted",
  "rejected",
  "completed",
  "blocked",
]);

export const FACTORY_NOTIFICATION_STATUSES = Object.freeze([
  "unread",
  "read",
  "handled",
  "archived",
]);

// 允许通过 PATCH 转入的通知目标状态（不含 unread）
export const FACTORY_NOTIFICATION_PATCH_STATUSES = Object.freeze([
  "read",
  "handled",
  "archived",
]);

export const FACTORY_UPLOAD_STATUSES = Object.freeze([
  "uploaded",
  "accepted",
  "rejected",
  "failed",
]);

export const FACTORY_NOTIFICATION_SEVERITIES = Object.freeze([
  "info",
  "warning",
  "critical",
]);

// actor role 白名单（写入 audit.lastActionRole）
export const FACTORY_ACTOR_ROLES = Object.freeze([
  "factory",
  "admin",
  "ops",
]);

export function isValidFactoryTaskStatus(s) {
  return FACTORY_TASK_STATUSES.indexOf(s) !== -1;
}

export function isValidNotificationStatus(s) {
  return FACTORY_NOTIFICATION_STATUSES.indexOf(s) !== -1;
}

export function isValidNotificationPatchStatus(s) {
  return FACTORY_NOTIFICATION_PATCH_STATUSES.indexOf(s) !== -1;
}

export function isValidUploadStatus(s) {
  return FACTORY_UPLOAD_STATUSES.indexOf(s) !== -1;
}

export function isValidActorRole(s) {
  return FACTORY_ACTOR_ROLES.indexOf(s) !== -1;
}
