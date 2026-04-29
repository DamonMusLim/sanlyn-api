// audit-helper.js
// 共享 helper — 其他模块调 writeAudit() 写审计日志
// 老的 audit-log.js 保留向后兼容 (S75 vault + S94 通用)；这里专做 v2 entity-aware 审计
//
// 用法:
//   import { writeAudit } from "./audit-helper.js";
//   await writeAudit(pool, req, {
//     action: "kyc.verify",
//     entity_type: "customer",
//     entity_id: customerId,
//     before: { kyc_status: "pending" },
//     after:  { kyc_status: "verified" },
//     note: "营业执照已通过",
//   });

export async function writeAudit(pool, req, params) {
  if (!pool || !params || !params.action) return { ok: false, error: "missing pool/action" };

  var actor_id = (req?.user?.email || req?.user?.username || "anonymous");
  var actor_role = req?.user?.role || "unknown";
  var actor_company = req?.user?.company_code || "";
  var ip = (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req?.ip || null;
  var ua = req?.headers?.["user-agent"] || null;
  var request_id = req?.headers?.["x-request-id"] || null;

  var summary = params.diff_summary || autoSummary(params.before, params.after);

  // 兼容老 audit_logs 的列名:
  //   operator (老) ← actor_id
  //   role     (老) ← actor_role
  //   company  (老) ← actor_company
  // 新列: entity_type / entity_id / before / after / diff_summary / ip / user_agent / request_id
  // detail (老 JSONB) 用于存 note + 任何额外字段
  var detail = { note: params.note || null, ...(params.detail || {}) };

  try {
    await pool.query(
      `INSERT INTO audit_logs
        (action, operator, role, company,
         entity_type, entity_id,
         before, after, diff_summary,
         detail, ip, user_agent, request_id)
       VALUES ($1,$2,$3,$4, $5,$6, $7::jsonb,$8::jsonb,$9, $10::jsonb,$11,$12,$13)`,
      [
        params.action, actor_id, actor_role, actor_company,
        params.entity_type || null, params.entity_id ? String(params.entity_id) : null,
        JSON.stringify(params.before || {}),
        JSON.stringify(params.after || {}),
        summary,
        JSON.stringify(detail), ip, ua, request_id,
      ]
    );
    return { ok: true };
  } catch (e) {
    // 写失败不阻断业务
    console.error("[audit-helper] write failed:", e.message, params.action);
    return { ok: false, error: e.message };
  }
}

function autoSummary(before, after) {
  before = before || {};
  after = after || {};
  var keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  var parts = [];
  for (var k of keys) {
    var b = before[k];
    var a = after[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      parts.push(`${k}: ${stringify(b)} → ${stringify(a)}`);
    }
  }
  return parts.join("; ") || "no field changes";
}

function stringify(v) {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" && v.length > 60) return v.slice(0, 57) + "...";
  return String(v);
}
