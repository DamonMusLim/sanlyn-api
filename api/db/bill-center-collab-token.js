import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { actor, bad, requireFinance } from "./bill-center-auth.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function genRaw() {
  return crypto.randomBytes(32).toString("hex");
}

function baseUrl(req) {
  return process.env.BILL_CENTER_BASE_URL || `${req.headers.origin || ""}/bill-center-collab`;
}

export async function createCollabToken(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (!requireFinance(req, res)) return;
  const b = req.body || {};
  const meta = {
    bill_scope: "v1",
    direction: b.direction === "payable" ? "payable" : "receivable",
    bl_no: String(b.bl_no || "").trim(),
    payer_company_code: String(b.payer_company_code || "").trim(),
    supplier_company_code: b.supplier_company_code ? String(b.supplier_company_code).trim() : null,
    allowed_categories: Array.isArray(b.allowed_categories) ? b.allowed_categories : [],
    allowed_actions: Array.isArray(b.allowed_actions) ? b.allowed_actions : ["submit_invoice", "submit_lines"],
    display_profile: b.display_profile || "customer",
  };
  if (!meta.bl_no || !meta.payer_company_code) {
    return bad(res, 400, "missing_scope", "bl_no and payer_company_code required");
  }
  const raw = genRaw();
  const hash = rawToHash(raw);
  const hours = Math.min(Math.max(Number(b.expires_hours || 168), 1), 720);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE magic_links
          SET revoked_at = NOW()
        WHERE recipient_role = 'bill_collab'
          AND meta->>'bill_scope' = 'v1'
          AND meta->>'bl_no' = $1
          AND meta->>'payer_company_code' = $2
          AND COALESCE(meta->>'supplier_company_code', '') = COALESCE($3, '')
          AND revoked_at IS NULL`,
      [meta.bl_no, meta.payer_company_code, meta.supplier_company_code]
    );
    await client.query(
      `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at, created_by)
       VALUES ($1, 'bill_collab', $2::jsonb, NOW() + ($3 || ' hours')::interval, '[]'::jsonb, NOW(), $4)`,
      [hash, JSON.stringify(meta), String(hours), actor(req)]
    );
    await client.query("COMMIT");
    return res.status(201).json({ success: true, token: raw, url: `${baseUrl(req)}?token=${encodeURIComponent(raw)}`, meta });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
