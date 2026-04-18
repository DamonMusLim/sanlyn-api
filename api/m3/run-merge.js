// api/m3/run-merge.js
// POST /api/m3/run-merge
// 手动触发单个 SP 的 M3 Merge（三道门 + missing_items + 审计链）
//
// Request:  { shipment_no: string }
// Response: { success, shipment_no, stats }

import { getPool, setCors } from "../db.js";
import { runMerge } from "../db/m3-merge.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const { shipment_no } = req.body || {};

  if (!shipment_no || typeof shipment_no !== "string" || !shipment_no.trim()) {
    return res.status(400).json({ success: false, error: "shipment_no required" });
  }

  const sno = shipment_no.trim();

  try {
    const pool = getPool();

    // 验证 SP 存在
    const spCheck = await pool.query(
      `SELECT shipment_no FROM shipping_plans WHERE shipment_no=$1 LIMIT 1`,
      [sno]
    );
    if (spCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `shipment_no "${sno}" not found in shipping_plans`,
      });
    }

    const stats = await runMerge({ shipment_no: sno, pool });

    if (stats.error) {
      return res.status(500).json({ success: false, shipment_no: sno, error: stats.error, stats });
    }

    return res.status(200).json({ success: true, shipment_no: sno, stats });
  } catch (err) {
    console.error("[M3_WRITE_FAIL]", JSON.stringify({
      stage: "run_merge_handler", shipment_no: sno,
      file_type: "system", source_engine: "system",
      error: err.message || String(err), ts: new Date().toISOString(),
    }));
    return res.status(500).json({ success: false, error: err.message || "internal error" });
  }
}
