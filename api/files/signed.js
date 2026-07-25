// GET /api/files/signed?key=shipping/WP-62/customs_WP62.pdf
// JWT验证 → 返回 OSS 预签名 URL (1h)
// 兼容旧 https://ai.sanlyn.cn/assets/ URL

import OSS from 'ali-oss';
import { requireAuth } from '../auth.js';
import { setCors } from '../db.js';

const ALLOWED_PREFIXES = ['shipping/', 'contracts/', 'trucking/', 'generated/', 'public/'];

function validateKey(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('key_missing');
  if (raw.length > 1024) throw new Error('key_too_long');
  const k = decodeURIComponent(raw);
  if (k.includes('../') || k.includes('..\\')) throw new Error('key_traversal');
  if (!ALLOWED_PREFIXES.some(p => k.startsWith(p))) throw new Error('key_prefix_not_allowed');
  return k;
}

function legacyUrlToKey(url) {
  const PREFIX = 'https://ai.sanlyn.cn/assets/';
  if (!url.startsWith(PREFIX)) return null;
  const f = url.slice(PREFIX.length);
  if (f.includes('/') || f.includes('\\')) return null;
  return 'contracts/legacy/' + f;
}

let _oss;
function getOSS() {
  if (!_oss) _oss = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hongkong',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'sanlyn-files',
    secure: true,
  });
  return _oss;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.end();
  if (!requireAuth(req, res)) return;

  try {
    let rawKey = req.query.key;
    if (!rawKey) return res.status(400).json({ error: 'key_missing' });

    // 兼容旧 ai.sanlyn.cn URL
    if (rawKey.startsWith('https://ai.sanlyn.cn/')) {
      rawKey = legacyUrlToKey(rawKey);
      if (!rawKey) return res.status(400).json({ error: 'legacy_url_invalid' });
    }

    const key = validateKey(rawKey);
    const oss = getOSS();
    const url = oss.signatureUrl(key, { expires: 3600, method: 'GET' });

    return res.json({
      url,
      key,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  } catch (err) {
    const safe = ['key_missing','key_too_long','key_traversal','key_prefix_not_allowed'];
    const code = safe.includes(err.message) ? err.message : 'sign_failed';
    return res.status(400).json({ error: code });
  }
}
