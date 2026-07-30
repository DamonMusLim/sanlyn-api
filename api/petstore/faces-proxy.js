// api/petstore/faces-proxy.js — authenticated pass-through to the mini camera/faces backend.
// Data owner = mini jimeng-proxy (pm2 "sanlyn-mini-api", tailscale 100.87.134.113:3721,
// routes-petstore-faces.mjs: sqlite face_registry/camera_events + local pics dir).
// mini's own gate only rejects browser Origins — server-to-server requests carry no Origin
// header and pass — so the REAL auth boundary is here: admin/petstore identities only.
// Faces of real people (staff + customers) must never be reachable by customer/factory/
// forwarder tokens even though the global authMiddleware lets any logged-in account into /api/*.
// 2026-07-31, wired for PetstoreFacesModule (frontend ENDPOINTS.petstore_faces_*).
import { setCors } from '../db.js';
import { extractUser } from '../auth.js';

const MINI_BASE = process.env.MINI_FACES_BASE || 'http://100.87.134.113:3721';

function isAllowed(user) {
  const role = String(user?.role || '').toLowerCase();
  if (['admin', 'superadmin', 'super_admin', 'petstore'].includes(role)) return true;
  const access = Array.isArray(user?.access) ? user.access : [];
  return access.includes('petstore');
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, error: 'GET/POST only' });

  if (!req.user) { try { extractUser(req); } catch (_) {} }
  if (!isAllowed(req.user)) {
    return res.status(403).json({ success: false, error: 'Forbidden: admin/petstore only' });
  }

  try {
    // Strip the ?token= query (used by <img> tags for auth on OUR side) before forwarding —
    // the JWT has no business travelling to mini or landing in its logs.
    const rawUrl = req.originalUrl || req.url || '';
    const [pathPart, queryPart = ''] = rawUrl.split('?');
    const qs = new URLSearchParams(queryPart);
    qs.delete('token');
    const target = MINI_BASE + pathPart + (qs.toString() ? '?' + qs.toString() : '');

    const init = { method: req.method, headers: { accept: req.headers.accept || '*/*' }, signal: AbortSignal.timeout(10000) };
    if (req.method === 'POST') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(req.body || {});
    }

    const r = await fetch(target, init);
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).set('Content-Type', ct);
    if (ct.startsWith('image/')) res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error('faces-proxy error:', err?.message || err);
    return res.status(timedOut ? 504 : 502).json({
      success: false,
      error: timedOut ? 'mini faces backend timeout (tailscale down? `ssh mini "sudo systemctl restart tailscaled"`)' : 'mini faces backend unreachable: ' + (err?.message || 'unknown'),
    });
  }
}
