// api/db/customer-stamps.js
// S96: Customer stamp persistence — CRUD for customer-uploaded seal images
// GET  ?username=xxx  — load stamps for a user
// POST { username, company_code, name, url }  — save a new stamp record
// DELETE { id, username }  — remove a stamp record

import { getPool, setCors } from '../db.js';

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

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

    // ── GET: load stamps for a user ──
    if (req.method === 'GET') {
      const username = req.query.username;
      if (!username) {
        return res.status(400).json({ error: 'username required' });
      }
      const result = await pool.query(
        `SELECT id, username, company_code, name, url, uploaded_at
         FROM customer_stamps
         WHERE username = $1 AND is_active = true
         ORDER BY uploaded_at DESC`,
        [username]
      );
      return res.status(200).json({ success: true, stamps: result.rows });
    }

    // ── POST: save a new stamp record ──
    if (req.method === 'POST') {
      const { username, company_code, name, url } = req.body;
      if (!username || !url) {
        return res.status(400).json({ error: 'username and url required' });
      }
      const result = await pool.query(
        `INSERT INTO customer_stamps (username, company_code, name, url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, company_code, name, url, uploaded_at`,
        [username, company_code || null, name || 'Seal', url]
      );
      return res.status(200).json({ success: true, stamp: result.rows[0] });
    }

    // ── DELETE: soft-delete a stamp ──
    if (req.method === 'DELETE') {
      const { id, username } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }
      const result = await pool.query(
        `UPDATE customer_stamps SET is_active = false
         WHERE id = $1 AND username = $2
         RETURNING id`,
        [id, username || '']
      );
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
