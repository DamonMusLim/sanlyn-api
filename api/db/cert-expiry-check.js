// cert-expiry-check.js
// 证书到期检查 — 每日 cron 调用
//
// 逻辑：
//   1. 查出所有快到期/已过期的证书
//   2. 每条证书 → 在 tasks 表 upsert 一张任务卡（幂等）
//   3. 任务归属公司（company_code），工厂/外贸公司在自己门户看到
//   4. 已有 open/doing 任务 → 跳过（不重复建）
//   5. 返回本次创建/已存在/all_clear 统计
//
// GET /api/db/cert-expiry-check   — 只查，不建任务（dry_run）
// POST /api/db/cert-expiry-check  — 查 + 建任务（cron 调用）

import { getPool, setCors } from "../db.js";

function taskId(companyCode, certKey) {
  // 固定格式，幂等去重；max 32 chars
  return ("CERT-" + companyCode + "-" + certKey).slice(0, 32);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  try {
    // 1. 查到期证书
    var r = await pool.query(`
      SELECT
        cc.company_code, cc.cert_key, cc.cert_no,
        cc.expire_date,
        ctc.cert_name_cn, ctc.cert_name_en, ctc.warn_days,
        c.company AS company_name, c.role AS company_role,
        CASE
          WHEN cc.expire_date < CURRENT_DATE THEN 'expired'
          ELSE 'expiring_soon'
        END AS alert_type,
        (cc.expire_date - CURRENT_DATE) AS days_left
      FROM company_certs cc
      JOIN cert_type_config ctc
        ON ctc.cert_key = cc.cert_key AND ctc.expire_track = true AND ctc.active = true
      LEFT JOIN customers c ON c.company_code = cc.company_code
      WHERE cc.expire_date IS NOT NULL
        AND cc.expire_date <= CURRENT_DATE + (ctc.warn_days || ' days')::INTERVAL
        AND cc.status NOT IN ('rejected')
      ORDER BY cc.expire_date ASC
    `);

    var items = r.rows;
    if (items.length === 0) {
      return res.status(200).json({ success: true, message: "all_clear", created: 0, skipped: 0 });
    }

    // GET = dry run，只返回清单不建任务
    if (req.method === "GET") {
      return res.status(200).json({ success: true, mode: "dry_run", count: items.length, items });
    }

    // 2. POST = 建任务卡
    var created = 0, skipped = 0;
    for (var item of items) {
      var tid = taskId(item.company_code, item.cert_key);
      var daysLeft = Number(item.days_left);
      var riskLevel = daysLeft < 0 ? "high" : daysLeft <= 7 ? "high" : daysLeft <= 14 ? "mid" : "low";
      var title = daysLeft < 0
        ? `[证书已过期] ${item.cert_name_cn} 已逾期 ${Math.abs(daysLeft)} 天`
        : `[证书到期提醒] ${item.cert_name_cn} 还剩 ${daysLeft} 天`;
      var reason = [
        `证书编号：${item.cert_no || "—"}`,
        `到期日：${item.expire_date}`,
        `请及时更新并上传新证书，否则可能影响出口流程。`,
      ].join("\n");

      // 检查是否已有 open/doing 任务
      var exist = await pool.query(
        `SELECT id FROM tasks WHERE id = $1 AND status IN ('open','doing') LIMIT 1`,
        [tid]
      );
      if (exist.rows.length > 0) { skipped++; continue; }

      // upsert：可能之前 cancelled 了，重新开一张
      await pool.query(`
        INSERT INTO tasks (id, title, task_type, level, status, risk_level,
          company_code, mode, due_at, reason, raw, created_at, updated_at)
        VALUES ($1,$2,'cert_expiry','doc','open',$3,$4,'owned',$5,$6,
          jsonb_build_object('cert_key',$7,'cert_name_cn',$8,'cert_no',$9,'alert_type',$10),
          NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          title      = EXCLUDED.title,
          risk_level = EXCLUDED.risk_level,
          status     = 'open',
          due_at     = EXCLUDED.due_at,
          reason     = EXCLUDED.reason,
          updated_at = NOW()
        WHERE tasks.status = 'cancelled'
      `, [
        tid, title, riskLevel,
        item.company_code,
        item.expire_date,
        reason,
        item.cert_key, item.cert_name_cn, item.cert_no || "", item.alert_type,
      ]);
      created++;
    }

    return res.status(200).json({ success: true, total: items.length, created, skipped });
  } catch (e) {
    console.error("[cert-expiry-check]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
