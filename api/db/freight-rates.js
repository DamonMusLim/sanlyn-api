import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  // PATCH: update one freight rate by id (auth). Trigger logs 涨价历史 → freight_rates_history.
  if (req.method === "PATCH") {
    if (!requireAuth(req, res)) return;
    try {
      const body = req.body || {};
      const id = parseInt(body.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ success:false, error:"id required" });
      const EDITABLE = ["pol","pod","carrier","forwarder","route_code","via","gp20","hq40",
        "customer_gp20","customer_hq40","transit_days","thc","local_charge_code","valid_from",
        "valid_to","remarks","status","currency","raw","freetime",
        "free_days_base","free_days_ext","terminal","next_sailing","supplier_id"];
      const JSON_COLS = ["raw"];
      const sets = [], params = [];
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(body, k)) {
        params.push(JSON_COLS.includes(k) ? JSON.stringify(body[k] ?? null) : body[k]);
        sets.push(`${k} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ success:false, error:"no editable fields" });
      sets.push(`updated_at = now()`);
      params.push(id);
      const r = await pool.query(`UPDATE freight_rates SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success:false, error:"not found" });
      return res.status(200).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  // POST: 新建运价（修复 +New 写不进 / 405）
  if (req.method === "POST") {
    if (!requireAuth(req, res)) return;
    try {
      const body = req.body || {};
      const EDITABLE = ["pol","pod","carrier","forwarder","route_code","via","gp20","hq40",
        "customer_gp20","customer_hq40","transit_days","thc","local_charge_code","valid_from",
        "valid_to","remarks","status","currency","raw","freetime","this_week","next_sailing","eta_date","free_days_base","free_days_ext","terminal","supplier_id"];
      const cols = [], vals = [], params = [];
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(body, k)) {
        const v = body[k]; cols.push(k);
        if (k === "raw") { params.push(JSON.stringify(v ?? null)); vals.push(`$${params.length}::jsonb`); }
        else { params.push(v); vals.push(`$${params.length}`); }
      }
      if (!cols.length) return res.status(400).json({ success:false, error:"no fields" });
      if (!cols.includes("status")) { cols.push("status"); params.push("active"); vals.push(`$${params.length}`); }
      cols.push("created_at","updated_at"); vals.push("now()","now()");
      const r = await pool.query(`INSERT INTO freight_rates (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`, params);
      return res.status(201).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    // ?history=<rate_id> → 涨价历史
    if (req.query.history) {
      const rid = parseInt(req.query.history, 10);
      if (!Number.isFinite(rid)) return res.status(400).json({ success:false, error:"bad history id" });
      const h = await pool.query(`SELECT * FROM freight_rates_history WHERE rate_id=$1 ORDER BY changed_at DESC, id DESC`, [rid]);
      return res.status(200).json(h.rows);
    }
    const { pol, pod, carrier, limit = 1000 } = req.query;
    // LEFT JOIN port_charges: 同 (pol, pod, carrier) 最新一条 sale_price_* 作为本地港杂
    // 若 port_charges 该条空 → 返回 null，前端显示 "on request"
    let query = `
      SELECT f.id, f.pol, f.pod, f.carrier, f.forwarder,
        f.route_code AS "routeCode", f.gp20, f.hq40,
        f.customer_gp20 AS "customerGp20", f.customer_hq40 AS "customerHq40",
        f.this_week AS "thisWeek", f.next_week AS "nextWeek",
        f.next_sailing AS "nextSailing",
        f.valid_from AS "validFrom", f.valid_to AS "validTo",
        f.transit_days AS "transitDays", f.freetime, f.via, f.thc, f.remarks, f.raw,
        f.eta_date AS "etaDate",
        f.created_at AS "createdAt", f.updated_at AS "updatedAt",
        lc20.cost_total AS "portGp20",
        lc40.cost_total AS "portHq40",
        COALESCE(lc40.company_name, lc20.company_name) AS "portProvider",
        COALESCE(lc40.charge_code, lc20.charge_code)   AS "portCode",
        hist.prev_hq40 AS "prevHq40", hist.prev_gp20 AS "prevGp20", hist.changed_at AS "lastChangedAt"
      FROM freight_rates f
      LEFT JOIN LATERAL (
        SELECT prev_hq40, prev_gp20, changed_at FROM freight_rates_history h
        WHERE h.rate_id = f.id AND h.change_kind NOT IN ('baseline','create')
        ORDER BY h.changed_at DESC LIMIT 1
      ) hist ON TRUE
      -- 港杂关联 local_charges（真值在这）。口径(Damon 2026-07-23 定):港杂直接挂货代,
      -- 主键=货代+船司+起运港+柜型,不含目的港(与唯一索引 uq_local_charges_ssot_active 一致)。
      -- 两级匹配:优先 local_charge_code 硬绑定,对不上再退回自然键。全程只取 is_active。
      LEFT JOIN LATERAL (
        SELECT cost_total, company_name, charge_code FROM local_charges lc
        WHERE lc.is_active AND lc.container_type ~* '20' AND (
          lc.charge_code = f.local_charge_code
          OR (lower(btrim(lc.pol))=lower(btrim(f.pol))
              AND lower(btrim(lc.carrier))=lower(btrim(f.carrier))
              AND (f.forwarder IS NULL OR lower(btrim(lc.company_name))=lower(btrim(f.forwarder))))
        )
        ORDER BY (lc.charge_code = f.local_charge_code) DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT 1
      ) lc20 ON TRUE
      LEFT JOIN LATERAL (
        SELECT cost_total, company_name, charge_code FROM local_charges lc
        WHERE lc.is_active AND lc.container_type ~* '40|HQ|45' AND (
          lc.charge_code = f.local_charge_code
          OR (lower(btrim(lc.pol))=lower(btrim(f.pol))
              AND lower(btrim(lc.carrier))=lower(btrim(f.carrier))
              AND (f.forwarder IS NULL OR lower(btrim(lc.company_name))=lower(btrim(f.forwarder))))
        )
        ORDER BY (lc.charge_code = f.local_charge_code) DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT 1
      ) lc40 ON TRUE`;
    const params = [], conds = [];
    if (pol) { params.push(`%${pol}%`); conds.push(`f.pol ILIKE $${params.length}`); }
    if (pod) { params.push(`%${pod}%`); conds.push(`f.pod ILIKE $${params.length}`); }
    if (carrier) { params.push(`%${carrier}%`); conds.push(`f.carrier ILIKE $${params.length}`); }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    // 过滤已撤销运价（withdrawn 不对用户展示）
    query += (conds.length ? " AND " : " WHERE ") + "f.status != 'withdrawn'";
    params.push(parseInt(limit));
    // 按开船日期倒序，无船期的沉底；再按路线分组
    query += ` ORDER BY f.next_sailing DESC NULLS LAST, f.pol, f.pod, f.carrier LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json(result.rows);
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
