// ══════════════════════════════════════════════════════════
// audit.js — 审计日志写入工具
// 在任何数据变更时调用，自动记录到 audit_log 表
// ══════════════════════════════════════════════════════════
import { getPool } from "./db.js";

/**
 * 写入审计日志
 *
 * @param {object} params
 * @param {string} params.tenant_id    - 租户 ID（从 req.tenantId 获取）
 * @param {string} params.user_id      - 操作人 ID
 * @param {string} params.user_name    - 操作人显示名
 * @param {string} params.user_role    - admin / customer / staff
 * @param {string} params.table_name   - 操作的表名
 * @param {string} params.record_id    - 被操作记录的 ID
 * @param {string} params.action       - INSERT / UPDATE / DELETE / LOGIN / EXPORT
 * @param {object} [params.old_values] - 修改前的值
 * @param {object} [params.new_values] - 修改后的值
 * @param {object} [params.changes]    - 变化的字段 {field: {old, new}}
 * @param {string} [params.ip_address] - 客户端 IP
 * @param {string} [params.user_agent] - 客户端 UA
 * @param {string} [params.note]       - 备注
 */
export async function writeAuditLog(params) {
  const {
    tenant_id = "SANLYN",
    user_id,
    user_name,
    user_role,
    table_name,
    record_id,
    action,
    old_values,
    new_values,
    changes,
    ip_address,
    user_agent,
    note,
  } = params;

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO audit_log
        (tenant_id, user_id, user_name, user_role,
         table_name, record_id, action,
         old_values, new_values, changes,
         ip_address, user_agent, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        tenant_id,
        user_id,
        user_name,
        user_role,
        table_name,
        record_id,
        action,
        old_values ? JSON.stringify(old_values) : null,
        new_values ? JSON.stringify(new_values) : null,
        changes ? JSON.stringify(changes) : null,
        ip_address,
        user_agent,
        note,
      ]
    );
  } catch (err) {
    // 审计日志写入失败不应该阻塞业务
    console.error("[audit] Failed to write audit log:", err.message);
  }
}

/**
 * 从 Express req 提取客户端信息
 * 用于传入 writeAuditLog 的 ip_address / user_agent
 */
export function getClientInfo(req) {
  return {
    ip_address:
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "unknown",
    user_agent: req.headers["user-agent"] || "unknown",
  };
}

/**
 * 计算两个对象之间的差异
 * 返回 {field: {old: xxx, new: yyy}} 格式
 */
export function diffObjects(oldObj, newObj) {
  if (!oldObj || !newObj) return null;

  const changes = {};
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    // 跳过系统字段
    if (["updated_at", "created_at"].includes(key)) continue;

    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

export default writeAuditLog;
