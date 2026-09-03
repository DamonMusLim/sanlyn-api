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

function companyTaskId(companyCode, certKey) {
  // 固定格式，幂等去重；max 32 chars
  return ("CERT-" + companyCode + "-" + certKey).slice(0, 32);
}

function hashText(value) {
  var hash = 2166136261;
  var text = String(value || "");
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function compactIdPart(value) {
  return String(value || "").trim().replace(/\s+/g, "").replace(/[^0-9A-Za-z_-]/g, "");
}

function physicalProductCertKey(item) {
  var certNo = String(item.cert_no || "").trim();
  var fileUrl = String(item.file_url || "").trim();
  var physicalKey = certNo
    ? "cert_no:" + certNo
    : fileUrl
      ? "file_url:" + fileUrl
      : "product_key:" + (item.product_key || "");
  return [item.company_code || "", item.cert_key || "", physicalKey].join("|");
}

function productCertTaskId(item) {
  var certNo = String(item.cert_no || "").trim();
  var fallback = certNo || item.company_code || item.product_key || "unknown";
  var readable = compactIdPart(fallback + "-" + (item.cert_key || ""));
  var keyHash = hashText(physicalProductCertKey(item));
  return ("PCERT-" + readable).slice(0, 23) + "-" + keyHash;
}

function mergeProductCertItems(items) {
  var merged = [];
  var byPhysicalCert = new Map();

  for (var item of items) {
    if (item.cert_scope !== "product") {
      merged.push(item);
      continue;
    }

    var key = physicalProductCertKey(item);
    var existing = byPhysicalCert.get(key);
    var productLabel = item.product_label || item.product_key || "";
    if (!existing) {
      existing = {
        ...item,
        product_keys: [],
        product_labels: [],
      };
      byPhysicalCert.set(key, existing);
      merged.push(existing);
    }

    if (item.product_key && !existing.product_keys.includes(item.product_key)) {
      existing.product_keys.push(item.product_key);
    }
    if (productLabel && !existing.product_labels.includes(productLabel)) {
      existing.product_labels.push(productLabel);
    }
    existing.product_key = existing.product_keys.join(" / ");
    existing.product_label = existing.product_labels.join(" / ");
  }

  return merged;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  try {
    // 1. 查到期证书
    var r = await pool.query(`
      SELECT
        'company' AS cert_scope,
        cc.company_code, cc.cert_key, cc.cert_no,
        NULL::text AS product_key, NULL::text AS product_label,
        NULL::text AS file_url,
        cc.expire_date,
        ctc.cert_name_cn, ctc.cert_name_en, ctc.warn_days,
        c.name_cn AS company_name, c.type AS company_role,
        CASE
          WHEN cc.expire_date < CURRENT_DATE THEN 'expired'
          ELSE 'expiring_soon'
        END AS alert_type,
        (cc.expire_date - CURRENT_DATE) AS days_left
      FROM company_certs cc
      JOIN cert_type_config ctc
        ON ctc.cert_key = cc.cert_key AND ctc.expire_track = true AND ctc.active = true
      -- 🔴 2026-09-04 修:原来 JOIN customers 且取 c.company/c.role,两者都不存在 -> 接口一调就 500
      -- (所以历史上 0 张 CERT- 卡:既没接 cron,接了也会挂)。证件挂的是工厂,工厂在 companies 不在 customers。
      LEFT JOIN companies c ON c.code = cc.company_code
      WHERE cc.expire_date IS NOT NULL
        AND cc.expire_date <= CURRENT_DATE + (ctc.warn_days || ' days')::INTERVAL
        AND cc.status NOT IN ('rejected')
      UNION ALL
      SELECT
        'product' AS cert_scope,
        pc.company_code, pc.cert_key, pc.cert_no,
        pc.product_key, pc.product_label,
        pc.file_url,
        pc.expire_date,
        ctc.cert_name_cn, ctc.cert_name_en, ctc.warn_days,
        c.name_cn AS company_name, c.type AS company_role,
        CASE
          WHEN pc.expire_date < CURRENT_DATE THEN 'expired'
          ELSE 'expiring_soon'
        END AS alert_type,
        (pc.expire_date - CURRENT_DATE) AS days_left
      FROM product_certs pc
      JOIN cert_type_config ctc
        ON ctc.cert_key = pc.cert_key AND ctc.expire_track = true AND ctc.active = true
      LEFT JOIN companies c ON c.code = pc.company_code
      WHERE pc.expire_date IS NOT NULL
        AND pc.expire_date <= CURRENT_DATE + (ctc.warn_days || ' days')::INTERVAL
        AND pc.status NOT IN ('rejected')
      ORDER BY expire_date ASC
    `);

    var items = mergeProductCertItems(r.rows);
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
      var isProduct = item.cert_scope === "product";
      var tid = isProduct
        ? productCertTaskId(item)
        : companyTaskId(item.company_code, item.cert_key);
      var daysLeft = Number(item.days_left);
      var riskLevel = daysLeft < 0 ? "high" : daysLeft <= 7 ? "high" : daysLeft <= 14 ? "mid" : "low";
      var subject = isProduct
        ? `${item.product_label || item.product_key} / ${item.company_name || item.company_code || "未指定工厂"}`
        : item.cert_name_cn;
      var title = daysLeft < 0
        ? `[证书已过期] ${subject} ${item.cert_name_cn} 已逾期 ${Math.abs(daysLeft)} 天`
        : `[证书到期提醒] ${subject} ${item.cert_name_cn} 还剩 ${daysLeft} 天`;
      var reasonLines = isProduct
        ? [
            `品名：${item.product_label || item.product_key}`,
            `工厂：${item.company_name || item.company_code || "—"}`,
            `证书：${item.cert_name_cn}`,
            `证书编号：${item.cert_no || "—"}`,
            `到期日：${item.expire_date}`,
            `请及时联系工厂重新出具并上传新证书，否则可能影响订舱/出运流程。`,
          ]
        : [
            `证书编号：${item.cert_no || "—"}`,
            `到期日：${item.expire_date}`,
            `请及时更新并上传新证书，否则可能影响出口流程。`,
          ];
      var reason = reasonLines.join("\n");

      // 检查是否已有 open/doing 任务
      var exist = await pool.query(
        `SELECT id FROM tasks WHERE id = $1 AND status IN ('open','doing') LIMIT 1`,
        [tid]
      );
      if (exist.rows.length > 0) { skipped++; continue; }

      // upsert：可能之前 cancelled 了，重新开一张
      await pool.query(`
        -- 2026-09-04 修两处:
        --  (1) jsonb_build_object 里的 $7..$10 必须显式 ::text -- 否则 PG 报
        --      "could not determine data type of parameter $7", POST 路径从来没成功过
        --      (GET 不走这段, 所以只跑 dry-run 会以为是好的)。
        --  (2) dispatched_by 必填 sentinel(哨兵巡检): 该列默认 unknown, 漏写等于污染账本。
        INSERT INTO tasks (id, title, task_type, level, status, risk_level,
          company_code, mode, due_at, reason, raw, source, dispatched_by, created_at, updated_at)
        VALUES ($1,$2,'cert_expiry','doc','open',$3,$4,'owned',$5,$6,
          jsonb_build_object('cert_key',$7::text,'cert_name_cn',$8::text,'cert_no',$9::text,'alert_type',$10::text),
          'cert-expiry-check','sentinel',
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
