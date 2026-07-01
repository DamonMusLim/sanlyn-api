// api/db/rfq-items.js
// freight_rfq_items table CRUD — actual schema:
// id(uuid), rfq_id(uuid FK), forwarder_co, vessel, voyage, etd,
// usd_rate, transit_days, notes, is_lowest, selected, submitted_at

import { getPool, setCors } from "../db.js";
import { isInternalRole } from "../lib/viewmodel-adapter.js";

const ALLOWED_PATCH = ["forwarder_co","vessel","voyage","etd","usd_rate",
                       "transit_days","notes","is_lowest","selected","currency",
                       "container_type","carrier"];

// 供应商身份（fail-closed）：非内部角色只能以自己公司身份读/写报价
function supplierIdentity(user) {
  const u = user || {};
  return {
    internal: isInternalRole(u.role),
    companyId: u.company_id || u.companyId || null,
    companyName: u.company_name || u.companyName || u.company || null,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const pool = getPool();
  await pool.query(`
    ALTER TABLE freight_rfq_items
      ADD COLUMN IF NOT EXISTS port_charges_json jsonb,
      ADD COLUMN IF NOT EXISTS free_pol_days     int,
      ADD COLUMN IF NOT EXISTS free_pod_days     int,
      ADD COLUMN IF NOT EXISTS dnd_usd           numeric,
      ADD COLUMN IF NOT EXISTS container_type    text,
      ADD COLUMN IF NOT EXISTS carrier           text
  `);

  // ── GET ──
  if (req.method === "GET") {
    const { rfq_id } = req.query;
    if (!rfq_id) return res.status(400).json({ error: "rfq_id required" });
    const who = supplierIdentity(req.user);
    let rows;
    if (who.internal) {
      rows = (await pool.query(
        `SELECT * FROM freight_rfq_items WHERE rfq_id = $1 ORDER BY usd_rate ASC`,
        [rfq_id]
      )).rows;
    } else {
      // 供应商只看自己的报价行；身份不明 = 空（fail-closed，不泄竞争对手价格）
      if (!who.companyId && !who.companyName) {
        return res.status(200).json({ success: true, data: [], count: 0 });
      }
      rows = (await pool.query(
        `SELECT * FROM freight_rfq_items
          WHERE rfq_id = $1
            AND (($2::int IS NOT NULL AND forwarder_company_id = $2)
              OR ($3::text IS NOT NULL AND forwarder_co = $3))
          ORDER BY usd_rate ASC`,
        [rfq_id, who.companyId, who.companyName]
      )).rows;
    }
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  }

  // ── POST ──
  if (req.method === "POST") {
    const { rfq_id, vessel, voyage, etd, usd_rate,
            transit_days, notes, currency,
            port_charges_json, free_pol_days, free_pod_days, dnd_usd,
            container_type, carrier } = req.body || {};
    const who = supplierIdentity(req.user);
    // 非内部角色：报价公司强制 = 登录身份（不可冒名）；内部可代录指定公司
    let forwarder_co = (req.body || {}).forwarder_co;
    let forwarder_company_id = (req.body || {}).forwarder_company_id || null;
    if (!who.internal) {
      if (!who.companyName && !who.companyId)
        return res.status(403).json({ error: "供应商身份未识别，无法报价" });
      forwarder_co = who.companyName || forwarder_co;
      forwarder_company_id = who.companyId || forwarder_company_id;
    }
    if (!rfq_id || !forwarder_co || !usd_rate)
      return res.status(400).json({ error: "rfq_id, forwarder_co, usd_rate required" });
    const ccy = ["USD","CNY"].includes(currency) ? currency : "USD";
    const { rows } = await pool.query(
      `INSERT INTO freight_rfq_items
         (rfq_id, forwarder_co, forwarder_company_id, vessel, voyage, etd,
          usd_rate, currency, transit_days, notes,
          port_charges_json, free_pol_days, free_pod_days, dnd_usd,
          container_type, carrier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
       RETURNING *`,
      [rfq_id, forwarder_co, forwarder_company_id, vessel || null, voyage || null, etd || null,
       usd_rate, ccy, transit_days || null, notes || null,
       port_charges_json ? JSON.stringify(port_charges_json) : null,
       free_pol_days || null, free_pod_days || null, dnd_usd || null,
       container_type || null, carrier || null]
    );
    // Recompute is_lowest across all items for this rfq
    await pool.query(
      `UPDATE freight_rfq_items SET is_lowest = (usd_rate = (
         SELECT MIN(usd_rate) FROM freight_rfq_items WHERE rfq_id = $1
       )) WHERE rfq_id = $1`,
      [rfq_id]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    const { id, rfq_id, ...patch } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const keys = Object.keys(patch).filter(k => ALLOWED_PATCH.includes(k));
    if (!keys.length) return res.status(400).json({ error: "no valid fields" });
    const sets = keys.map((k, i) => `${k} = $${i+2}`).join(", ");
    const vals = [id, ...keys.map(k => patch[k])];
    const { rows } = await pool.query(
      `UPDATE freight_rfq_items SET ${sets} WHERE id = $1 RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    // Recompute is_lowest if usd_rate changed
    if (patch.usd_rate != null && rfq_id) {
      await pool.query(
        `UPDATE freight_rfq_items SET is_lowest = (usd_rate = (
           SELECT MIN(usd_rate) FROM freight_rfq_items WHERE rfq_id = $1
         )) WHERE rfq_id = $1`,
        [rfq_id]
      );
    }
    return res.status(200).json({ success: true, data: rows[0] });
  }

  return res.status(405).json({ error: "method not allowed" });
}
