// cert-type-config.js
// Admin 管理 cert_type_config — 可新增/修改/停用证书类型
//
// GET    /api/db/cert-type-config              — 全列表（admin 看全部，其他按 role 过滤）
// POST   /api/db/cert-type-config              — 新增类型（admin only）
// PATCH  /api/db/cert-type-config/:cert_key   — 修改字段（admin only）
// DELETE /api/db/cert-type-config/:cert_key   — 软删除(active=false)（admin only）

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var isAdmin = ["admin","super_admin"].includes(req.user.role);
  var pool = getPool();

  try {
    // ── GET ──
    if (req.method === "GET") {
      var role = req.query?.role;
      var r = await pool.query(
        role
          ? `SELECT * FROM cert_type_config WHERE active=true AND $1 = ANY(company_roles) ORDER BY sort_order`
          : `SELECT * FROM cert_type_config ORDER BY sort_order`,
        role ? [role] : []
      );
      return res.status(200).json({ success: true, count: r.rows.length, types: r.rows });
    }

    if (!isAdmin) return res.status(403).json({ error: "admin only" });

    // ── POST: 新增 ──
    if (req.method === "POST") {
      var b = req.body || {};
      if (!b.cert_key || !b.cert_name_cn) {
        return res.status(400).json({ error: "cert_key + cert_name_cn required" });
      }
      var r = await pool.query(`
        INSERT INTO cert_type_config
          (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, warn_days, sort_order, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
        ON CONFLICT (cert_key) DO NOTHING
        RETURNING *
      `, [
        b.cert_key, b.cert_name_cn, b.cert_name_en || null,
        b.company_roles || ["factory"],
        b.required ?? false, b.expire_track ?? true,
        b.warn_days ?? 30, b.sort_order ?? 99,
      ]);
      if (!r.rows.length) return res.status(409).json({ error: "cert_key already exists" });
      return res.status(200).json({ success: true, type: r.rows[0] });
    }

    // ── PATCH ──
    if (req.method === "PATCH") {
      var keyMatch = (req.url || "").match(/\/cert-type-config\/([^?]+)/);
      var certKey = (req.body || {}).cert_key || (keyMatch && keyMatch[1]);
      if (!certKey) return res.status(400).json({ error: "cert_key required" });

      var b2 = req.body || {};
      var sets = [], vals = [];
      var allowed = ["cert_name_cn","cert_name_en","company_roles","required",
                     "expire_track","warn_days","sort_order","active"];
      for (var k of allowed) {
        if (b2[k] !== undefined) {
          vals.push(b2[k]); sets.push(`${k} = $${vals.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals.push(certKey);
      var r2 = await pool.query(
        `UPDATE cert_type_config SET ${sets.join(", ")} WHERE cert_key=$${vals.length} RETURNING *`,
        vals
      );
      if (!r2.rows.length) return res.status(404).json({ error: "cert_key not found" });
      return res.status(200).json({ success: true, type: r2.rows[0] });
    }

    // ── DELETE (soft) ──
    if (req.method === "DELETE") {
      var keyMatch2 = (req.url || "").match(/\/cert-type-config\/([^?]+)/);
      var delKey = req.query?.cert_key || (keyMatch2 && keyMatch2[1]);
      if (!delKey) return res.status(400).json({ error: "cert_key required" });
      await pool.query(`UPDATE cert_type_config SET active=false WHERE cert_key=$1`, [delKey]);
      return res.status(200).json({ success: true, message: "deactivated: " + delKey });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
