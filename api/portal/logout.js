import { getPool, setCors } from '../db.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const uid = req.portalPermissions?.user?.id;
  if (!uid) {
    return res.status(401).json({ error: 'Portal auth token required', code: 'NO_USER' });
  }

  try {
    await getPool().query(
      'UPDATE portal_users SET sessions_valid_after = now() WHERE id = $1',
      [uid]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[portal/logout] revoke session error:', err.message);
    return res.status(500).json({ error: 'Logout failed', code: 'DB_ERROR' });
  }
}
