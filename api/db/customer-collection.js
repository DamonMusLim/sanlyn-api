// /api/db/customer-collection.js - 客户系列/口味收集
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

const ROLES = new Set(["customer", "sanlyn", "admin"]);

function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 120) { return String(v == null ? "" : v).trim().slice(0, n); }
function role(req) { const r = clean(req.user?.role || "", 40).toLowerCase(); return ROLES.has(r) ? r : null; }
function isInternal(r) { return r === "sanlyn" || r === "admin"; }
function actor(req) {
  const u = req.user || {};
  return clean(u.username || u.email || u.sub || "customer-collection", 120);
}
function codes(req) {
  const u = req.user || {};
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length
    ? u.companyCodes : (u.companyCode || u.company_code ? [u.companyCode || u.company_code] : []);
  return raw.map(x => clean(x, 80)).filter(Boolean);
}
function publicRow(r) {
  return {
    id: Number(r.id),
    customer_code: r.customer_code,
    series_name: r.series_name,
    flavors: Array.isArray(r.flavors) ? r.flavors : [],
    note: r.note || "",
    updated_at: r.updated_at || null,
  };
}
function cleanSeriesName(v) {
  const s = clean(v, 80);
  if (!s) throw new Error("series_name required");
  return s;
}
function cleanCustomerCode(v) {
  const s = clean(v, 80);
  if (!s) throw new Error("customer_code required");
  return s;
}
function cleanFlavors(v) {
  if (!Array.isArray(v)) throw new Error("flavors invalid");
  const out = [], seen = new Set();
  for (const x of v) {
    const s = clean(x, 40);
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length > 50) throw new Error("flavors invalid");
  }
  return out;
}

async function listRows(pool, req, r, scopeCodes) {
  const vals = [];
  let where = "COALESCE(status,'active') <> 'inactive'";
  let currentCustomer = "";
  if (isInternal(r)) {
    const fc = clean(req.query.customer_code || "", 80);
    if (fc) { vals.push(fc); where += ` AND customer_code = $${vals.length}`; currentCustomer = fc; }
  } else {
    vals.push(scopeCodes);
    where += ` AND customer_code = ANY($${vals.length}::text[])`;
    currentCustomer = scopeCodes[0] || "";
  }
  const q = `SELECT id, customer_code, series_name, flavors, note, updated_at
               FROM customer_series
              WHERE ${where}
           ORDER BY customer_code, series_name`;
  const rows = (await pool.query(q, vals)).rows.map(publicRow);
  return {
    rows,
    progress: { total: rows.length, flavors: rows.reduce((n, x) => n + x.flavors.length, 0) },
    current_customer_code: currentCustomer,
  };
}

async function addSeries(req, res, pool, r, scopeCodes) {
  const customerCode = isInternal(r) ? cleanCustomerCode(req.body?.customer_code) : (scopeCodes[0] || "");
  if (!customerCode) throw new Error("customer_code scope missing");
  const seriesName = cleanSeriesName(req.body?.series_name);
  const op = actor(req);
  let row;
  try {
    row = (await pool.query(
      `INSERT INTO customer_series(customer_code, series_name, updated_by)
       VALUES($1,$2,$3)
       RETURNING id, customer_code, series_name`,
      [customerCode, seriesName, op]
    )).rows[0];
  } catch (e) {
    if (e.code !== "23505") throw e;
    row = (await pool.query(
      `SELECT id, customer_code, series_name
         FROM customer_series
        WHERE customer_code=$1 AND series_name=$2 AND COALESCE(status,'active') <> 'inactive'
        LIMIT 1`,
      [customerCode, seriesName]
    )).rows[0];
    if (!row) throw e;
  }
  try {
    await writeAudit(pool, req, {
      action: "customer-collection.add-series",
      entity_type: "customer_series",
      entity_id: String(row.id),
      before: {},
      after: { customer_code: row.customer_code, series_name: row.series_name },
      note: "客户新增系列",
    });
  } catch (_) {}
  return json(res, 200, { success: true, id: Number(row.id), series_name: row.series_name });
}

async function scopedSeries(pool, id, r, scopeCodes) {
  const vals = [id];
  let where = "id=$1 AND COALESCE(status,'active') <> 'inactive'";
  if (!isInternal(r)) { vals.push(scopeCodes); where += ` AND customer_code = ANY($${vals.length}::text[])`; }
  const ret = await pool.query(`SELECT id, customer_code, series_name, flavors FROM customer_series WHERE ${where}`, vals);
  if (!ret.rows.length) throw new Error("out of scope");
  return ret.rows[0];
}

async function setFlavors(req, res, pool, r, scopeCodes) {
  const id = Number(req.body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id invalid");
  const flavors = cleanFlavors(req.body?.flavors);
  const old = await scopedSeries(pool, id, r, scopeCodes);
  const vals = [JSON.stringify(flavors), actor(req), id];
  let where = "id=$3 AND COALESCE(status,'active') <> 'inactive'";
  if (!isInternal(r)) { vals.push(scopeCodes); where += ` AND customer_code = ANY($${vals.length}::text[])`; }
  const ret = await pool.query(
    `UPDATE customer_series
        SET flavors=$1::jsonb, updated_at=NOW(), updated_by=$2
      WHERE ${where}
      RETURNING id`,
    vals
  );
  if (!ret.rowCount) throw new Error("out of scope");
  try {
    await writeAudit(pool, req, {
      action: "customer-collection.set-flavors",
      entity_type: "customer_series",
      entity_id: String(id),
      before: { flavors: Array.isArray(old.flavors) ? old.flavors : [] },
      after: { flavors },
      note: "客户维护口味",
    });
  } catch (_) {}
  return json(res, 200, { success: true, flavors });
}

async function delSeries(req, res, pool, r, scopeCodes) {
  const id = Number(req.body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id invalid");
  const old = await scopedSeries(pool, id, r, scopeCodes);
  const vals = [actor(req), id];
  let where = "id=$2 AND COALESCE(status,'active') <> 'inactive'";
  if (!isInternal(r)) { vals.push(scopeCodes); where += ` AND customer_code = ANY($${vals.length}::text[])`; }
  const ret = await pool.query(
    `UPDATE customer_series SET status='inactive', updated_at=NOW(), updated_by=$1 WHERE ${where}`,
    vals
  );
  if (!ret.rowCount) throw new Error("out of scope");
  try {
    await writeAudit(pool, req, {
      action: "customer-collection.del-series",
      entity_type: "customer_series",
      entity_id: String(id),
      before: { status: "active", customer_code: old.customer_code, series_name: old.series_name },
      after: { status: "inactive" },
      note: "客户停用系列",
    });
  } catch (_) {}
  return json(res, 200, { success: true });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  const r = role(req);
  if (!r) return json(res, 403, { success: false, error: "role forbidden" });
  const scopeCodes = codes(req);
  if (!isInternal(r) && !scopeCodes.length) return json(res, 403, { success: false, error: "company_code scope missing" });
  const pool = getPool();
  try {
    if (req.method === "GET") return json(res, 200, {
      success: true,
      role: r,
      can_edit: r === "customer" || isInternal(r),
      org_name: clean(req.user?.company || req.user?.org_name || ""),
      ...(await listRows(pool, req, r, scopeCodes)),
    });
    const action = clean(req.query.action || req.body?.action || "", 40);
    if ((req.method === "POST" || req.method === "PATCH") && action === "add-series") return await addSeries(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && action === "set-flavors") return await setFlavors(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && action === "del-series") return await delSeries(req, res, pool, r, scopeCodes);
    return json(res, 405, { success: false, error: "method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    if (code === 500) { console.error("[customer-collection]", e); return json(res, 500, { success: false, error: "internal error" }); }
    return json(res, code, { success: false, error: e.message });
  }
}
