// shipment-cert-gate.js
// Read-only product certificate gate for shipping plans.

import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

function productKey(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function certFromRow(row) {
  if (!row.cert_id) return null;
  var cert = {
    id: row.cert_id,
    product_key: row.product_key,
    product_label: row.cert_product_label,
    company_code: row.company_code,
    cert_key: row.cert_key,
    cert_no: row.cert_no,
    file_url: row.file_url,
    issue_date: row.issue_date,
    expire_date: row.expire_date,
    status: row.status,
    note: row.cert_note,
  };
  if (row.days_expired !== null && row.days_expired !== undefined) {
    cert.days_expired = Number(row.days_expired);
  }
  return cert;
}

function actionHint(reason, cert) {
  if (reason === "no_cert") return "向工厂索取首份证件";
  if (reason === "expired") {
    var certNo = cert?.cert_no || "";
    return "催工厂重新出具(可凭原报告号" + certNo + "去催)";
  }
  if (reason === "rejected_only") return "证件被驳回,需重新提交";
  return "证件有效,无需处理";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  var planId = String(req.query?.plan_id || "").trim();
  var blNo = String(req.query?.bl_no || "").trim();
  if (!planId && !blNo) {
    return res.status(400).json({ ok: false, error: "plan_id_or_bl_no_required" });
  }

  var pool = getPool();
  try {
    var planRes = await pool.query(`
      SELECT id, _id, shipment_no, bl_no, cargo_description
      FROM shipping_plans
      WHERE ($1 <> '' AND (id::text = $1 OR _id = $1 OR shipment_no = $1))
         OR ($2 <> '' AND bl_no = $2)
      ORDER BY id DESC
      LIMIT 1
    `, [planId, blNo]);

    if (planRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "shipping_plan_not_found" });
    }

    var plan = planRes.rows[0];
    var cargo = String(plan.cargo_description || "").trim();
    var outPlanId = plan.id;
    if (!cargo) {
      return res.status(200).json({
        ok: true,
        plan_id: outPlanId,
        cargo_description: plan.cargo_description,
        unknown_cargo: true,
        reason: "品名为空,判不了",
        required: [],
        blocked: true,
        missing: [],
      });
    }

    var rulesRes = await pool.query(`
      SELECT
        r.id AS rule_id, r.match_type, r.match_value, r.cert_key, r.note AS rule_note,
        pc.id AS cert_id, pc.product_key, pc.product_label AS cert_product_label,
        pc.company_code, pc.cert_no, pc.file_url, pc.issue_date, pc.expire_date,
        pc.status, pc.note AS cert_note, pc.reason_code, pc.days_expired
      FROM product_cert_rules r
      LEFT JOIN LATERAL (
        SELECT picked.*, state.reason_code
        FROM (
          SELECT CASE
            WHEN COUNT(*) = 0 THEN 'no_cert'
            WHEN BOOL_OR(COALESCE(pc.status, '') <> 'rejected'
              AND (pc.expire_date IS NULL OR pc.expire_date >= CURRENT_DATE)) THEN 'ok'
            WHEN BOOL_AND(COALESCE(pc.status, '') = 'rejected') THEN 'rejected_only'
            ELSE 'expired'
          END AS reason_code
          FROM product_certs pc
          WHERE pc.product_key = lower(regexp_replace(r.match_value, '\\s+', '', 'g'))
            AND pc.cert_key = r.cert_key
        ) state
        LEFT JOIN LATERAL (
          SELECT
            pc.*,
            CASE
              WHEN pc.expire_date < CURRENT_DATE THEN (CURRENT_DATE - pc.expire_date::date)::int
              ELSE NULL
            END AS days_expired
          FROM product_certs pc
          WHERE pc.product_key = lower(regexp_replace(r.match_value, '\\s+', '', 'g'))
            AND pc.cert_key = r.cert_key
            AND (
              (state.reason_code = 'ok'
                AND COALESCE(pc.status, '') <> 'rejected'
                AND (pc.expire_date IS NULL OR pc.expire_date >= CURRENT_DATE))
              OR (state.reason_code = 'expired'
                AND COALESCE(pc.status, '') <> 'rejected'
                AND pc.expire_date < CURRENT_DATE)
            )
          ORDER BY
            CASE WHEN state.reason_code = 'expired' THEN pc.expire_date END DESC NULLS LAST,
            CASE WHEN state.reason_code = 'ok' THEN pc.expire_date END ASC NULLS LAST,
            pc.updated_at DESC
          LIMIT 1
        ) picked ON true
        LIMIT 1
      ) pc ON true
      WHERE r.active = true
        AND r.match_type = 'keyword'
        AND position(lower(r.match_value) in lower($1)) > 0
      ORDER BY r.cert_key ASC, r.match_value ASC
    `, [cargo]);

    var required = rulesRes.rows.map(function(row) {
      var cert = certFromRow(row);
      var reason = row.reason_code || "no_cert";
      return {
        cert_key: row.cert_key,
        matched_rule: {
          id: row.rule_id,
          match_type: row.match_type,
          match_value: row.match_value,
          product_key: productKey(row.match_value),
          note: row.rule_note,
        },
        satisfied: reason === "ok",
        cert,
        reason,
        action_hint: actionHint(reason, cert),
      };
    });
    var missing = [...new Set(required.filter((r) => !r.satisfied).map((r) => r.cert_key))];

    return res.status(200).json({
      ok: true,
      plan_id: outPlanId,
      cargo_description: cargo,
      required,
      blocked: missing.length > 0,
      missing,
    });
  } catch (err) {
    console.error("[shipment-cert-gate]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
