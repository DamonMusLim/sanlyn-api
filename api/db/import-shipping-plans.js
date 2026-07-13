// /api/db/import-shipping-plans.js — One-time batch import for manually verified shipping plans
// POST { records: [...] }  — upserts on _id (PRIMARY KEY); caller must supply _id
// Supports the live schema: contract_no TEXT (singular), raw JSONB
import { getPool, setCors } from "../db.js";
import { mirrorPlanBlToOrders } from "../lib/bl-order-mirror.js"; // 2026-07-13: bl_no 镜像同步到 orders

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { records, verify_only } = req.body || {};

    // ── Verify-only mode: count rows and show recent inserts ──
    if (verify_only) {
      const countRes = await pool.query("SELECT COUNT(*) as total FROM shipping_plans");
      const recentRes = await pool.query(
        "SELECT _id, bl_no, contract_no, vessel, etd, created_by, created_at FROM shipping_plans ORDER BY created_at DESC LIMIT 30"
      );
      return res.status(200).json({
        success: true,
        total_rows: parseInt(countRes.rows[0].total),
        recent: recentRes.rows,
      });
    }

    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ error: "records[] required" });
    }

    const results = [];
    for (const d of records) {
      if (!d._id) {
        results.push({ ok: false, bl_no: d.bl_no, error: "_id required in each record" });
        continue;
      }

      const rawJson = JSON.stringify({
        group_key: d._group_key,
        bl_no: d.bl_no,
        contract_no: d.contract_no,
        vessel: d.vessel,
        etd: d.etd,
        source: "manual_verified",
        source_files: d.source_files || [],
        still_missing: d.still_missing || [],
      });

      const sql = `
        INSERT INTO shipping_plans
          (_id, bl_no, vessel, voyage, etd, eta, pol, pod, customer,
           contract_no, flow_status, created_by, raw, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9,
           $10, $11, $12, $13::jsonb, NOW(), NOW())
        ON CONFLICT (_id) DO UPDATE SET
          bl_no       = EXCLUDED.bl_no,
          vessel      = EXCLUDED.vessel,
          voyage      = EXCLUDED.voyage,
          etd         = COALESCE(shipping_plans.etd, EXCLUDED.etd),
          eta         = COALESCE(shipping_plans.eta, EXCLUDED.eta),
          pol         = EXCLUDED.pol,
          pod         = EXCLUDED.pod,
          customer    = EXCLUDED.customer,
          contract_no = EXCLUDED.contract_no,
          flow_status = EXCLUDED.flow_status,
          raw         = EXCLUDED.raw,
          updated_at  = NOW()
        RETURNING _id, bl_no, vessel, etd, contract_no
      `;

      const vals = [
        d._id,
        d.bl_no || null,
        d.vessel || null,
        d.voyage || null,
        d.etd || null,
        d.eta || null,
        d.pol || null,
        d.pod || null,
        d.customer || null,
        d.contract_no || null,
        "已出运",
        "system_import",
        rawJson,
      ];

      try {
        const r = await pool.query(sql, vals);
        const _blm = await mirrorPlanBlToOrders(pool, r.rows[0], "import");
        results.push({ ok: true, _id: d._id, bl_no: d.bl_no, row: r.rows[0], bl_mirror: _blm });
      } catch (e) {
        results.push({ ok: false, _id: d._id, bl_no: d.bl_no, error: e.message });
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;
    const countRes = await pool.query("SELECT COUNT(*) as total FROM shipping_plans");

    return res.status(200).json({
      success: fail === 0,
      inserted_ok: ok,
      inserted_fail: fail,
      total_rows_now: parseInt(countRes.rows[0].total),
      results,
    });
  } catch (err) {
    console.error("[import-shipping-plans]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
