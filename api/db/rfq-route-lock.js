import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function firstDeparture(row) {
  const arr = Array.isArray(row.all_departures)
    ? row.all_departures
    : (typeof row.all_departures === "string" ? JSON.parse(row.all_departures || "[]") : []);
  return arr[0] || {};
}

function etdFor(row) {
  const dep = firstDeparture(row);
  return row.next_sailing || dep.etd || null;
}

function isValidRow(row) {
  return !!row.carrier_name && (etdFor(row) != null || row.transit_days != null);
}

function toRouteEntry(row) {
  const dep = firstDeparture(row);
  return {
    carrier: row.carrier_name,
    vessel: dep.vessel || null,
    voyage: dep.voyage || null,
    etd: etdFor(row),
    transit_days: row.transit_days ?? null,
    via: null,
  };
}

// 读 ship_schedules(维运网同步表，只读)，按 pol/pod 英文名匹配（大小写不敏感）
// 只读 ship_schedules，绝不碰 freight_rates
async function buildSnapshot(pool, pol, pod) {
  const { rows } = await pool.query(
    `SELECT pol, pod, carrier_name, transit_days, next_sailing, all_departures, updated_at
       FROM ship_schedules
      WHERE lower(pol) = lower($1) AND lower(pod) = lower($2)
      ORDER BY updated_at DESC`,
    [pol, pod]
  );
  const base = { source: "weiyun", pol: { matched: pol }, pod: { matched: pod }, fetched_at: new Date().toISOString() };

  if (!rows.length) {
    return { ok: false, reason: "port_not_found", snapshot: { ok: false, ...base, valid_route_rows: 0, routes: [] } };
  }

  const validRows = rows.filter(isValidRow);
  if (!validRows.length) {
    return { ok: false, reason: "empty_route", snapshot: { ok: false, ...base, valid_route_rows: 0, routes: rows.map(toRouteEntry) } };
  }

  const fetchedAt = rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), rows[0].updated_at);
  return {
    ok: true,
    snapshot: {
      ok: true,
      source: "weiyun",
      pol: { matched: rows[0].pol },
      pod: { matched: rows[0].pod },
      fetched_at: new Date(fetchedAt).toISOString(),
      valid_route_rows: validRows.length,
      routes: validRows.map(toRouteEntry),
    },
  };
}

// POST /api/db/rfq-route-lock  { rfq_id }
// 询价单锁定航线：读 ship_schedules 快照 → 写 freight_rfqs.request_meta.weiyun_route_snapshot
// + route_locked_at + route_lock_status(success/failed)。只读 ship_schedules，只写 request_meta。
async function lockRoute(req, res, pool) {
  const rfqId = (req.body || {}).rfq_id;
  if (!rfqId) return res.status(400).json({ ok: false, error: "rfq_id_required" });

  const { rows } = await pool.query(`SELECT id, pol, pod FROM freight_rfqs WHERE id = $1`, [rfqId]);
  if (!rows.length) return res.status(404).json({ ok: false, error: "rfq_not_found" });
  const rfq = rows[0];
  if (!rfq.pol || !rfq.pod) return res.status(400).json({ ok: false, error: "rfq_missing_pol_pod" });

  const result = await buildSnapshot(pool, rfq.pol, rfq.pod);
  const lockedAt = new Date().toISOString();
  const status = result.ok ? "success" : "failed";

  await pool.query(
    `UPDATE freight_rfqs
        SET request_meta = COALESCE(request_meta, '{}'::jsonb)
              || jsonb_build_object(
                   'weiyun_route_snapshot', $2::jsonb,
                   'route_locked_at', $3::text,
                   'route_lock_status', $4::text
                 ),
            updated_at = NOW()
      WHERE id = $1`,
    [rfqId, JSON.stringify(result.snapshot), lockedAt, status]
  );

  return res.json({
    ok: result.ok,
    rfq_id: rfqId,
    route_lock_status: status,
    reason: result.ok ? undefined : result.reason,
    snapshot: result.snapshot,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  return lockRoute(req, res, pool);
}
