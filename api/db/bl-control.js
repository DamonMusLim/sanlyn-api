// api/db/bl-control.js — S94: BL 放单状态控制 API
//
// POST /api/db/bl-control
//   action: "update_status" (默认) | "update_settings"
//
// GET /api/db/bl-control
//   ?status=uploaded|approved|released|rejected
//   ?contract=xxx
//
// BL 状态流: uploaded → approved → released → downloaded
//            uploaded → rejected → approved (重新审)

import { getPool, setCors } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

const VALID_STATUSES = ["uploaded", "approved", "released", "downloaded", "rejected"];

function _unquote(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.replace(/^"|"$/g, "");
  return String(v);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "POST") {
    if (!requireRole(req, res, ["admin", "logistics", "staff"])) return;
  } else {
    if (!requireAuth(req, res)) return;
  }

  const pool = getPool();

  // ═══ GET: 查询 BL 记录 ═══
  if (req.method === "GET") {
    try {
      const { status, contract } = req.query;
      let sql = `SELECT contract_no, shipment_no, bl_final, bl_draft,
                        raw, loading_details, updated_at
                 FROM customs_data
                 WHERE (bl_final IS NOT NULL OR bl_draft IS NOT NULL)`;
      const vals = [];

      // Tenant scope: non-admin users may only see records belonging to their company.
      // admin sees all rows (full-table access is intentional for operations).
      if (req.user.role !== "admin") {
        const userCompanyCode = req.user.companyCode || req.user.company_code || null;
        if (!userCompanyCode) {
          return res.status(403).json({ success: false, error: "No company scope — access denied" });
        }
        vals.push(userCompanyCode);
        // issuing_company is stored inside the raw JSONB column
        sql += ` AND (raw->>'issuing_company' = $${vals.length} OR raw->>'issuingCompany' = $${vals.length})`;
      }

      if (contract) {
        vals.push(contract);
        sql += ` AND contract_no = $${vals.length}`;
      }
      if (status && VALID_STATUSES.includes(status)) {
        vals.push(status);
        sql += ` AND raw->>'bl_status' = $${vals.length}`;
      }
      sql += " ORDER BY updated_at DESC";

      const result = await pool.query(sql, vals);

      const rows = result.rows.map(function (r) {
        const raw = r.raw || {};
        return {
          
          contract_no: r.contract_no,
          shipment_no: r.shipment_no,
          bl_final: r.bl_final,
          bl_draft: r.bl_draft,
          loading_details: r.loading_details,
          updated_at: r.updated_at,
          // BL 控制字段（从 raw 展平）
          bl_status: raw.bl_status || "uploaded",
          bl_controller: raw.bl_controller || "",
          bl_uploaded_by: raw.bl_uploaded_by || "",
          bl_approved_by: raw.bl_approved_by || "",
          bl_approved_at: raw.bl_approved_at || "",
          bl_released_by: raw.bl_released_by || "",
          bl_released_at: raw.bl_released_at || "",
          bl_release_method: raw.bl_release_method || "",
          bl_reject_reason: raw.bl_reject_reason || "",
          bl_rejected_by: raw.bl_rejected_by || "",
          bl_auto_release: !!raw.bl_auto_release,
          bl_release_threshold: Number(raw.bl_release_threshold) || 100,
          bl_ai_review: raw.bl_ai_review || null,
          bl_ai_review_detail: raw.bl_ai_review_detail || null,
          bl_history: raw.bl_history || [],
          // 业务信息（如果 raw 里有）
          issuing_company: raw.issuingCompany || raw.issuing_company || "",
        };
      });

      return res.status(200).json({ success: true, data: rows, count: rows.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ═══ POST: 更新 BL 状态 / 设置 ═══
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const { contract_no, action } = body;

      if (!contract_no) {
        return res.status(400).json({ success: false, error: "contract_no required" });
      }

      // 查现有记录
      const check = await pool.query(
        "SELECT id, raw FROM customs_data WHERE contract_no = $1 LIMIT 1",
        [contract_no]
      );
      if (check.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Record not found: " + contract_no });
      }

      const existingRaw = check.rows[0].raw || {};

      // ── update_settings: 自动放单设置 ──
      if (action === "update_settings") {
        const patch = {};
        if (body.bl_auto_release !== undefined) patch.bl_auto_release = !!body.bl_auto_release;
        if (body.bl_release_threshold !== undefined) patch.bl_release_threshold = Number(body.bl_release_threshold) || 100;

        const newRaw = Object.assign({}, existingRaw, patch);
        await pool.query(
          "UPDATE customs_data SET raw = $1::jsonb, updated_at = NOW() WHERE contract_no = $2",
          [JSON.stringify(newRaw), contract_no]
        );

        return res.status(200).json({ success: true, contract_no, action: "update_settings", settings: patch });
      }

      // ── update_status: BL 状态变更 ──
      const newStatus = body.bl_status;
      if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
        return res.status(400).json({ success: false, error: "Invalid bl_status. Valid: " + VALID_STATUSES.join(", ") });
      }

      // 状态流验证
      const currentStatus = existingRaw.bl_status || "uploaded";
      const TRANSITIONS = {
        uploaded:   ["approved", "rejected"],
        rejected:   ["approved", "uploaded"],
        approved:   ["released", "rejected"],
        released:   ["downloaded"],
        downloaded: [],
      };
      const allowed = TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(newStatus)) {
        return res.status(400).json({
          success: false,
          error: "Cannot transition " + currentStatus + " → " + newStatus + ". Allowed: " + (allowed.join(", ") || "none"),
        });
      }

      // 构建 patch
      const patch = { bl_status: newStatus };

      const actorId = req.user.username || String(req.user.uid) || "unknown";
      if (newStatus === "approved") {
        patch.bl_approved_by = actorId;
        patch.bl_approved_at = new Date().toISOString();
      }
      if (newStatus === "released") {
        patch.bl_released_by = actorId;
        patch.bl_released_at = new Date().toISOString();
        patch.bl_release_method = body.bl_release_method || "manual";
      }
      if (newStatus === "rejected") {
        patch.bl_rejected_by = actorId;
        patch.bl_reject_reason = body.bl_reject_reason || "";
      }
      if (newStatus === "downloaded") {
        patch.bl_downloaded_at = new Date().toISOString();
        patch.bl_downloaded_by = actorId;
      }

      if (body.bl_controller) patch.bl_controller = body.bl_controller;
      if (body.bl_uploaded_by) patch.bl_uploaded_by = body.bl_uploaded_by;

      // 追加历史记录
      const history = Array.isArray(existingRaw.bl_history) ? existingRaw.bl_history.slice() : [];
      history.push({
        from: currentStatus,
        to: newStatus,
        by: patch.bl_approved_by || patch.bl_released_by || patch.bl_rejected_by || "unknown",
        at: new Date().toISOString(),
        reason: body.bl_reject_reason || undefined,
      });

      const newRaw = Object.assign({}, existingRaw, patch, { bl_history: history });

      await pool.query(
        "UPDATE customs_data SET raw = $1::jsonb, updated_at = NOW() WHERE contract_no = $2",
        [JSON.stringify(newRaw), contract_no]
      );

      return res.status(200).json({
        success: true,
        contract_no,
        bl_status: newStatus,
        previous_status: currentStatus,
      });

    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
