// /api/vessel-track.js
// Vercel Serverless Function — 4portun vessel tracking proxy
// Supports POST (preferred) and GET (legacy)
// 4portun API requires AppId + AppSecret in request BODY, not headers
// Vercel Serverless Function — 4portun vessel tracking proxy
// Supports POST (preferred) and GET (legacy)
// 4portun API requires AppId + AppSecret in request BODY, not headers

import { requireAuth } from "./auth.js";
import { getPool } from "./db.js";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const APP_ID = process.env.PORTUN_APP_ID || 'SHYBB';
  const APP_SECRET = process.env.PORTUN_SECRET;
  if (!APP_SECRET) return res.status(500).json({ error: 'Missing PORTUN_SECRET env var' });

  let blNo;
  if (req.method === 'POST') {
    blNo = req.body?.blNo || req.body?.blno;
  } else {
    blNo = req.query.blNo || req.query.blno;
  }
  if (!blNo) return res.status(400).json({ error: 'Missing blNo parameter' });
  if (req.user?.role === "customer") {
    const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
    if (!codes || codes.length === 0) {
      return res.status(403).json({ error: "Account scope missing — log out and log in again." });
    }
    try {
      const pool = getPool();
      const ownedBl = await pool.query(
        "SELECT 1 FROM shipping_plans WHERE bl_no = $1 AND customer = ANY($2::text[]) LIMIT 1",
        [blNo.trim().toUpperCase(), codes]
      );
      if (ownedBl.rowCount === 0) {
        return res.status(403).json({ error: "Forbidden: BL not in your account scope." });
      }
    } catch (dbErr) {
      return res.status(503).json({ error: "scope_check_unavailable", detail: dbErr.message });
    }
  }

  try {
    const response = await fetch('https://api.4portun.com/api/track/bl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AppId: APP_ID,
        AppSecret: APP_SECRET,
        blNo: blNo.trim().toUpperCase(),
      }),
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('[vessel-track] fetch error:', err);
    return res.status(500).json({ error: 'Upstream API error', detail: err.message });
  }
}
