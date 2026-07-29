import { verifyToken } from '../auth.js';
import http from 'node:http';

const MINI_HOST = '100.87.134.113';
const MINI_PORT = 3801;
const TIMEOUT_MS = 25000;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const raw = String(auth).trim();
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
}

function requireDamonAdminJwt(req, res) {
  const user = verifyToken(getBearerToken(req));
  if (!user || !(user.role === 'admin' || (user.role === 'petstore' && user.username === 'damon'))) {
    json(res, 401, { success: false, error: 'Unauthorized', message: 'admin JWT required' });
    return null;
  }
  return user;
}

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function cleanDate(value) {
  const date = String(value || '').trim() || todayShanghai();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function fetchMini(date, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: MINI_HOST,
      port: MINI_PORT,
      path: `/digest/daily?date=${encodeURIComponent(date)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS,
      family: 4
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('request_timeout')); });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export default async function handler(req, res) {
  if (!requireDamonAdminJwt(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = cleanDate(req.query?.date);
  if (!date) return json(res, 400, { success: false, error: 'date must be YYYY-MM-DD' });

  const token = process.env.HERMES_API_TOKEN;
  if (!token) return json(res, 502, { success: false, error: 'HERMES_API_TOKEN not configured' });

  try {
    const upstream = await fetchMini(date, token);
    let body = null;
    try { body = upstream.body ? JSON.parse(upstream.body) : null; } catch (_) {}

    if (upstream.status === 404) return json(res, 404, { success: false, error: 'digest_not_found', date });
    if (upstream.status !== 200 || !body || body.ok !== true) {
      return json(res, 502, { success: false, error: 'mini_unreachable', detail: body?.error || upstream.body || `HTTP ${upstream.status}` });
    }
    return json(res, 200, { success: true, digest: body.digest });
  } catch (err) {
    return json(res, 502, { success: false, error: 'mini_unreachable', detail: `${err?.code || err?.name}: ${err?.message}` });
  }
}
