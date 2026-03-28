// api/db/stamp-permissions.js
// GET  — 读取所有有效权限 (可选 ?stamp_key=babi 筛选)
// POST — 新增授权
// PATCH — 撤销授权 { id, revoked_by }

import { getPool } from './_pool.js';

export default async function handler(req, res) {
  const pool = getPool();

  try {
    // ── GET: 读取权限列表 ──
    if (req.method === 'GET') {
      const { stamp_key } = req.query || {};
      let sql = `
        SELECT id, stamp_key, granted_to, granted_by, permission_type,
               doc_types, max_per_day, valid_from, valid_until,
               is_active, revoked_at, revoked_by, created_at, notes
        FROM stamp_permissions
        WHERE is_active = true
      `;
      const vals = [];
      if (stamp_key) {
        vals.push(stamp_key);
        sql += ` AND stamp_key = $${vals.length}`;
      }
      sql += ` ORDER BY created_at DESC`;

      const result = await pool.query(sql, vals);
      return res.status(200).json({ success: true, permissions: result.rows });
    }

    // ── POST: 新增授权 ──
    if (req.method === 'POST') {
      const {
        stamp_key, granted_to, granted_by,
        permission_type = 'use',
        doc_types = [],
        max_per_day = 10,
        valid_until = null,
        notes = '',
      } = req.body;

      if (!stamp_key || !granted_to || !granted_by) {
        return res.status(400).json({ error: 'stamp_key, granted_to, granted_by required' });
      }

      // 先停用旧的同 key+user 授权 (如果有)
      await pool.query(
        `UPDATE stamp_permissions SET is_active = false, revoked_at = NOW(), revoked_by = $1
         WHERE stamp_key = $2 AND granted_to = $3 AND is_active = true`,
        [granted_by, stamp_key, granted_to]
      );

      const sql = `
        INSERT INTO stamp_permissions
          (stamp_key, granted_to, granted_by, permission_type, doc_types, max_per_day, valid_until, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;
      const result = await pool.query(sql, [
        stamp_key, granted_to, granted_by, permission_type,
        doc_types, max_per_day, valid_until || null, notes,
      ]);
      return res.status(200).json({ success: true, permission: result.rows[0] });
    }

    // ── PATCH: 撤销授权 ──
    if (req.method === 'PATCH') {
      const { id, revoked_by } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }

      const sql = `
        UPDATE stamp_permissions
        SET is_active = false, revoked_at = NOW(), revoked_by = $1
        WHERE id = $2
        RETURNING *
      `;
      const result = await pool.query(sql, [revoked_by || 'unknown', id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Permission not found' });
      }
      return res.status(200).json({ success: true, permission: result.rows[0] });
    }

    return res.status(405).json({ error: 'GET/POST/PATCH only' });

  } catch (err) {
    console.error('stamp-permissions error:', err);
    return res.status(500).json({ error: err.message });
  }
}
