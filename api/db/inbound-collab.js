// /api/db/inbound-collab.js — 供应链↔工厂 来料协同
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";

const STATUS = new Set(["ordered", "shipped", "arrived", "cancelled"]);

const FACTORY_MATERIAL_SCOPE = `
EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(pm.product_skus) ps
  JOIN products p ON p.sku = ps
  WHERE p.factory_code = $1
)`;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function codes(req) {
  const u = req.user || {};
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length
    ? u.companyCodes
    : (u.companyCode || u.company_code ? [u.companyCode || u.company_code] : []);
  return raw.map(x => String(x || "").trim()).filter(Boolean);
}

function actor(req) {
  const u = req.user || {};
  return String(u.username || u.email || u.sub || "inbound").slice(0, 120);
}

function clean(v, n = 500) {
  return String(v == null ? "" : v).trim().slice(0, n);
}

function cleanDate(v) {
  const s = clean(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("id required");
  return n;
}

function cleanQty(v, required = false) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error("order_qty required");
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("order_qty invalid");
  return n;
}

function deliverySelect(where) {
  return `
    SELECT d.id,
           d.supplier_code,
           d.factory_code,
           d.material_sku,
           pm.name AS material_name,
           d.order_qty,
           d.expected_arrival,
           d.delivery_address,
           d.status,
           d.note
      FROM inbound_deliveries d
 LEFT JOIN packaging_materials pm ON pm.sku_code = d.material_sku
     WHERE ${where}
  ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC`;
}

async function listSupplier(pool, scopeCodes) {
  const r = await pool.query(deliverySelect("d.supplier_code = ANY($1::text[])"), [scopeCodes]);
  return r.rows;
}

async function listFactory(pool, scopeCodes) {
  const r = await pool.query(deliverySelect("d.factory_code = ANY($1::text[])"), [scopeCodes]);
  return r.rows;
}

async function patchSupplier(req, res, pool, scopeCodes) {
  const b = req.body || {};
  const id = cleanId(b.id);

  const sets = ["updated_at = NOW()"], vals = [];
  if (b.expected_arrival !== undefined) {
    vals.push(cleanDate(b.expected_arrival));
    sets.push(`expected_arrival = $${vals.length}`);
  }
  if (b.order_qty !== undefined) {
    vals.push(cleanQty(b.order_qty));
    sets.push(`order_qty = $${vals.length}`);
  }
  if (b.status !== undefined) {
    const status = clean(b.status, 20);
    if (!STATUS.has(status)) return json(res, 400, { success: false, error: "invalid status" });
    vals.push(status);
    sets.push(`status = $${vals.length}`);
  }
  if (sets.length === 1) return json(res, 400, { success: false, error: "no supplier fields to update" });

  vals.push(id, scopeCodes);
  const r = await pool.query(
    `UPDATE inbound_deliveries d
        SET ${sets.join(", ")}
      WHERE d.id = $${vals.length - 1}
        AND d.supplier_code = ANY($${vals.length}::text[])
  RETURNING d.id, d.supplier_code, d.factory_code, d.material_sku, d.order_qty,
            d.expected_arrival, d.delivery_address, d.status, d.note`,
    vals
  );
  if (!r.rows.length) return json(res, 404, { success: false, error: "delivery not found in supplier scope" });
  return json(res, 200, { success: true, data: r.rows[0] });
}

async function patchFactory(req, res, pool, scopeCodes) {
  const b = req.body || {};
  const id = cleanId(b.id);
  const address = clean(b.delivery_address, 1000);
  if (!address) return json(res, 400, { success: false, error: "delivery_address required" });

  const r = await pool.query(
    `UPDATE inbound_deliveries d
        SET delivery_address = $3, updated_at = NOW()
      WHERE d.id = $2
        AND d.factory_code = ANY($1::text[])
  RETURNING d.id, d.supplier_code, d.factory_code, d.material_sku, d.order_qty,
            d.expected_arrival, d.delivery_address, d.status, d.note`,
    [scopeCodes, id, address]
  );
  if (!r.rows.length) return json(res, 404, { success: false, error: "delivery not found in factory scope" });
  return json(res, 200, { success: true, data: r.rows[0] });
}

async function createOrder(req, res, pool, scopeCodes) {
  const b = req.body || {};
  const factoryCode = clean(b.factory_code || scopeCodes[0], 80);
  const supplierCode = clean(b.supplier_code, 80);
  const materialSku = clean(b.material_sku || b.sku_code, 80);
  const orderQty = cleanQty(b.order_qty, true);
  if (!scopeCodes.includes(factoryCode)) return json(res, 403, { success: false, error: "factory_code out of scope" });
  if (!supplierCode || !materialSku) {
    return json(res, 400, { success: false, error: "supplier_code and material_sku required" });
  }

  const mat = await pool.query(
    `SELECT pm.sku_code, pm.name
       FROM packaging_materials pm
      WHERE pm.sku_code = $2
        AND ${FACTORY_MATERIAL_SCOPE}
      LIMIT 1`,
    [factoryCode, materialSku]
  );
  if (!mat.rows.length) return json(res, 404, { success: false, error: "material not found in factory scope" });

  const r = await pool.query(
    `INSERT INTO inbound_deliveries
       (supplier_code, factory_code, material_sku, order_qty, delivery_address, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING supplier_code, factory_code, material_sku, order_qty,
               expected_arrival, delivery_address, status, note`,
    [
      supplierCode,
      factoryCode,
      materialSku,
      orderQty,
      clean(b.delivery_address, 1000) || null,
      clean(b.note, 500) || null,
      actor(req),
    ]
  );
  return json(res, 201, { success: true, data: { ...r.rows[0], material_name: mat.rows[0].name } });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });

  const scopeCodes = codes(req);
  if (!scopeCodes.length) return json(res, 403, { success: false, error: "Account company scope missing" });

  const role = req.user.role;
  const view = clean(req.query.view || req.body?.view || (role === "supplier" ? "supplier" : "factory"), 20);
  const pool = getPool();

  try {
    if (req.method === "GET") {
      if (view === "supplier") {
        // Factory accounts may act as the supplier side for the two-factory collaboration design.
        if (!["supplier", "factory", "admin"].includes(role)) {
          return json(res, 403, { success: false, error: "Forbidden: supplier role required" });
        }
        return json(res, 200, { success: true, data: await listSupplier(pool, scopeCodes) });
      }
      if (view === "factory") {
        if (!["factory", "admin"].includes(role)) {
          return json(res, 403, { success: false, error: "Forbidden: factory role required" });
        }
        return json(res, 200, { success: true, data: await listFactory(pool, scopeCodes) });
      }
      return json(res, 400, { success: false, error: "unknown view" });
    }

    if (req.method === "PATCH") {
      if (view === "supplier") {
        // Factory accounts may act as the supplier side for the two-factory collaboration design.
        if (!["supplier", "factory", "admin"].includes(role)) {
          return json(res, 403, { success: false, error: "Forbidden: supplier role required" });
        }
        return patchSupplier(req, res, pool, scopeCodes);
      }
      if (view === "factory") {
        if (!["factory", "admin"].includes(role)) {
          return json(res, 403, { success: false, error: "Forbidden: factory role required" });
        }
        return patchFactory(req, res, pool, scopeCodes);
      }
      return json(res, 400, { success: false, error: "unknown view" });
    }

    if (req.method === "POST") {
      if (!["factory", "admin"].includes(role)) {
        return json(res, 403, { success: false, error: "Forbidden: factory role required" });
      }
      return createOrder(req, res, pool, scopeCodes);
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : 500;
    return json(res, code, { success: false, error: e.message });
  }
}
