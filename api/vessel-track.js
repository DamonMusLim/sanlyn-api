/**
 * Vercel Serverless Function
 * 4portun API 代理 - 隐藏凭证，带 token 缓存
 *
 * 环境变量:
 *   PORTUN_APP_ID = SHYBB
 *   PORTUN_SECRET = +I(yuq!AQOBrc9gB
 */

const AUTH_URL = 'https://prod-api.4portun.com/openapi/auth/token';
const BASE_URL = 'https://prod-api.4portun.com/openapi/gateway/api/v2';

let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: process.env.PORTUN_APP_ID,
      secret: process.env.PORTUN_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error(`No token in response: ${JSON.stringify(data)}`);

  _cachedToken = data.token;
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return _cachedToken;
}

const EVENT_LABELS = {
  LOBD:     { label: '已装船',     icon: '📦' },
  DLPT:     { label: '已离港',     icon: '🚢' },
  BDAR:     { label: '抵达过境港', icon: '⚓' },
  BLPT:     { label: '离开过境港', icon: '🚢' },
  ARRIVALD: { label: '抵达目的港', icon: '🏁' },
  DSCH:     { label: '已卸货',     icon: '✅' },
  GATE_IN:  { label: '进场',       icon: '🔵' },
  GATE_OUT: { label: '出场',       icon: '🔵' },
};

function normalizeEvent(e) {
  const meta = EVENT_LABELS[e.eventCode] || { label: e.eventCode || '-', icon: '📍' };
  return {
    code: e.eventCode,
    label: meta.label,
    icon: meta.icon,
    location: e.portNameEn || e.portName || e.location || '',
    time: e.actualTime || e.planTime || '',
    isActual: !!e.actualTime,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
  };
}

export default async function handler(req, res) {
  // CORS - 只允许你自己的域名
  const origin = req.headers.origin || '';
  const allowed = ['https://ai.sanlynos.com', 'http://localhost:5173', 'http://localhost:3000'];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { blNo } = req.query;
  if (!blNo) return res.status(400).json({ error: 'blNo is required' });
  if (!/^[A-Z0-9\-]{4,30}$/.test(blNo.trim())) {
    return res.status(400).json({ error: 'Invalid blNo format' });
  }

  try {
    const token = await getToken();

    const trackRes = await fetch(`${BASE_URL}/getOceanTracking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ blNo: blNo.trim() }),
    });

    if (!trackRes.ok) throw new Error(`Tracking API failed: ${trackRes.status}`);

    const raw = await trackRes.json();

    // 业务层错误
    if (raw.code && raw.code !== 0 && raw.code !== '0') {
      return res.status(404).json({ error: raw.message || 'Not found', code: raw.code });
    }

    const events = (raw.containers?.[0]?.events || raw.events || []).map(normalizeEvent);
    const actualEvents = events.filter(e => e.isActual);

    const result = {
      blNo: blNo.trim(),
      vesselName: raw.vesselName || raw.vessel || '',
      voyageNo: raw.voyageNo || '',
      carrier: raw.carrierCode || raw.carrier || '',
      pol: raw.polName || raw.pol || '',
      pod: raw.podName || raw.pod || '',
      etd: raw.etd || '',
      eta: raw.eta || '',
      atd: raw.atd || '',
      ata: raw.ata || '',
      currentPosition: (raw.currentLat && raw.currentLng)
        ? { lat: parseFloat(raw.currentLat), lng: parseFloat(raw.currentLng) }
        : null,
      events,
      latestEvent: actualEvents.length > 0 ? actualEvents[actualEvents.length - 1] : null,
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(result);

  } catch (err) {
    console.error('[vessel-track]', err.message);
    return res.status(500).json({ error: 'Failed to fetch tracking data', detail: err.message });
  }
}
