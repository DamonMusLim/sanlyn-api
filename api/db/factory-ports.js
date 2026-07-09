// factory-ports.js — 工厂就近港口(起运港来源) 2026-07-09
// GET /api/db/factory-ports → { success, data:[{company_code, ports}] }
// 用于 export-docs 起运港:该票 orders.pol 空时,按工厂 factories.ports[0] 带(工厂就近港,1-2个)。
import { getPool, setCors } from './db.js';

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
  const pool = getPool();
  try {
    const r = await pool.query(
      "SELECT company_code, ports FROM factories WHERE ports IS NOT NULL AND array_length(ports,1) > 0"
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: r.rows }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
