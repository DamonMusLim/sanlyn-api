// collab-shared.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import crypto from "crypto";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function genRaw() {
  // 10位字母数字短码：kp?c=CODE 复用;code本身即token(hash存token_hash)
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.randomBytes(10);
  let out = "";
  for (const x of b) out += A[x % A.length];
  return out;
}

// ── 协同版本戳 ───────────────────────────────────────────────
// Damon 2026-08-06：「记得别重造，就改我们之前的协同，版本号记录和时间」
// 每次改协同的行为(字段可见性/费用/闸门)就升一版，写清改了什么。
// 前端页脚与 /api/db/collab/verify 都读这里，线上跑的是哪版一看便知。
const COLLAB_VERSION = "v2026.08.12-2";
const COLLAB_VERSION_AT = "2026-08-12T17:15+00:00";
const COLLAB_CHANGELOG = [
  { v: "v2026.08.12-2", at: "2026-08-12", note: "提单/排载单 BL 确认闸门改为客户+工厂双方确认；客户 HS 显示偏好写入公司默认并在新票初始化复用" },
  { v: "v2.5.1", at: "2026-08-08", note: "修复协同账单跨段越权：update/delete/confirm 均按原账单行费段校验；超项费改为普通 pending 费用，申报品名统计仅作确认参考" },
  { v: "v2.5.0", at: "2026-08-07", note: "三方费用分段填报：货代/车队/报关行只能提报本段费用，全部 pending 待我方确认；新增内部账单分段汇总与参照数据闸门" },
  { v: "v2.4.0", at: "2026-08-06", note: "角色权限矩阵落地：trucking/broker 由完整字段收紧为按需字段(车队10/报关行17/货代23)" },
];

export { APP_BASE, rawToHash, genRaw, COLLAB_VERSION, COLLAB_VERSION_AT, COLLAB_CHANGELOG };
