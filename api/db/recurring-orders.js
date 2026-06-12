// /api/db/recurring-orders.js
// Recurring / scheduled orders — customer can set a fixed cadence (monthly/quarterly)
// and the system will auto-create draft orders on the due date.
//
// GET    /api/db/recurring-orders          → list (customer sees own, admin sees all)
// POST   /api/db/recurring-orders          → create
// PATCH  /api/db/recurring-orders/:id      → edit / pause / cancel
// DELETE /api/db/recurring-orders/:id      → soft-cancel
// POST   /api/db/recurring-orders/:id/trigger → admin: manually fire one cycle now

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Migration helper ──────────────────────────────────────────────────────────
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_orders (
      id              SERIAL PRIMARY KEY,
      company_code    TEXT        NOT NULL,
      company_name    TEXT,
      label           TEXT        NOT NULL DEFAULT '',
      frequency       TEXT        NOT NULL DEFAULT 'monthly'
                        CHECK(frequency IN ('weekly','biweekly','monthly','bimonthly','quarterly')),
      day_of_month    INT         NOT NULL DEFAULT 1,
      items           JSONB       NOT NULL DEFAULT '[]',
      factory_code    TEXT,
      load_port       TEXT,
      delivery_addr   TEXT,
      req_arrival_days INT        DEFAULT NULL,
      remarks         TEXT,
      status          TEXT        NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','paused','cancelled')),
      next_due_date   DATE,
      last_run_at     TIMESTAMPTZ,
      last_order_no   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_recur_orders_company_status
      ON recurring_orders (company_code, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_recur_orders_next_due
      ON recurring_orders (next_due_date) WHERE status = 'active'
  `);
}

// ── Compute next due date from now ────────────────────────────────────────────
function computeNextDue(frequency, dayOfMonth) {
  var now = new Date();
  var d = new Date(now);
  // Try current month first, else advance
  d.setDate(dayOfMonth);
  d.setHours(0, 0, 0, 0);
  if (d <= now) {
    // Advance by frequency
    if (frequency === "weekly")     d.setDate(d.getDate() + 7);
    else if (frequency === "biweekly") d.setDate(d.getDate() + 14);
    else if (frequency === "monthly") {
      d.setMonth(d.getMonth() + 1);
      d.setDate(dayOfMonth);
    } else if (frequency === "bimonthly") {
      d.setMonth(d.getMonth() + 2);
      d.setDate(dayOfMonth);
    } else if (frequency === "quarterly") {
      d.setMonth(d.getMonth() + 3);
      d.setDate(dayOfMonth);
    }
  }
  return d.toISOString().slice(0, 10);
}

// ── Route handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  var auth = await requireAuth(req, res);
  if (!auth) return;

  var pool = getPool();
  await ensureTable(pool);

  var isAdmin   = auth.role === "admin";
  var userCode  = auth.companyCode || auth.company_code || null;
  var userCodes = auth.companyCodes || (userCode ? [userCode] : []);

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    var urlParts = req.url.split("/").filter(Boolean);
    var id = urlParts[urlParts.length - 1];
    if (id && /^\d+$/.test(id)) {
      // Single fetch
      var r = await pool.query("SELECT * FROM recurring_orders WHERE id=$1", [parseInt(id)]);
      if (!r.rows[0]) return res.status(404).json({ success: false, error: "Not found" });
      var row = r.rows[0];
      if (!isAdmin && !userCodes.includes(row.company_code))
        return res.status(403).json({ success: false, error: "Forbidden" });
      return res.json({ success: true, data: row });
    }
    // List
    var rows;
    if (isAdmin) {
      var r2 = await pool.query("SELECT * FROM recurring_orders ORDER BY created_at DESC LIMIT 200");
      rows = r2.rows;
    } else {
      if (!userCodes.length) return res.json({ success: true, data: [], count: 0 });
      var ph = userCodes.map((_,i) => "$"+(i+1)).join(",");
      var r3 = await pool.query(
        "SELECT * FROM recurring_orders WHERE company_code IN (" + ph + ") ORDER BY created_at DESC",
        userCodes
      );
      rows = r3.rows;
    }
    return res.json({ success: true, data: rows, count: rows.length });
  }

  // ── POST (create or trigger) ──────────────────────────────────────────────
  if (req.method === "POST") {
    var urlParts2 = req.url.split("/").filter(Boolean);
    var lastSeg   = urlParts2[urlParts2.length - 1];

    // Trigger: POST /recurring-orders/:id/trigger
    if (lastSeg === "trigger") {
      if (!isAdmin) return res.status(403).json({ success: false, error: "Admin only" });
      var triggerId = parseInt(urlParts2[urlParts2.length - 2], 10);
      if (!triggerId) return res.status(400).json({ success: false, error: "Missing id" });
      var trRow = await pool.query("SELECT * FROM recurring_orders WHERE id=$1", [triggerId]);
      if (!trRow.rows[0]) return res.status(404).json({ success: false, error: "Not found" });
      var created = await fireRecurring(pool, trRow.rows[0]);
      return res.json({ success: true, order_no: created });
    }

    // Create
    var b = req.body || {};
    if (!b.company_code) return res.status(400).json({ success: false, error: "company_code required" });
    if (!isAdmin && !userCodes.includes(b.company_code))
      return res.status(403).json({ success: false, error: "Forbidden" });
    if (!Array.isArray(b.items) || b.items.length === 0)
      return res.status(400).json({ success: false, error: "items[] required" });

    var freq = b.frequency || "monthly";
    var dom  = Math.max(1, Math.min(28, parseInt(b.day_of_month || 1, 10)));
    var next = computeNextDue(freq, dom);

    var ins = await pool.query(`
      INSERT INTO recurring_orders
        (company_code, company_name, label, frequency, day_of_month, items,
         factory_code, load_port, delivery_addr, req_arrival_days, remarks,
         status, next_due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
      RETURNING *
    `, [
      b.company_code,
      b.company_name || null,
      b.label || "Recurring Order",
      freq, dom,
      JSON.stringify(b.items),
      b.factory_code || null,
      b.load_port || null,
      b.delivery_addr || null,
      b.req_arrival_days ? parseInt(b.req_arrival_days, 10) : null,
      b.remarks || null,
      next,
    ]);
    return res.status(201).json({ success: true, data: ins.rows[0] });
  }

  // ── PATCH ────────────────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    var urlParts3 = req.url.split("/").filter(Boolean);
    var patchId   = parseInt(urlParts3[urlParts3.length - 1], 10);
    if (!patchId) return res.status(400).json({ success: false, error: "Missing id" });

    var existing = await pool.query("SELECT * FROM recurring_orders WHERE id=$1", [patchId]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: "Not found" });
    if (!isAdmin && !userCodes.includes(existing.rows[0].company_code))
      return res.status(403).json({ success: false, error: "Forbidden" });

    var pb = req.body || {};
    var sets = [], vals = [];
    var allowed = ["label","frequency","day_of_month","items","factory_code","load_port",
                   "delivery_addr","req_arrival_days","remarks","status"];
    allowed.forEach(function(k) {
      if (pb[k] !== undefined) {
        vals.push(k === "items" ? JSON.stringify(pb[k]) : pb[k]);
        sets.push(k + "=$" + vals.length);
      }
    });
    // Recompute next_due if frequency/day_of_month changed
    if (pb.frequency !== undefined || pb.day_of_month !== undefined) {
      var newFreq = pb.frequency || existing.rows[0].frequency;
      var newDom  = pb.day_of_month || existing.rows[0].day_of_month;
      vals.push(computeNextDue(newFreq, newDom));
      sets.push("next_due_date=$" + vals.length);
    }
    vals.push(new Date().toISOString());
    sets.push("updated_at=$" + vals.length);
    vals.push(patchId);

    var up = await pool.query(
      "UPDATE recurring_orders SET " + sets.join(", ") + " WHERE id=$" + vals.length + " RETURNING *",
      vals
    );
    return res.json({ success: true, data: up.rows[0] });
  }

  // ── DELETE (soft cancel) ─────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    var urlParts4 = req.url.split("/").filter(Boolean);
    var delId     = parseInt(urlParts4[urlParts4.length - 1], 10);
    if (!delId) return res.status(400).json({ success: false, error: "Missing id" });
    var delRow = await pool.query("SELECT company_code FROM recurring_orders WHERE id=$1", [delId]);
    if (!delRow.rows[0]) return res.status(404).json({ success: false, error: "Not found" });
    if (!isAdmin && !userCodes.includes(delRow.rows[0].company_code))
      return res.status(403).json({ success: false, error: "Forbidden" });
    await pool.query("UPDATE recurring_orders SET status='cancelled', updated_at=NOW() WHERE id=$1", [delId]);
    return res.json({ success: true });
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}

// ── Fire one recurring order cycle ───────────────────────────────────────────
// Shared by both the cron job and the manual trigger endpoint.
export async function fireRecurring(pool, rec) {
  // Build minimal order payload matching order-create-v2 POST body
  var items = Array.isArray(rec.items) ? rec.items : JSON.parse(rec.items || "[]");
  var payload = {
    companyCode:  rec.company_code,
    companyName:  rec.company_name || rec.company_code,
    products:     items.map(function(it) {
      return {
        sku:        it.sku,
        name:       it.product_name || it.name || it.sku,
        qty:        it.qty || 0,
        unit_price: it.unit_price || 0,
        barcode:    it.barcode || "",
      };
    }),
    shipment: {
      loadPort:     rec.load_port    || "",
      deliveryAddr: rec.delivery_addr || "",
      remarks:      "[Auto-generated from recurring schedule: " + (rec.label || rec.id) + "]",
    },
    factory:      rec.factory_code || "",
    mode:         "draft",
    recurringId:  rec.id,
  };

  // POST to own order-create endpoint internally
  var { default: orderCreateHandler } = await import("./order-create-v2.js");

  // Build a fake req/res to reuse the handler
  var responseData = null;
  var fakeReq = {
    method: "POST",
    body: payload,
    user: { role: "admin", companyCode: rec.company_code },
    url: "/api/db/order-create-v2",
    headers: {},
  };
  var fakeRes = {
    status(c) { this._status = c; return this; },
    json(d)   { responseData = d; return this; },
    setHeader() {},
    _status: 200,
  };
  await orderCreateHandler(fakeReq, fakeRes);

  var orderNo = responseData && responseData.order_no ? responseData.order_no : null;

  // Compute and store next_due
  var nextDue = computeNextDue(rec.frequency, rec.day_of_month);
  await pool.query(`
    UPDATE recurring_orders
    SET last_run_at=$1, last_order_no=$2, next_due_date=$3, updated_at=NOW()
    WHERE id=$4
  `, [new Date().toISOString(), orderNo, nextDue, rec.id]);

  return orderNo;
}
