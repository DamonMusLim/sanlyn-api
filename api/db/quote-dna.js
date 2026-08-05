// 报价 DNA 比价视图 —— Damon 2026-08-05
// 「其实在下单选定的时候就要操作的,和DNA记忆」+「这个是综合价格」+「还是要报价低」
// GET  ?pol=&pod=&container_type=   → 候选货代按【综合价】升序(不是只看海运费)
// POST {id, chosen_reason}          → 记下"这次选了谁、为什么",DNA 才有记忆
//
// 综合价 = 海运USD×汇率 + 港杂CNY + 拖车CNY(service_rates truck) + 报关CNY(service_rates customs)
// 拖车/报关取不到就标出来缺哪段,不假装 0(缺显缺铁律)。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  try {
    // ── 记下选择:这就是「下单选定时要操作的」那一下 ──
    if (req.method === "POST") {
      const body = req.body || {};
      const id = parseInt(body.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "id required" });
      const reason = clean(body.chosen_reason) || "未填理由";
      const r = await pool.query(
        `UPDATE freight_forwarder_quote_dna
         SET chosen = true, chosen_reason = $2,
             raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('chosen_at', now()::text, 'chosen_by', $3)
         WHERE id = $1 RETURNING id, forwarder, ocean_usd, chosen_reason`, [id, reason, clean(body.by) || "admin"]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "not found" });
      // 同航线同柜型的其他候选标未选中,保证"这条线这次选了谁"唯一
      await pool.query(
        `UPDATE freight_forwarder_quote_dna d SET chosen = false
         FROM freight_forwarder_quote_dna x
         WHERE x.id = $1 AND d.id <> x.id AND d.chosen
           AND d.pol_code = x.pol_code AND d.pod_code = x.pod_code
           AND COALESCE(d.container_type,'') = COALESCE(x.container_type,'')
           AND d.observed_at::date = x.observed_at::date`, [id]);
      return res.status(200).json({ ok: true, chosen: r.rows[0] });
    }

    // ── 比价视图 ──
    const { pol, pod, container_type } = req.query;
    const conds = [], params = [];
    if (clean(pol)) { params.push(`%${clean(pol)}%`); conds.push(`(d.pol_code ILIKE $${params.length})`); }
    if (clean(pod)) { params.push(`%${clean(pod)}%`); conds.push(`(d.pod_code ILIKE $${params.length})`); }
    if (clean(container_type)) { params.push(clean(container_type)); conds.push(`(d.container_type = $${params.length})`); }

    const fx = await pool.query(
      `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`);
    const usdCny = num(fx.rows[0] && fx.rows[0].rate) || 7;

    const q = await pool.query(
      `SELECT d.id, d.observed_at, d.pol_code, d.pod_code, d.carrier_code, d.container_type,
              d.vessel_name, d.voyage_no, d.etd, d.forwarder, d.forwarder_company_id,
              d.ocean_usd, d.port_charge_cny, d.delta_pct, d.verdict,
              d.is_lowest, d.is_recommended, d.chosen, d.chosen_reason
       FROM freight_forwarder_quote_dna d
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY d.observed_at DESC, d.ocean_usd NULLS LAST`, params);

    // 拖车/报关补进综合价(按 service_rates,取该货代该柜型的价)
    const sr = await pool.query(
      `SELECT service, quote_owner_company_id, container_type, rate
       FROM service_rates WHERE is_active AND service IN ('truck','customs')`);
    const svcOf = (cid, svc, ctype) => {
      const hit = sr.rows.filter((x) => x.service === svc && x.quote_owner_company_id === cid
        && (!x.container_type || !ctype || String(x.container_type).toUpperCase() === String(ctype).toUpperCase()));
      return hit.length ? num(hit[0].rate) : null;
    };

    const rows = q.rows.map((d) => {
      const oceanCny = num(d.ocean_usd) == null ? null : num(d.ocean_usd) * usdCny;
      const port = num(d.port_charge_cny);
      const truck = svcOf(d.forwarder_company_id, "truck", d.container_type);
      const customs = svcOf(d.forwarder_company_id, "customs", d.container_type);
      const missing = [];
      if (oceanCny == null) missing.push("海运");
      if (port == null) missing.push("港杂");
      if (truck == null) missing.push("拖车");
      if (customs == null) missing.push("报关");
      const total = [oceanCny, port, truck, customs].reduce((s, v) => s + (v || 0), 0);
      return { ...d, fx_usd_cny: usdCny, ocean_cny: oceanCny, truck_cny: truck, customs_cny: customs,
               total_cny: total, missing_segments: missing, total_is_partial: missing.length > 0 };
    });
    // Damon:「还是要报价低」→ 综合价升序;齐全的排在残缺的前面
    rows.sort((a, b) => (a.total_is_partial ? 1 : 0) - (b.total_is_partial ? 1 : 0) || a.total_cny - b.total_cny);

    return res.status(200).json({
      ok: true, fx_usd_cny: usdCny, count: rows.length,
      chosen_history: rows.filter((r) => r.chosen).map((r) => ({ forwarder: r.forwarder, reason: r.chosen_reason, at: r.observed_at })),
      rows,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
