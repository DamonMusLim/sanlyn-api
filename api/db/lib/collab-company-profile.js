// token-scoped company profile for collab pages.
import fs from "fs";
import path from "path";
import { rawToHash } from "./collab-shared.js";

const UPLOAD_DIR = "/opt/sanlyn-uploads/company-licenses";
const ROLES = ["supplier_portal", "customer_booking", "factory_booking"];
const EDITABLE = [
  "legal_representative", "address", "business_license_no",
  "business_license_url", "biz_contact_name", "biz_contact_phone",
  "fin_contact_name", "fin_contact_phone",
];
const SELECT_COLS = [
  "id", "code", "name_cn", "name_en", "short_name", "contact_name",
  "contact_phone", "contact_email", "address", "address_en",
  "legal_representative", "business_license_no", "business_license_url",
  "biz_contact_name", "biz_contact_phone", "biz_contact_email",
  "fin_contact_name", "fin_contact_phone", "fin_contact_email", "profile_locked",
  "profile_locked_at", "customs_reg_code",
];

function clean(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

async function ensureColumns(pool) {
  await pool.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS business_license_no text,
      ADD COLUMN IF NOT EXISTS business_license_url text,
      ADD COLUMN IF NOT EXISTS biz_contact_name text,
      ADD COLUMN IF NOT EXISTS biz_contact_phone text,
      ADD COLUMN IF NOT EXISTS biz_contact_email text,
      ADD COLUMN IF NOT EXISTS fin_contact_name text,
      ADD COLUMN IF NOT EXISTS fin_contact_phone text,
      ADD COLUMN IF NOT EXISTS fin_contact_email text,
      ADD COLUMN IF NOT EXISTS profile_locked boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS profile_locked_at timestamptz`);
}

async function resolveToken(pool, raw) {
  if (!raw || raw.length < 10) return null;
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role=ANY($2::text[])
        AND expires_at>NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw), ROLES]
  );
  if (!rows.length) return null;
  const meta = typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta || {};
  const planId = parseInt(meta.shipment_id, 10);
  return { role: rows[0].recipient_role, meta, planId };
}

async function findCompany(pool, auth) {
  if (!auth) return null;
  if (auth.role === "supplier_portal") {
    const label = clean(auth.meta.company_label, 160);
    const code = clean(auth.meta.company_code || auth.meta.supplier_company_code, 80);
    if (!label && !code) return null;
    if (code) {
      const byCode = (await pool.query(
        `SELECT ${SELECT_COLS.join(",")} FROM companies WHERE code=$1 LIMIT 2`,
        [code]
      )).rows;
      if (byCode.length === 1) return byCode[0];
    }
    return findCompanyByNames(pool, [label]);
  }
  if (auth.role === "factory_booking") {
    const label = clean(auth.meta.factory_scope && auth.meta.factory_scope.label, 160);
    if (!label) return null;
    return findCompanyByNames(pool, [label], "type='factory' DESC, id");
  }
  const label = clean(auth.meta.customer_company_id || "", 80);
  if (label) {
    const byId = (await pool.query(
      `SELECT ${SELECT_COLS.join(",")} FROM companies WHERE id::text=$1 LIMIT 2`,
      [label]
    )).rows;
    if (byId.length === 1) return byId[0];
  }
  const plan = (await pool.query(
    `SELECT customer, customer_en FROM shipping_plans WHERE id=$1 LIMIT 1`,
    [auth.planId]
  )).rows[0] || {};
  return findCompanyByNames(pool, [clean(plan.customer, 160), clean(plan.customer_en, 160)]);
}

async function findCompanyByNames(pool, labels, orderBy = "id") {
  const names = Array.from(new Set(labels.map(v => clean(v, 160)).filter(Boolean)));
  if (!names.length) return null;
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS.join(",")} FROM companies
      WHERE merged_into_code IS NULL
        AND COALESCE(code,'') NOT ILIKE 'DEPRECATED%'
        AND (name_cn=ANY($1::text[]) OR name_en=ANY($1::text[]) OR short_name=ANY($1::text[]))
      ORDER BY ${orderBy} LIMIT 2`,
    [names]
  );
  if (rows.length > 1) return { ambiguous: true };
  return rows[0] || null;
}

async function handleCompanyProfile(req, res, pool) {
  await ensureColumns(pool);
  const raw = (req.method === "GET" ? req.query.token : req.body?.token) || "";
  const auth = await resolveToken(pool, raw);
  if (!auth || !auth.planId) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const company = await findCompany(pool, auth);
  if (company?.ambiguous) return res.status(409).json({ ok: false, error: "匹配到多家同名公司，请联系 Sanlyn 处理" });
  if (!company) return res.status(404).json({ ok: false, error: "未匹配到本方公司档案" });
  if (req.method === "GET") return res.json({ ok: true, role: auth.role, company });

  if (clean(req.body?.action, 40) === "upload_license") {
    const data = clean(req.body?.data_base64, 12 * 1024 * 1024);
    const filename = clean(req.body?.filename || "license.bin", 100).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
    const buf = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length || buf.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: "附件需在 8MB 以内" });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stored = `${company.code || company.id}_${Date.now()}_${filename}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    return res.json({ ok: true, url: `/uploads/company-licenses/${stored}` });
  }

  if (company.profile_locked) {
    return res.status(403).json({ ok: false, error: "资料已锁定，如需修改请联系 Sanlyn 运营解锁" });
  }
  const patch = req.body?.profile || {};
  const sets = [], vals = [];
  for (const k of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      vals.push(clean(patch[k], k.endsWith("_email") ? 160 : 800));
      sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "业务/财务邮箱由我方维护，如需修改请联系 Sanlyn" });
  vals.push(company.id);
  const { rows } = await pool.query(
    `UPDATE companies SET ${sets.join(",")}, profile_locked=true,
            profile_locked_at=COALESCE(profile_locked_at,NOW())
      WHERE id=$${vals.length} RETURNING ${SELECT_COLS.join(",")}`,
    vals
  );
  return res.json({ ok: true, company: rows[0] });
}

export { handleCompanyProfile, ensureColumns, findCompany };
