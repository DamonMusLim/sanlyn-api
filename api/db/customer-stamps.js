// api/db/customer-stamps.js
// S96: Customer stamp persistence — CRUD for customer-uploaded seal images
// GET  ?username=xxx  — load stamps for a user
// POST { username, company_code, name, url }  — save a new stamp record
// DELETE { id, username }  — remove a stamp record

import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Auth: require valid JWT for all operations ──
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const isAdmin = req.user.role === "admin";
  // Derive canonical username from JWT — fail-closed if absent.
  const callerUsername = req.user.sub || req.user.account || req.user.username || null;
  if (!callerUsername) {
    return res.status(403).json({ error: "Account identity missing — please log in again." });
  }

  try {
    // ── ensure table exists ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_stamps (
        id            SERIAL PRIMARY KEY,
        username      TEXT NOT NULL,
        company_code  TEXT,
        name          TEXT NOT NULL DEFAULT 'Seal',
        url           TEXT NOT NULL,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active     BOOLEAN NOT NULL DEFAULT true
      )
    `);

    // ── GET: load stamps — non-admin sees only their own ──
    if (req.method === 'GET') {
      // Admin may pass ?username= to query any user; non-admin is locked to JWT identity.
      // Admin username param: validate type + length to prevent log pollution.
      let targetUsername = callerUsername;
      if (isAdmin && req.query.username) {
        const q = String(req.query.username).trim();
        if (q.length === 0 || q.length > 128) {
          return res.status(400).json({ error: "username must be 1–128 characters" });
        }
        targetUsername = q;
      }
      if (!targetUsername) {
        return res.status(400).json({ error: 'username required' });
      }
      // 可选 ?company_code= 过滤:公司资产,admin可跨用户查该公司的章;非admin仍锁自己
      const _cc = req.query.company_code ? String(req.query.company_code).trim() : '';
      const _cols = `SELECT id, username, company_code, name, url, uploaded_at, is_default, shape FROM customer_stamps`;
      let result;
      if (_cc) {
        result = isAdmin
          ? await pool.query(`${_cols} WHERE company_code = $1 AND is_active = true ORDER BY is_default DESC, uploaded_at DESC`, [_cc])
          : await pool.query(`${_cols} WHERE username = $1 AND company_code = $2 AND is_active = true ORDER BY is_default DESC, uploaded_at DESC`, [targetUsername, _cc]);
      } else {
        result = await pool.query(`${_cols} WHERE username = $1 AND is_active = true ORDER BY is_default DESC, uploaded_at DESC`, [targetUsername]);
      }
      return res.status(200).json({ success: true, stamps: result.rows });
    }

    // ── POST: save a new stamp — username locked to JWT identity ──
    if (req.method === 'POST') {
      const { company_code, name, url } = req.body;
      // username is taken from JWT, not from client body
      const stampUsername = callerUsername;
      if (!stampUsername || !url) {
        return res.status(400).json({ error: 'authenticated username and url required' });
      }
      const result = await pool.query(
        `INSERT INTO customer_stamps (username, company_code, name, url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, company_code, name, url, uploaded_at`,
        [stampUsername, company_code || null, name || 'Seal', url]
      );
      return res.status(200).json({ success: true, stamp: result.rows[0] });
    }

    // ── DELETE: soft-delete — non-admin can only delete their own stamps ──
    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }
      // Non-admin: enforce username = callerUsername so cross-user deletion is impossible
      const sql = isAdmin
        ? `UPDATE customer_stamps SET is_active = false WHERE id = $1 RETURNING id`
        : `UPDATE customer_stamps SET is_active = false WHERE id = $1 AND username = $2 RETURNING id`;
      const params = isAdmin ? [id] : [id, callerUsername];
      const result = await pool.query(sql, params);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Stamp not found' });
      }
      return res.status(200).json({ success: true, deleted: result.rows[0].id });
    }

    // ── PATCH: 设为默认(固定)章 — 触发器自动把同公司其他章取消默认 ──
    if (req.method === 'PATCH') {
      const { id, set_default, name } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (set_default) {
        const sql = isAdmin
          ? `UPDATE customer_stamps SET is_default = true WHERE id = $1 AND is_active = true RETURNING id`
          : `UPDATE customer_stamps SET is_default = true WHERE id = $1 AND username = $2 AND is_active = true RETURNING id`;
        const params = isAdmin ? [id] : [id, callerUsername];
        const result = await pool.query(sql, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Stamp not found' });
        return res.status(200).json({ success: true, default_id: result.rows[0].id });
      }
      // 改名: 校验非空 + 长度; 非admin只能改自己的章
      if (typeof name === 'string') {
        const nm = name.trim();
        if (!nm || nm.length > 64) return res.status(400).json({ error: 'name must be 1–64 chars' });
        const sql = isAdmin
          ? `UPDATE customer_stamps SET name = $1 WHERE id = $2 AND is_active = true RETURNING id, name`
          : `UPDATE customer_stamps SET name = $1 WHERE id = $2 AND username = $3 AND is_active = true RETURNING id, name`;
        const params = isAdmin ? [nm, id] : [nm, id, callerUsername];
        const result = await pool.query(sql, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Stamp not found' });
        return res.status(200).json({ success: true, id: result.rows[0].id, name: result.rows[0].name });
      }
      return res.status(400).json({ error: 'set_default or name required' });
    }

    return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
  } catch (err) {
    console.error('customer-stamps error:', err);
    return res.status(500).json({ error: err.message });
  }
}
