// ai-log.js — AI 动作日记 helper
//
// 任何调用 AI 的接口都用这个工具写日记，避免每个接口手写 INSERT。
//
// 用法：
//   import { logAI } from "../lib/ai-log.js";
//   const opId = await logAI({
//     order_id: 123,
//     doc_type: "customs_draft",
//     action: "generate",
//     model: "minimax-abab6.5",
//     input_data: { products: [...], order: {...} },
//     output_data: { hs_codes: [...], elements: "..." },
//     confidence: 0.92,
//     reasoning: "based on similar SKUs from PETSOME history",
//     duration_ms: 1230,
//     cost_tokens: 1850,
//     triggered_by: req.user?.username || "system"
//   });
//   // opId 可关联到 collab sheet 或后续 PATCH 标记 result
//
import crypto from "crypto";
import { getPool } from "../db.js";

export async function logAI(opts) {
  if (!opts || !opts.doc_type || !opts.action) {
    console.warn("[ai-log] missing doc_type/action", opts);
    return null;
  }
  try {
    const pool = getPool();
    const inputHash = opts.input_data
      ? crypto.createHash("sha256").update(JSON.stringify(opts.input_data)).digest("hex").slice(0, 32)
      : null;
    const r = await pool.query(`
      INSERT INTO ai_operations
        (order_id, collab_sheet_id, doc_type, action, model,
         input_hash, input_data, output_data, confidence, reasoning,
         triggered_by, result, cost_tokens, duration_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [
      opts.order_id || null,
      opts.collab_sheet_id || null,
      opts.doc_type,
      opts.action,
      opts.model || "unknown",
      inputHash,
      opts.input_data ? JSON.stringify(opts.input_data) : null,
      opts.output_data ? JSON.stringify(opts.output_data) : null,
      opts.confidence || null,
      opts.reasoning || null,
      opts.triggered_by || "system",
      opts.result || "pending",
      opts.cost_tokens || null,
      opts.duration_ms || null,
    ]);
    return r.rows[0].id;
  } catch (err) {
    // 日记失败不阻塞业务
    console.error("[ai-log] write failed:", err.message);
    return null;
  }
}

// 标记一个 AI 动作的结果（人工 review 后调用）
export async function markAIResult(opId, result, humanDiff, reviewerId) {
  if (!opId) return;
  try {
    const pool = getPool();
    await pool.query(`
      UPDATE ai_operations
      SET result = $2, human_diff = $3, reviewer_id = $4, reviewed_at = NOW()
      WHERE id = $1
    `, [opId, result, humanDiff ? JSON.stringify(humanDiff) : null, reviewerId || null]);
  } catch (err) {
    console.error("[ai-log] mark failed:", err.message);
  }
}
