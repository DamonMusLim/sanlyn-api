// api/m3/scan-missing.js
// POST /api/m3/scan-missing
// 手动触发文件级缺失项扫描
//
// Request:  { shipment_no?: string }
//   - 传 shipment_no → 只扫描该 SP
//   - 不传         → 扫描全部 active SP（status 不为 completed/cancelled）
//
// Response: { success, scanned, generated, skipped }

import { getPool, setCors } from "../db.js";
import { scanMissingItems } from "../db/m3-merge.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const { shipment_no } = req.body || {};
  const pool = getPool();

  let shipmentNos = [];

  try {
    if (shipment_no && typeof shipment_no === "string" && shipment_no.trim()) {
      // 单 SP 模式
      shipmentNos = [shipment_no.trim()];
    } else {
      // 全量扫描：取所有 active SP（排除已完成/取消）
      const spRes = await pool.query(
        `SELECT shipment_no FROM shipping_plans
         WHERE status NOT IN ('completed','cancelled','deleted')
           AND shipment_no IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 500`
      );
      shipmentNos = spRes.rows.map(r => r.shipment_no);
    }
  } catch (err) {
    console.error("[M3_WRITE_FAIL]", JSON.stringify({
      stage: "scan_missing_handler.load_shipments", shipment_no: shipment_no || "all",
      file_type: "system", source_engine: "system",
      error: err.message || String(err), ts: new Date().toISOString(),
    }));
    return res.status(500).json({ success: false, error: err.message || "failed to load shipments" });
  }

  let totalGenerated = 0;
  let totalSkipped = 0;
  const errors = [];

  for (const sno of shipmentNos) {
    try {
      const result = await scanMissingItems({ shipment_no: sno, pool });
      totalGenerated += result.generated;
      totalSkipped += result.skipped;
    } catch (err) {
      errors.push({ shipment_no: sno, error: err.message });
      console.error("[M3_WRITE_FAIL]", JSON.stringify({
        stage: "scan_missing_handler.per_sp", shipment_no: sno,
        file_type: "system", source_engine: "system",
        error: err.message || String(err), ts: new Date().toISOString(),
      }));
    }
  }

  return res.status(200).json({
    success: true,
    scanned:   shipmentNos.length,
    generated: totalGenerated,
    skipped:   totalSkipped,
    errors:    errors.length > 0 ? errors : undefined,
  });
}
