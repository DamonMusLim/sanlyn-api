// export-certs.js
// 票级出口证书 — 每票货（shipping_plan）对应的商检/兽医/植检/熏蒸证书
//
// GET  /api/db/export-certs?plan_id=263          — 查某票所有证书
// GET  /api/db/export-certs?company_code=CN-001  — 查公司所有票证书
// POST /api/db/export-certs                      — 新建/upsert
// PATCH /api/db/export-certs/:id                 — 更新（上传文件/确认OCR/状态）

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";

var CERT_TYPES = ["ciq","vet_health","phyto","fumigation","co","other"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var pool = getPool();

  // ensure table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_certs (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shipping_plan_id INT REFERENCES shipping_plans(id) ON DELETE CASCADE,
      company_code     VARCHAR(32),
      cert_type        VARCHAR(32) NOT NULL,
      cert_no          VARCHAR(128),
      issue_date       DATE,
      expire_date      DATE,
      issuing_authority VARCHAR(256),
      file_url         VARCHAR(512),
      status           VARCHAR(16) DEFAULT 'pending',
      ocr_raw          JSONB DEFAULT '{}',
      ocr_confirmed    BOOLEAN DEFAULT false,
      note             TEXT,
      created_by       VARCHAR(64),
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shipping_plan_id, cert_type)
    );
    CREATE INDEX IF NOT EXISTS idx_export_certs_plan ON export_certs(shipping_plan_id);
    CREATE INDEX IF NOT EXISTS idx_export_certs_company ON export_certs(company_code);
  `);

  try {
    // ── GET ──
    if (req.method === "GET") {
      var { plan_id, company_code } = req.query || {};
      var where = [], vals = [];
      if (plan_id)      { vals.push(plan_id);      where.push(`ec.shipping_plan_id = $${vals.length}`); }
      if (company_code) { vals.push(company_code); where.push(`ec.company_code = $${vals.length}`); }
      if (!where.length) return res.status(400).json({ error: "plan_id or company_code required" });

      var r = await pool.query(`
        SELECT ec.*,
               sp.bl_no, sp.vessel, sp.voyage, sp.etd, sp.pod,
               sp.order_contract_nos
        FROM export_certs ec
        LEFT JOIN shipping_plans sp ON sp.id = ec.shipping_plan_id
        WHERE ${where.join(" AND ")}
        ORDER BY ec.cert_type, ec.created_at DESC
      `, vals);

      return res.status(200).json({ success: true, count: r.rows.length, certs: r.rows });
    }

    // ── POST: upsert ──
    if (req.method === "POST") {
      var b = req.body || {};
      var { shipping_plan_id, cert_type, cert_no, issue_date, expire_date,
            issuing_authority, file_url, status, ocr_raw, note, company_code } = b;

      if (!shipping_plan_id || !cert_type) {
        return res.status(400).json({ error: "shipping_plan_id + cert_type required" });
      }
      if (!CERT_TYPES.includes(cert_type)) {
        return res.status(400).json({ error: "invalid cert_type: " + CERT_TYPES.join("|") });
      }

      var r = await pool.query(`
        INSERT INTO export_certs
          (shipping_plan_id, company_code, cert_type, cert_no, issue_date, expire_date,
           issuing_authority, file_url, status, ocr_raw, note, created_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (shipping_plan_id, cert_type) DO UPDATE SET
          cert_no           = COALESCE(EXCLUDED.cert_no, export_certs.cert_no),
          issue_date        = COALESCE(EXCLUDED.issue_date, export_certs.issue_date),
          expire_date       = COALESCE(EXCLUDED.expire_date, export_certs.expire_date),
          issuing_authority = COALESCE(EXCLUDED.issuing_authority, export_certs.issuing_authority),
          file_url          = COALESCE(EXCLUDED.file_url, export_certs.file_url),
          status            = COALESCE(EXCLUDED.status, export_certs.status),
          ocr_raw           = CASE WHEN EXCLUDED.ocr_raw != '{}'::jsonb
                                   THEN EXCLUDED.ocr_raw ELSE export_certs.ocr_raw END,
          note              = COALESCE(EXCLUDED.note, export_certs.note),
          updated_at        = NOW()
        RETURNING *
      `, [shipping_plan_id, company_code, cert_type, cert_no, issue_date, expire_date,
          issuing_authority, file_url, status || "pending",
          ocr_raw ? JSON.stringify(ocr_raw) : "{}", note,
          req.user.username || req.user.email]);

      writeAudit(pool, req, {
        action: "export_cert.upsert", entity_type: "export_cert",
        entity_id: r.rows[0].id, after: { cert_type, cert_no, status },
      }).catch(() => {});

      return res.status(200).json({ success: true, cert: r.rows[0] });
    }

    // ── PATCH ──
    if (req.method === "PATCH") {
      var idMatch = (req.url || "").match(/\/export-certs\/([^?]+)/);
      var targetId = (req.body || {}).id || (idMatch && idMatch[1]);
      if (!targetId) return res.status(400).json({ error: "id required" });

      var b2 = req.body || {};
      var sets = [], vals2 = [];
      var allowed = ["cert_no","issue_date","expire_date","issuing_authority",
                     "file_url","status","ocr_raw","ocr_confirmed","note"];
      for (var k of allowed) {
        if (b2[k] !== undefined) {
          vals2.push(k === "ocr_raw" ? JSON.stringify(b2[k]) : b2[k]);
          sets.push(`${k} = $${vals2.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals2.push(new Date().toISOString()); sets.push(`updated_at = $${vals2.length}`);
      vals2.push(targetId);

      var r2 = await pool.query(
        `UPDATE export_certs SET ${sets.join(", ")} WHERE id = $${vals2.length} RETURNING *`,
        vals2
      );
      if (!r2.rows.length) return res.status(404).json({ error: "not found" });

      writeAudit(pool, req, {
        action: "export_cert.update", entity_type: "export_cert",
        entity_id: targetId, after: b2,
      }).catch(() => {});

      return res.status(200).json({ success: true, cert: r2.rows[0] });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[export-certs]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
