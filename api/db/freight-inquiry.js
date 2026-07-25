import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 价格总台「去要报价」的闭环入口。复用 freight_rfqs / freight_rfq_items,不建新表。
// POST /api/db/freight-inquiry        建询价单(同航线同船司已 open 则不重复建)
// GET  /api/db/freight-inquiry?status=open  列询价单 + 各自收到几家回价
//
// 只建单、不写任何金额:报价数字一律等货代回价后走 freight_rfq_items,这里碰不到钱。

const norm = (v) => String(v == null ? "" : v).trim();

// "2026-07-26" / Date → YYYY-MM-DD;转不出来就 null(不拿今天兜底,守"缺显缺")
function toDateOrNull(v) {
  const s = norm(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function actorOf(req) {
  const u = req.user || {};
  return norm(u.username || u.email || u.name || u.id) || "freight-board";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const status = norm(req.query.status) || "open";
      const { rows } = await pool.query(
        `SELECT r.id AS rfq_id, r.pol, r.pod, r.ctnr_type, r.etd, r.status, r.created_at,
                r.request_meta->>'carrier_code' AS carrier_code,
                r.request_meta->>'carrier_name' AS carrier_name,
                r.request_meta->>'next_sailing' AS next_sailing,
                (SELECT count(*) FROM freight_rfq_items i WHERE i.rfq_id = r.id) AS item_count
           FROM freight_rfqs r
          WHERE r.status = $1
            AND r.request_meta->>'source' = 'freight-board'
          ORDER BY r.created_at DESC
          LIMIT 500`, [status]);
      return res.status(200).json({
        ok: true,
        items: rows.map((r) => ({
          rfq_id: r.rfq_id, pol: r.pol, pod: r.pod,
          carrierCode: r.carrier_code, carrierName: r.carrier_name,
          ctnrType: r.ctnr_type, nextSailing: r.next_sailing,
          status: r.status, createdAt: r.created_at,
          itemCount: Number(r.item_count) || 0,
        })),
      });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const b = req.body || {};
    const pol = norm(b.pol), pod = norm(b.pod);
    const carrierCode = norm(b.carrierCode) || norm(b.carrierName);
    if (!pol || !pod) return res.status(400).json({ ok: false, error: "pol / pod 必填" });

    // 防重:同 (pol, pod, carrierCode) 已有 open 的,不重复建
    const dup = await pool.query(
      `SELECT id FROM freight_rfqs
        WHERE status = 'open'
          AND lower(btrim(pol)) = lower(btrim($1))
          AND lower(btrim(pod)) = lower(btrim($2))
          AND lower(btrim(COALESCE(request_meta->>'carrier_code',''))) = lower(btrim($3))
        ORDER BY created_at DESC LIMIT 1`, [pol, pod, carrierCode]);
    if (dup.rows.length) {
      return res.status(200).json({ ok: true, deduped: true, rfq_id: dup.rows[0].id });
    }

    const meta = {
      source: "freight-board",
      created_from: "total_cost_compare",
      carrier_code: carrierCode || null,
      carrier_name: norm(b.carrierName) || null,
      route_code: norm(b.routeCode) || null,
      week_day: norm(b.weekDay) || null,
      transit_days: b.transitDays == null ? null : b.transitDays,
      next_sailing: norm(b.nextSailing) || null,
      is_consortium: !!b.isConsortium,
      consortium_carriers: Array.isArray(b.consortiumCarriers) ? b.consortiumCarriers : [],
      ask_items: Array.isArray(b.askItems) ? b.askItems : [],
      suggested_forwarders: Array.isArray(b.suggestedForwarders) ? b.suggestedForwarders : [],
      requested_by: actorOf(req),
    };

    const ins = await pool.query(
      `INSERT INTO freight_rfqs
         (id, route, pol, pod, etd, ctnr_type, status, service_type, created_by,
          created_at, updated_at, request_meta)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'open', 'ocean', $6, now(), now(), $7::jsonb)
       RETURNING id`,
      [`${pol}→${pod}`, pol, pod, toDateOrNull(b.nextSailing),
       norm(b.ctnrType) || "40HQ", actorOf(req), JSON.stringify(meta)]);

    return res.status(201).json({ ok: true, deduped: false, rfq_id: ins.rows[0].id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
