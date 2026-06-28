// ai-operations.js — AI 动作日记 CRUD
//
// POST                     记录一次 AI 动作（任何 AI 接口调用都该写）
// GET  ?action=list&...    查询（按订单/doc_type/result 过滤）
// PATCH ?id=N              人工 review（accepted/edited/rejected + diff）
//
import { getPool, setCors } from "../db.js";
import crypto from "crypto";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const action = req.query?.action;

  try {
    // ─── POST log AI action ──────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.doc_type || !b.action) {
        return res.status(400).json({ error: "doc_type and action required" });
      }
      // input hash for dedup/lookup
      const inputHash = b.input_data
        ? crypto.createHash("sha256").update(JSON.stringify(b.input_data)).digest("hex").slice(0, 32)
        : null;

      const r = await pool.query(`
        INSERT INTO ai_operations
          (order_id, collab_sheet_id, doc_type, action, model,
           input_hash, input_data, output_data, confidence, reasoning,
           triggered_by, result, cost_tokens, duration_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id, created_at
      `, [
        b.order_id || null, b.collab_sheet_id || null,
        b.doc_type, b.action, b.model || "unknown",
        inputHash, b.input_data || null, b.output_data || null,
        b.confidence || null, b.reasoning || null,
        b.triggered_by || (req.user?.username || "system"),
        b.result || "pending",
        b.cost_tokens || null, b.duration_ms || null,
      ]);
      return res.status(200).json({ success: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
    }

    // ─── GET list ────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const orderId = req.query.order_id;
      const docType = req.query.doc_type;
      const result  = req.query.result;
      const limit   = Math.min(parseInt(req.query.limit) || 50, 200);

      const conds = [];
      const params = [];
      if (orderId) { params.push(orderId); conds.push("order_id = $" + params.length); }
      if (docType) { params.push(docType); conds.push("doc_type = $" + params.length); }
      if (result)  { params.push(result);  conds.push("result = $" + params.length); }

      const whereSql = conds.length ? "WHERE " + conds.join(" AND ") : "";
      params.push(limit);
      const r = await pool.query(`
        SELECT id, order_id, doc_type, action, model, confidence,
               reasoning, result, triggered_by, reviewer_id, reviewed_at,
               cost_tokens, duration_ms, created_at
        FROM ai_operations
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length}
      `, params);
      return res.status(200).json({ success: true, data: r.rows });
    }

    // ─── PATCH human review ──────────────────────────────
    if (req.method === "PATCH") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      const b = req.body || {};
      if (!["accepted", "edited", "rejected", "overridden"].includes(b.result)) {
        return res.status(400).json({ error: "invalid result" });
      }
      const r = await pool.query(`
        UPDATE ai_operations
        SET result = $2, human_diff = $3, reviewer_id = $4, reviewed_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id, b.result, b.human_diff || null, req.user?.username || "anonymous"]);
      if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
