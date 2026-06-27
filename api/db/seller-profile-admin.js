// GET  /api/db/seller-profile-admin?code=petbaby  → 单个 profile 全字段
// GET  /api/db/seller-profile-admin                → 所有 profiles（仅 code+name）
// PUT  /api/db/seller-profile-admin                → 更新单个 profile（admin only）
// POST /api/db/seller-profile-admin                → 新建 profile（admin only）

import { getPool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  if (req.method === "GET") {
    const { code } = req.query;
    if (code) {
      const r = await pool.query(
        `SELECT code, name_en, name_cn, address, address_en, tel, email, tax_no,
                bank_beneficiary, bank_name, bank_name_cn, bank_swift, bank_addr,
                usd_account, rmb_account, seal_url, stamp_code, is_default,
                terms_sc, terms_iv, terms_po
         FROM seller_profiles WHERE code=$1`, [code]
      );
      if (!r.rows.length) return res.status(404).json({ error: "not found" });
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `SELECT code, name_en, name_cn, is_default FROM seller_profiles ORDER BY is_default DESC, code`
    );
    return res.json({ profiles: r.rows });
  }

  if (!requireRole(req, res, ["admin"])) return;

  if (req.method === "PUT") {
    const b = req.body;
    if (!b.code) return res.status(400).json({ error: "code required" });
    const {
      code, name_en, name_cn, address, address_en, tel, email, tax_no,
      bank_beneficiary, bank_name, bank_name_cn, bank_swift, bank_addr,
      usd_account, rmb_account, seal_url, stamp_code, is_default,
      terms_sc, terms_iv, terms_po
    } = b;
    await pool.query(
      `UPDATE seller_profiles SET
        name_en=$2, name_cn=$3, address=$4, address_en=$5, tel=$6, email=$7, tax_no=$8,
        bank_beneficiary=$9, bank_name=$10, bank_name_cn=$11, bank_swift=$12, bank_addr=$13,
        usd_account=$14, rmb_account=$15, seal_url=$16, stamp_code=$17, is_default=$18,
        terms_sc=$19::jsonb, terms_iv=$20::jsonb, terms_po=$21::jsonb
       WHERE code=$1`,
      [
        code, name_en||"", name_cn||"", address||"", address_en||"", tel||"", email||"", tax_no||"",
        bank_beneficiary||"", bank_name||"", bank_name_cn||"", bank_swift||"", bank_addr||"",
        usd_account||"", rmb_account||"", seal_url||"", stamp_code||"", is_default||false,
        JSON.stringify(Array.isArray(terms_sc) ? terms_sc : []),
        JSON.stringify(Array.isArray(terms_iv) ? terms_iv : []),
        JSON.stringify(Array.isArray(terms_po) ? terms_po : []),
      ]
    );
    return res.json({ ok: true });
  }

  if (req.method === "POST") {
    const b = req.body;
    if (!b.code || !b.name_en) return res.status(400).json({ error: "code and name_en required" });
    await pool.query(
      `INSERT INTO seller_profiles (code, name_en, name_cn, address, tel, email, tax_no,
        bank_beneficiary, bank_name, bank_swift, usd_account, rmb_account, is_default,
        terms_sc, terms_iv, terms_po)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]','[]','[]')`,
      [b.code, b.name_en, b.name_cn||"", b.address||"", b.tel||"", b.email||"", b.tax_no||"",
       b.bank_beneficiary||"", b.bank_name||"", b.bank_swift||"",
       b.usd_account||"", b.rmb_account||"", false]
    );
    return res.status(201).json({ ok: true, code: b.code });
  }

  res.status(405).json({ error: "method not allowed" });
}
