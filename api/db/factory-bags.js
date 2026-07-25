// /api/db/factory-bags.js — 工厂端袋子清点/补充
import { getPool, setCors } from "./db.js";

const SCOPE_EXISTS = `
EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(pm.product_skus) ps
  JOIN products p ON p.sku = ps
  WHERE p.factory_code = ANY($1::text[])
)`;

function scopeCodes(req) {
  const user = req.user || {};
  const raw = Array.isArray(user.companyCodes) && user.companyCodes.length
    ? user.companyCodes
    : (user.companyCode || user.company_code ? [user.companyCode || user.company_code] : []);
  return raw.map(x => String(x || "").trim()).filter(Boolean);
}

function cleanText(v, fallback = "") {
  const s = String(v == null ? "" : v).trim();
  return s || fallback;
}

function asNumber(v, name) {
  if (v === "" || v === null || v === undefined) throw new Error(name + " required");
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + " invalid");
  return n;
}

function idFilter(item, params) {
  if (item.material_id || item.id) {
    params.push(item.material_id || item.id);
    return `pm.id = $${params.length}`;
  }
  if (item.sku_code || item.sku) {
    params.push(cleanText(item.sku_code || item.sku));
    return `pm.sku_code = $${params.length}`;
  }
  throw new Error("sku_code or material_id required");
}

async function lockScopedMaterial(client, codes, item) {
  const params = [codes];
  const whereId = idFilter(item, params);
  const r = await client.query(
    `SELECT pm.id, pm.sku_code, pm.current_stock::numeric AS current_stock
     FROM packaging_materials pm
     WHERE ${SCOPE_EXISTS} AND ${whereId}
     FOR UPDATE`,
    params
  );
  if (!r.rows.length) throw new Error("material not found or out of factory scope");
  return r.rows[0];
}

async function stocktake(req, res, pool, codes) {
  const body = req.body || {};
  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) return res.status(400).json({ success: false, error: "counts required" });

  const operator = cleanText(body.operator, req.user?.username || "工厂清点");
  const note = cleanText(body.note);
  const batchId = "CB-" + Date.now();
  const countedAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seen = new Set();
    for (const item of counts) {
      const key = String(item.material_id || item.id || item.sku_code || item.sku || "");
      if (!key) throw new Error("缺少 sku_code/material_id");
      if (seen.has(key)) throw new Error("清点项重复: " + key);
      seen.add(key);
      const counted = asNumber(item.counted_qty, "counted_qty");
      if (counted < 0) throw new Error("counted_qty cannot be negative");
      const mat = await lockScopedMaterial(client, codes, item);
      const before = Number(mat.current_stock || 0);
      const delta = counted - before;
      await client.query(
        `INSERT INTO packaging_logs(material_id,type,quantity,before_stock,after_stock,operator,notes)
         VALUES($1,'adjust',$2,$3,$4,$5,$6)`,
        [mat.id, delta, before, counted, operator, `清点批次 ${batchId}${note ? " " + note : ""}`]
      );
      await client.query(
        `UPDATE packaging_materials SET current_stock=$1, updated_at=NOW() WHERE id=$2`,
        [counted, mat.id]
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: { batchId, counted_at: countedAt, items: counts.length } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(400).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
}

async function replenish(req, res, pool, codes) {
  const body = req.body || {};
  const hasDelta = body.delta !== undefined && body.delta !== null && body.delta !== "";
  const hasSetStock = body.set_stock !== undefined && body.set_stock !== null && body.set_stock !== "";
  if (!hasDelta && !hasSetStock) return res.status(400).json({ success: false, error: "delta or set_stock required" });

  const operator = cleanText(body.operator, req.user?.username || "工厂补录");
  const note = cleanText(body.note);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mat = await lockScopedMaterial(client, codes, body);
    const before = Number(mat.current_stock || 0);
    const after = hasSetStock ? asNumber(body.set_stock, "set_stock") : before + asNumber(body.delta, "delta");
    if (after < 0) throw new Error("after stock cannot be negative");
    const delta = after - before;
    if (delta === 0) throw new Error("库存无变化,无需补录");
    const type = delta > 0 ? "in" : "adjust";
    await client.query(
      `INSERT INTO packaging_logs(material_id,type,quantity,before_stock,after_stock,operator,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [mat.id, type, delta, before, after, operator, note || "工厂补录"]
    );
    await client.query(
      `UPDATE packaging_materials SET current_stock=$1, updated_at=NOW() WHERE id=$2`,
      [after, mat.id]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: { sku_code: mat.sku_code, before_stock: before, after_stock: after, delta } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(400).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const codes = scopeCodes(req);
  if (!codes.length) return res.status(403).json({ success: false, error: "Forbidden: factory scope required" });
  if (!["factory", "admin"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, error: "Forbidden: factory role required" });
  }

  const pool = getPool();
  if (req.method === "GET") {
    try {
      const r = await pool.query(
        `SELECT pm.sku_code, pm.barcode, pm.image_url, pm.name, pm.spec, pm.unit,
                pm.current_stock, pm.safety_stock, pm.supplier
         FROM packaging_materials pm
         WHERE ${SCOPE_EXISTS}
         ORDER BY pm.sku_code ASC`,
        [codes]
      );
      return res.status(200).json({
        success: true,
        data: r.rows,
        count: r.rowCount,
        scope: { factory_codes: codes, factory_name: req.user?.companyName || req.user?.company_name || codes[0] }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "POST") {
    const action = String(req.query.action || "").trim();
    if (action === "stocktake") return stocktake(req, res, pool, codes);
    if (action === "replenish") return replenish(req, res, pool, codes);
    return res.status(400).json({ success: false, error: "invalid action" });
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
