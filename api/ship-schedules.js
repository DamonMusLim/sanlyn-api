import { getPool, setCors } from './db.js';

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const pool = getPool();
  const url = new URL(req.url, 'http://x');
  const route = url.searchParams.get('route');

  if (!route) {
    // 列出所有有数据的航线
    const { rows } = await pool.query(
      `SELECT DISTINCT route_label, pol, pod, max(updated_at) as last_sync
       FROM ship_schedules GROUP BY route_label, pol, pod ORDER BY route_label`
    );
    return res.json({ routes: rows });
  }

  const { rows } = await pool.query(
    `SELECT week_day, transit_days, carrier_name, route_code,
            this_week, next_sailing, all_departures
     FROM ship_schedules
     WHERE route_label=$1
     ORDER BY transit_days NULLS LAST, carrier_name`,
    [route]
  );

  return res.json({ route, rows });
}
