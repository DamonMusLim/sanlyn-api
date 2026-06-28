// export-certs.js
// 票级出口证书 — 每票货（shipping_plan）对应的商检/兽医/植检/熏蒸证书
//
// GET  /api/db/export-certs?plan_id=263          — 查某票所有证书
// GET  /api/db/export-certs?company_code=CN-001  — 查公司所有票证书
// POST /api/db/export-certs                      — 新建/upsert
// PATCH /api/db/export-certs/:id                 — 更新（上传文件/确认OCR/状态）

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";

var CERT_TYPES = ["ciq","vet_health","phyto","fumigation","co","fe","other"];

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

  // ── W0-2: tenant scope gate ──
  // Worker I GAP-IE-27: export_certs had NO tenant/company scope. Enforce here.
  //  - super_admin/admin: full visibility (audit logged for non-own queries)
  //  - any other role with companyCodes[]: results filtered to caller's codes
  //  - missing role OR empty companyCodes: 403 fail-closed
  var userRole = String((req.user && req.user.role) || "").toLowerCase();
  var userCodes = (req.user && (req.user.companyCodes
                    || (req.user.companyCode ? [req.user.companyCode] : []))) || [];
  var isAdmin   = (userRole === "admin" || userRole === "super_admin" || userRole === "root");
  if (!isAdmin && (!userCodes || userCodes.length === 0)) {
    return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
  }

  try {
    // ── GET ──
    if (req.method === "GET") {
      var { plan_id, company_code, cert_type: filterType, list } = req.query || {};
      var where = [], vals = [];
      if (plan_id)      { vals.push(plan_id);      where.push(`ec.shipping_plan_id = $${vals.length}`); }
      if (company_code) {
        if (!isAdmin && !userCodes.includes(company_code)) {
          return res.status(403).json({ error: "cross-company access denied" });
        }
        vals.push(company_code); where.push(`ec.company_code = $${vals.length}`);
      }
      if (filterType) { vals.push(filterType); where.push(`ec.cert_type = $${vals.length}`); }

      // FE list view: admin or scoped — allow listing all FE certs without plan_id
      if (!where.length && !isAdmin) {
        vals.push(userCodes);
        where.push(`ec.company_code = ANY($${vals.length}::text[])`);
      } else if (!where.length && isAdmin) {
        // admin with no filters → return all (for FE台账 list)
      }

      if (!isAdmin) {
        vals.push(userCodes);
        where.push(`ec.company_code = ANY($${vals.length}::text[])`);
      }

      var r = await pool.query(`
        SELECT ec.*,
               sp.bl_no  AS plan_bl_no,
               sp.vessel, sp.voyage,
               sp.etd    AS plan_etd,
               sp.pod,
               sp.order_contract_nos,
               -- docs_ready: check document_uploads by contract_no
               bool_or(du.doc_type = 'iv')                                              AS iv_ready,
               bool_or(du.doc_type = 'bl')                                              AS bl_ready,
               bool_or(du.doc_type IN ('customs_decl','customs_declaration'))           AS customs_ready,
               max(CASE WHEN du.doc_type='iv' THEN COALESCE(du.stamped_url, du.url) END) AS iv_url,
               max(CASE WHEN du.doc_type='bl' THEN COALESCE(du.stamped_url, du.url) END) AS bl_url,
               max(CASE WHEN du.doc_type IN ('customs_decl','customs_declaration')
                        THEN COALESCE(du.stamped_url, du.url) END)                       AS customs_url
        FROM export_certs ec
        LEFT JOIN shipping_plans sp ON sp.id = ec.shipping_plan_id
        LEFT JOIN document_uploads du ON du.contract_no = ec.contract_no
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        GROUP BY ec.id, sp.bl_no, sp.vessel, sp.voyage, sp.etd, sp.pod, sp.order_contract_nos
        ORDER BY ec.created_at DESC
      `, vals);

      // W0-2: admin cross-company access → audit log
      if (isAdmin && company_code && !userCodes.includes(company_code)) {
        writeAudit(pool, req, {
          action: "export_cert.admin_cross_company_read",
          entity_type: "export_cert",
          entity_id: null,
          after: { queried_company_code: company_code, queried_plan_id: plan_id || null,
                   admin_codes: userCodes },
        }).catch(() => {});
      }

      return res.status(200).json({ success: true, count: r.rows.length, certs: r.rows });
    }

    // ── POST: upsert ──
    if (req.method === "POST") {
      var b = req.body || {};
      var { shipping_plan_id, cert_type, cert_no, issue_date, expire_date,
            issuing_authority, file_url, status, ocr_raw, note, company_code,
            contract_no, po_no, shipper_name, consignee_name,
            bl_no_fe, vessel_voyage, etd_fe, eta_fe,
            invoice_no, cert_application_id, applied_date,
            printed_at, mailed_at, tracking_no,
            issues, is_external, fee_cny, fee_status,
            postage_by_client, mailing_address, requested_by } = b;

      if (!cert_type) {
        return res.status(400).json({ error: "cert_type required" });
      }
      // FE certs may not have a shipping_plan_id (external client)
      if (cert_type !== "fe" && !shipping_plan_id) {
        return res.status(400).json({ error: "shipping_plan_id required for non-FE certs" });
      }
      if (!CERT_TYPES.includes(cert_type)) {
        return res.status(400).json({ error: "invalid cert_type: " + CERT_TYPES.join("|") });
      }
      // W0-2: non-admin POST cannot create rows for a foreign company_code
      if (!isAdmin && company_code && !userCodes.includes(company_code)) {
        return res.status(403).json({ error: "cross-company write denied" });
      }
      // W0-2: non-admin POST must verify the shipping_plan belongs to caller's
      // scope AND must have a resolved company_code (no null fail-open).
      // Review-fix: when planCC is null OR caller omits company_code, inherit
      // from plan OR refuse — never silently create an unscoped row.
      if (!isAdmin) {
        if (!shipping_plan_id) {
          return res.status(400).json({ error: "shipping_plan_id required for non-admin POST" });
        }
        var planChk = await pool.query(
          "SELECT company_code FROM shipping_plans WHERE id = $1 LIMIT 1",
          [shipping_plan_id]
        );
        if (!planChk.rows.length) {
          return res.status(404).json({ error: "shipping_plan not found" });
        }
        var planCC = planChk.rows[0].company_code;
        // Plan with NULL company_code is unscoped — refuse (don't inherit ambiguity)
        if (!planCC) {
          return res.status(403).json({ error: "shipping_plan has no company_code; cannot scope cert" });
        }
        if (!userCodes.includes(planCC)) {
          return res.status(403).json({ error: "cross-company write denied" });
        }
        // W0-2 review fix 2: ALWAYS force company_code from plan for non-admin
        // POST. Don't trust caller-supplied value (could be a confused alias).
        // We already verified planCC ∈ userCodes above.
        company_code = planCC;
        b.company_code = planCC;
      }

      var r = await pool.query(`
        INSERT INTO export_certs
          (shipping_plan_id, company_code, cert_type, cert_no, issue_date, expire_date,
           issuing_authority, file_url, status, ocr_raw, note, created_by, updated_at,
           contract_no, po_no, shipper_name, consignee_name,
           bl_no_fe, vessel_voyage, etd_fe, eta_fe,
           invoice_no, cert_application_id, applied_date,
           issues, is_external, fee_cny, fee_status,
           postage_by_client, mailing_address, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),
                $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                $24,$25,$26,$27,$28,$29,$30)
        ON CONFLICT (shipping_plan_id, cert_type) DO UPDATE SET
          company_code      = COALESCE(export_certs.company_code, EXCLUDED.company_code),
          cert_no           = COALESCE(EXCLUDED.cert_no, export_certs.cert_no),
          issue_date        = COALESCE(EXCLUDED.issue_date, export_certs.issue_date),
          expire_date       = COALESCE(EXCLUDED.expire_date, export_certs.expire_date),
          issuing_authority = COALESCE(EXCLUDED.issuing_authority, export_certs.issuing_authority),
          file_url          = COALESCE(EXCLUDED.file_url, export_certs.file_url),
          status            = COALESCE(EXCLUDED.status, export_certs.status),
          ocr_raw           = CASE WHEN EXCLUDED.ocr_raw != '{}'::jsonb
                                   THEN EXCLUDED.ocr_raw ELSE export_certs.ocr_raw END,
          note              = COALESCE(EXCLUDED.note, export_certs.note),
          contract_no       = COALESCE(EXCLUDED.contract_no, export_certs.contract_no),
          invoice_no        = COALESCE(EXCLUDED.invoice_no, export_certs.invoice_no),
          status            = COALESCE(EXCLUDED.status, export_certs.status),
          issues            = COALESCE(EXCLUDED.issues, export_certs.issues),
          is_external       = COALESCE(EXCLUDED.is_external, export_certs.is_external),
          fee_cny           = COALESCE(EXCLUDED.fee_cny, export_certs.fee_cny),
          fee_status        = COALESCE(EXCLUDED.fee_status, export_certs.fee_status),
          updated_at        = NOW()
        RETURNING *
      `, [shipping_plan_id || null, company_code, cert_type, cert_no, issue_date, expire_date,
          issuing_authority, file_url, status || "pending",
          ocr_raw ? JSON.stringify(ocr_raw) : "{}", note,
          req.user.username || req.user.email,
          contract_no || null, po_no || null, shipper_name || null, consignee_name || null,
          bl_no_fe || null, vessel_voyage || null, etd_fe || null, eta_fe || null,
          invoice_no || null, cert_application_id || null, applied_date || null,
          issues ? JSON.stringify(issues) : "[]",
          is_external || false, fee_cny || 0, fee_status || (is_external ? "待收款" : "免费"),
          postage_by_client !== false, mailing_address || null, requested_by || null]);

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

      // W0-2: non-admin PATCH must verify target row belongs to caller's scope.
      // Review-fix: a row with NULL company_code is unscoped legacy data — refuse
      // rather than fail open.
      if (!isAdmin) {
        var ownChk = await pool.query(
          "SELECT company_code FROM export_certs WHERE id = $1 LIMIT 1",
          [targetId]
        );
        if (!ownChk.rows.length) return res.status(404).json({ error: "not found" });
        var rowCC = ownChk.rows[0].company_code;
        if (!rowCC) {
          return res.status(403).json({ error: "row has no company_code; cannot scope edit" });
        }
        if (!userCodes.includes(rowCC)) {
          return res.status(403).json({ error: "cross-company write denied" });
        }
      }

      var b2 = req.body || {};
      var sets = [], vals2 = [];
      var allowed = ["cert_no","issue_date","expire_date","issuing_authority",
                     "file_url","status","ocr_raw","ocr_confirmed","note",
                     "contract_no","po_no","shipper_name","consignee_name",
                     "bl_no_fe","vessel_voyage","etd_fe","eta_fe",
                     "invoice_no","cert_application_id","applied_date",
                     "printed_at","mailed_at","tracking_no",
                     "issues","is_external","fee_cny","fee_status",
                     "postage_by_client","mailing_address","requested_by"];
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
