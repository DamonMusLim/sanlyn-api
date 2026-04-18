// api/db/m3-missing.js
// M3 Phase 2 — GET /api/db/m3-missing
// 查询 document_missing_items 表（Phase 1 为空架子，Phase 2 改为真实查询）
//
// Query params:
//   shipment_no   - 可选，精确匹配
//   status        - 默认 'open'（可选 'resolved'/'all'）
//   severity      - 可选：'critical' | 'warning' | 'info'
//   issue_type    - 可选：'missing' | 'conflict' | 'low_confidence' | 'invalid_format'
//   limit         - 默认 200，最大 500

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const pool = getPool();

  try {
    const {
      shipment_no,
      status: rawStatus,
      severity,
      issue_type,
      limit: rawLimit,
    } = req.query;

    const lim = Math.min(Number(rawLimit) || 200, 500);
    const status = rawStatus && rawStatus !== "all" ? rawStatus : null;

    // ── 构建查询 ──────────────────────────────────────────────────
    const vals = [];
    const conds = [];

    if (shipment_no && shipment_no.trim()) {
      vals.push(shipment_no.trim());
      conds.push(`shipment_no = $${vals.length}`);
    }

    if (status) {
      vals.push(status);
      conds.push(`status = $${vals.length}`);
    } else if (!rawStatus) {
      // 默认只返回 open
      conds.push(`status = 'open'`);
    }

    if (severity) {
      vals.push(severity);
      conds.push(`severity = $${vals.length}`);
    }

    if (issue_type) {
      vals.push(issue_type);
      conds.push(`issue_type = $${vals.length}`);
    }

    let sql = `SELECT * FROM document_missing_items`;
    if (conds.length > 0) sql += ` WHERE ${conds.join(" AND ")}`;
    sql += ` ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      created_at DESC
      LIMIT ${lim}`;

    const result = await pool.query(sql, vals);
    return res.status(200).json({
      success: true,
      data:    result.rows,
      count:   result.rows.length,
    });
  } catch (err) {
    console.error("[M3_WRITE_FAIL]", JSON.stringify({
      stage: "m3_missing_handler.query", shipment_no: req.query?.shipment_no || "unknown",
      file_type: "system", source_engine: "system",
      error: err.message || String(err), ts: new Date().toISOString(),
    }));
    return res.status(500).json({ success: false, error: err.message || "internal error" });
  }
}
