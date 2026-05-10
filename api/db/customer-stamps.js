// api/db/customer-stamps.js
// S96: Customer stamp persistence — CRUD for customer-uploaded seal images
// GET  ?username=xxx  — load stamps for a user
// POST { username, company_code, name, url }  — save a new stamp record
// DELETE { id, username }  — remove a stamp record

import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Auth: require valid JWT for all operations ──
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const isAdmin = req.user.role === "admin";
  // Derive the canonical username from JWT; ignore any client-supplied username for scope checks
  const callerUsername = req.user.sub || req.user.account || req.user.username || null;

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
      // Admin may pass ?username= to query any user; non-admin is locked to JWT identity
      const targetUsername = isAdmin ? (req.query.username || callerUsername) : callerUsername;
      if (!targetUsername) {
        return res.status(400).json({ error: 'username required' });
      }
      const result = await pool.query(
        `SELECT id, username, company_code, name, url, uploaded_at
         FROM customer_stamps
         WHERE username = $1 AND is_active = true
         ORDER BY uploaded_at DESC`,
        [targetUsername]
      );
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

    return res.status(405).json({ error: 'GET/POST/DELETE only' });
  } catch (err) {
    console.error('customer-stamps error:', err);
    return res.status(500).json({ error: err.message });
  }
}
