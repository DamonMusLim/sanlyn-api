// kyc-review.js
// admin 审批 KYC 文件 / 整体公司认证
// 蓝图 §13 Day 1
//
// GET  /api/db/kyc-review?status=pending       — 列出待审客户
// POST /api/db/kyc-review                       — 审批
//   body 模式 1 (单文件): { company_code, doc_type, action: 'verify'|'reject', note? }
//   body 模式 2 (整体):   { company_code, action: 'approve_all'|'reject_all', note? }
//
// 效果:
//   verify:       customers.kyc_docs[doc_type].verified = true
//   approve_all:  kyc_status='verified', kyc_verified_at, kyc_verified_by
//   reject_all:   kyc_status='rejected'
//   每次操作写 audit_logs

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";

var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";

async function pingCustomer({ company_code, status, note }) {
  if (!WECOM_WEBHOOK) return;
  try {
    await fetch(WECOM_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: [
          status === "verified" ? "## ✅ KYC Approved" : "## ❌ KYC Rejected",
          "**Company:** " + company_code,
          note ? "**Note:** " + note : "",
        ].filter(Boolean).join("\n") },
      }),
    });
  } catch (_) {}
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // admin only
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "super_admin")) {
    return res.status(403).json({ error: "admin only" });
  }

  var pool = getPool();

  // ── GET: list customers needing review ──
  if (req.method === "GET") {
    var status = req.query?.status || "pending";
    var validStatuses = ["pending", "verified", "expired", "rejected", "all"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "status must be one of: " + validStatuses.join(",") });
    }
    try {
      var sql, params;
      if (status === "all") {
        sql = `SELECT id, company_code, name_en, name_cn, role, country,
                      kyc_status, kyc_docs, kyc_verified_at, kyc_verified_by,
                      created_at, updated_at
               FROM customers ORDER BY
                 CASE kyc_status WHEN 'pending' THEN 1 WHEN 'expired' THEN 2 WHEN 'rejected' THEN 3 ELSE 4 END,
                 updated_at DESC LIMIT 500`;
        params = [];
      } else {
        sql = `SELECT id, company_code, name_en, name_cn, role, country,
                      kyc_status, kyc_docs, kyc_verified_at, kyc_verified_by,
                      created_at, updated_at
               FROM customers WHERE kyc_status = $1 ORDER BY updated_at DESC LIMIT 500`;
        params = [status];
      }
      var r = await pool.query(sql, params);

      // counts by status
      var countsR = await pool.query(
        `SELECT kyc_status, COUNT(*)::int AS c FROM customers GROUP BY kyc_status`
      );
      var counts = {};
      for (var row of countsR.rows) counts[row.kyc_status || "null"] = row.c;

      return res.status(200).json({
        success: true,
        count: r.rows.length,
        data: r.rows,
        counts,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET/POST only" });

  var b = req.body || {};
  if (!b.company_code) return res.status(400).json({ error: "company_code required" });
  if (!b.action) return res.status(400).json({ error: "action required" });

  try {
    var custQ = await pool.query(
      "SELECT id, company_code, kyc_docs, kyc_status FROM customers WHERE company_code = $1 LIMIT 1",
      [b.company_code]
    );
    if (!custQ.rows.length) return res.status(404).json({ error: "customer not found" });
    var cust = custQ.rows[0];
    var prevDocs = cust.kyc_docs || {};
    var prevStatus = cust.kyc_status;
    var actor = req.user.email || req.user.username;

    // ── 模式 1: 单文件 verify/reject ──
    if (b.doc_type) {
      if (!["verify","reject"].includes(b.action)) {
        return res.status(400).json({ error: "action must be verify|reject when doc_type set" });
      }
      if (!prevDocs[b.doc_type]) {
        return res.status(404).json({ error: "doc_type not uploaded yet: " + b.doc_type });
      }

      var newDoc = {
        ...prevDocs[b.doc_type],
        verified: b.action === "verify",
        review_action: b.action,
        review_note: b.note || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: actor,
      };
      var newDocs = { ...prevDocs, [b.doc_type]: newDoc };

      await pool.query(
        "UPDATE customers SET kyc_docs = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(newDocs), cust.id]
      );

      writeAudit(pool, req, {
        action: "kyc.doc_" + b.action,
        entity_type: "customer",
        entity_id: cust.id,
        before: { [b.doc_type]: { verified: prevDocs[b.doc_type]?.verified } },
        after:  { [b.doc_type]: { verified: newDoc.verified } },
        note: b.note,
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        company_code: b.company_code,
        doc_type: b.doc_type,
        verified: newDoc.verified,
      });
    }

    // ── 模式 2: 整体 approve_all / reject_all ──
    if (!["approve_all","reject_all"].includes(b.action)) {
      return res.status(400).json({ error: "action must be approve_all|reject_all when no doc_type" });
    }

    var newStatus = b.action === "approve_all" ? "verified" : "rejected";
    var now = new Date().toISOString();

    // approve_all: also mark all docs verified
    var updatedDocs = prevDocs;
    if (b.action === "approve_all") {
      updatedDocs = {};
      for (var key of Object.keys(prevDocs)) {
        updatedDocs[key] = { ...prevDocs[key], verified: true, reviewed_at: now, reviewed_by: actor };
      }
    }

    await pool.query(
      `UPDATE customers SET
         kyc_status = $1,
         kyc_docs = $2::jsonb,
         kyc_verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE kyc_verified_at END,
         kyc_verified_by = CASE WHEN $1 = 'verified' THEN $3 ELSE kyc_verified_by END,
         updated_at = NOW()
       WHERE id = $4`,
      [newStatus, JSON.stringify(updatedDocs), actor, cust.id]
    );

    writeAudit(pool, req, {
      action: "kyc." + b.action,
      entity_type: "customer",
      entity_id: cust.id,
      before: { kyc_status: prevStatus },
      after:  { kyc_status: newStatus },
      note: b.note,
    }).catch(() => {});

    pingCustomer({ company_code: b.company_code, status: newStatus, note: b.note });

    return res.status(200).json({
      success: true,
      company_code: b.company_code,
      kyc_status: newStatus,
      reviewed_by: actor,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
