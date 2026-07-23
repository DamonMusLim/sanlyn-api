import { getPool, setCors } from "../db.js";
import { requireRole } from "../auth.js";
import { median } from "./lib/rfq-pricing.js";

const INTERNAL_ROLES = ["admin", "finance"];

function pathTail(req) {
  return String(req.path || req.url || "").split("?")[0].replace(/^\/api\/db\/pricing-desk\/?/, "");
}

function money(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dateISO(v) {
  if (!v) return null;
  // DATE 列在东八区服务器上是本地午夜，用本地日期组件避免 toISOString 掉一天
  if (typeof v === "string") { const m = v.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

function ageDays(row) {
  const d = dateISO(row.sail_date || row.valid_from || row.created_at);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(d + "T00:00:00Z").getTime()) / 864e5));
}

// 2026-07-23 港口规范化补齐：pod_port_id 存在时优先按 port_id 分组
// （同一真实港口的不同写法归一条 lane），NULL(未解析)才回退文本。
// 注：这里不做 marketplace.js 那种 Johor/Pasir Gudang 港口记录级折叠——pricing-desk
// 原来就是按纯文本分组(两者本就各自一条lane)，本次改造不额外引入新的合并，只解决
// pod_port_id 能收窄的场景(如 Port Klang 多写法)。
function laneKey(pol, pod, podPortId) {
  const podPart = podPortId != null ? `pid:${podPortId}` : String(pod || "").trim();
  return `${String(pol || "").trim()}→${podPart}`;
}

function safeRateRow(r) {
  return {
    id: r.id,
    pol: r.pol,
    pod: r.pod,
    carrier: r.carrier,
    customer_gp20: r.customer_gp20 == null ? null : Number(r.customer_gp20),
    customer_hq40: r.customer_hq40 == null ? null : Number(r.customer_hq40),
    valid_from: dateISO(r.valid_from),
    sail_date: dateISO(r.sail_date),
    free_days_base: r.free_days_base,
    free_days_ext: r.free_days_ext,
    remarks: r.remarks || null,
  };
}

async function handleQuotes(pool, res) {
  const { rows } = await pool.query(`
    SELECT r.id, r.pol, r.pod, r.pod_port_id, r.pol_port_id, r.carrier, r.forwarder, r.supplier_id,
           r.gp20::numeric AS gp20, r.hq40::numeric AS hq40,
           r.customer_gp20::numeric AS customer_gp20,
           r.customer_hq40::numeric AS customer_hq40,
           r.sail_date, r.next_sailing, r.free_days_base, r.free_days_ext,
           r.remarks, r.source, r.status, r.valid_from, r.created_at,
           p.name_en AS pod_canonical_name
      FROM freight_rates r
      LEFT JOIN ports p ON p.id = r.pod_port_id
     WHERE (r.gp20 IS NOT NULL OR r.hq40 IS NOT NULL)
       AND COALESCE(r.source,'') NOT IN ('manual_price')
       AND COALESCE(r.sail_date, r.valid_from, r.created_at::date) >= CURRENT_DATE - INTERVAL '365 days'
     ORDER BY lower(btrim(r.pol)), lower(btrim(r.pod)),
              COALESCE(r.sail_date, r.valid_from, r.created_at::date) DESC NULLS LAST,
              r.id DESC
  `);

  const lanes = new Map();
  for (const r of rows) {
    const podDisplay = r.pod_canonical_name || String(r.pod || "").trim();
    const key = laneKey(r.pol, r.pod, r.pod_port_id);
    if (!lanes.has(key)) lanes.set(key, {
      key,
      pol: String(r.pol || "").trim(),
      pod: podDisplay,
      pod_port_id: r.pod_port_id ?? null,
      quotes: [],
      active: [],
      suggestion: { gp20: null, hq40: null, gp20_samples: 0, hq40_samples: 0 },
    });
    const lane = lanes.get(key);
    lane.quotes.push({
      id: r.id,
      pol: r.pol,
      pod: r.pod,
      carrier: r.carrier,
      forwarder: r.forwarder,
      supplier_id: r.supplier_id,
      gp20: r.gp20 == null ? null : Number(r.gp20),
      hq40: r.hq40 == null ? null : Number(r.hq40),
      sail_date: dateISO(r.sail_date || r.next_sailing || r.valid_from),
      free_days_base: r.free_days_base,
      free_days_ext: r.free_days_ext,
      remarks: r.remarks || "",
      source: r.source,
      age_days: ageDays(r),
      old: ageDays(r) != null && ageDays(r) > 30,
    });
  }

  const active = await pool.query(`
    SELECT r.id, r.pol, r.pod, r.pod_port_id, r.pol_port_id, r.carrier, r.customer_gp20::numeric AS customer_gp20,
           r.customer_hq40::numeric AS customer_hq40, r.valid_from, r.sail_date,
           r.free_days_base, r.free_days_ext, r.remarks,
           p.name_en AS pod_canonical_name
      FROM freight_rates r
      LEFT JOIN ports p ON p.id = r.pod_port_id
     WHERE r.status = 'active'
       AND (r.customer_gp20 IS NOT NULL OR r.customer_hq40 IS NOT NULL)
     ORDER BY lower(btrim(r.pol)), lower(btrim(r.pod)), lower(btrim(r.carrier)), r.id DESC
  `);
  for (const r of active.rows) {
    const podDisplay = r.pod_canonical_name || String(r.pod || "").trim();
    const key = laneKey(r.pol, r.pod, r.pod_port_id);
    if (!lanes.has(key)) lanes.set(key, {
      key,
      pol: String(r.pol || "").trim(),
      pod: podDisplay,
      pod_port_id: r.pod_port_id ?? null,
      quotes: [],
      active: [],
      suggestion: { gp20: null, hq40: null, gp20_samples: 0, hq40_samples: 0 },
    });
    lanes.get(key).active.push(safeRateRow(r));
  }

  for (const lane of lanes.values()) {
    const recent = lane.quotes.filter(q => !q.old);
    const gp20s = recent.map(q => q.gp20).filter(Number.isFinite);
    const hq40s = recent.map(q => q.hq40).filter(Number.isFinite);
    lane.suggestion = {
      gp20: gp20s.length ? median(gp20s) : null,
      hq40: hq40s.length ? median(hq40s) : null,
      gp20_samples: gp20s.length,
      hq40_samples: hq40s.length,
    };
  }

  return res.status(200).json({ ok: true, lanes: [...lanes.values()] });
}

async function handlePublish(pool, req, res) {
  const b = req.body || {};
  const rateId = b.rate_id ? Number(b.rate_id) : null;
  const pol = String(b.pol || "").trim();
  const pod = String(b.pod || "").trim();
  const carrier = String(b.carrier || "").trim();
  const gp20 = money(b.customer_gp20);
  const hq40 = money(b.customer_hq40);
  if ((!rateId && (!pol || !pod || !carrier)) || (!gp20 && !hq40)) {
    return res.status(400).json({ ok: false, error: "rate_id 或 pol/pod/carrier 必填，且至少填写一个卖价" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let target = null;
    if (rateId) {
      const found = await client.query(
        `SELECT id, pol, pod, carrier FROM freight_rates WHERE id = $1 FOR UPDATE`,
        [rateId]
      );
      if (!found.rows.length) throw Object.assign(new Error("rate_not_found"), { status: 404 });
      target = found.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO freight_rates
           (pol, pod, carrier, customer_gp20, customer_hq40, source, status, valid_from, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'manual_price', 'active', CURRENT_DATE, NOW(), NOW())
         RETURNING id, pol, pod, carrier`,
        [pol, pod, carrier, gp20, hq40]
      );
      target = inserted.rows[0];
    }

    await client.query(
      `UPDATE freight_rates
          SET status = 'expired', updated_at = NOW()
        WHERE status = 'active'
          AND id <> $1
          AND lower(btrim(pol)) = lower(btrim($2))
          AND lower(btrim(pod)) = lower(btrim($3))
          AND lower(btrim(carrier)) = lower(btrim($4))`,
      [target.id, target.pol, target.pod, target.carrier]
    );

    const updated = await client.query(
      `UPDATE freight_rates
          SET customer_gp20 = COALESCE($2, customer_gp20),
              customer_hq40 = COALESCE($3, customer_hq40),
              status = 'active',
              valid_from = CURRENT_DATE,
              updated_at = NOW()
        WHERE id = $1
      RETURNING id, pol, pod, carrier, customer_gp20::numeric AS customer_gp20,
                customer_hq40::numeric AS customer_hq40, valid_from`,
      [target.id, gp20, hq40]
    );
    await client.query("COMMIT");
    return res.status(200).json({ ok: true, rate: safeRateRow(updated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
}

async function handleUnpublish(pool, req, res) {
  const rateId = Number((req.body || {}).rate_id);
  if (!Number.isFinite(rateId)) return res.status(400).json({ ok: false, error: "rate_id required" });
  const r = await pool.query(
    `UPDATE freight_rates
        SET status = 'expired', updated_at = NOW()
      WHERE id = $1
    RETURNING id, pol, pod, carrier, customer_gp20::numeric AS customer_gp20,
              customer_hq40::numeric AS customer_hq40, valid_from`,
    [rateId]
  );
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "rate_not_found" });
  return res.status(200).json({ ok: true, rate: safeRateRow(r.rows[0]) });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireRole(req, res, INTERNAL_ROLES)) return;
  const pool = getPool();
  const tail = pathTail(req);

  try {
    if (req.method === "GET" && tail === "quotes") return handleQuotes(pool, res);
    if (req.method === "POST" && tail === "publish") return handlePublish(pool, req, res);
    if (req.method === "POST" && tail === "unpublish") return handleUnpublish(pool, req, res);
    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
