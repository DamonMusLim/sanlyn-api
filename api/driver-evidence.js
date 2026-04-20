// /api/driver-evidence.js
// Public endpoint for driver QR-scan evidence upload.
// No JWT — authorized by the (bl_no, container_no) pair which is printed on the QR.
//
//   GET  ?bl=<bl>&container=<cno>        → returns dispatcher-prefilled fields (read-only)
//   POST { bl_no, container_no, cargo_weight_kg, evidence_photos, seal_photo_url,
//          weight_ticket_url, driver_submitted_at, seal_no?, truck_plate?,
//          driver_name?, driver_phone? }
//          → UPDATE only; never INSERT (prevents bogus rows).
//          → Rejects if record already has driver_submitted_at (single-submit).

import { getPool, setCors } from "./db.js";

// Fields the driver is allowed to write (weight + transport)
const DRIVER_FIELDS = [
  "cargo_weight_kg",
  "weight_ticket_url",
  "driver_submitted_at",
  // Overrides if dispatcher info was wrong
  "truck_plate",
  "driver_name",
  "driver_phone",
];

// Fields the factory is allowed to write (on-site loading)
const FACTORY_FIELDS = [
  "loading_photos",        // JSONB — 9-grid装柜照
  "seal_photo_url",        // 封签特写
  "seal_no",               // 如果现场封签号和调度预填不同
  "loading_note",
  "factory_submitted_at",
  "factory_submitted_by",
];

const JSONB = new Set(["loading_photos","evidence_photos"]);

// Readable subset returned to the page (both factory and driver see all of this)
const READ_FIELDS = [
  "id","bl_no","container_no","contract_no","seal_no","container_type",
  "tare_weight_kg","cargo_weight_kg","pickup_time","pickup_yard","return_yard",
  "loading_address","loading_contact","truck_plate","trailer_plate",
  "driver_name","driver_phone","trucking_company",
  "evidence_photos","loading_photos","loading_note","seal_photo_url","weight_ticket_url",
  "driver_submitted_at","factory_submitted_at","factory_submitted_by",
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    if (req.method === "GET") {
      var bl = req.query.bl || req.query.bl_no;
      var cno = (req.query.container || req.query.container_no || "").toUpperCase();
      if (!bl || !cno) return res.status(400).json({ error: "bl and container required" });
      var r = await pool.query(
        "SELECT " + READ_FIELDS.join(",") + " FROM container_bookings WHERE bl_no=$1 AND container_no=$2 LIMIT 1",
        [bl, cno]
      );
      var row = r.rows[0] || null;
      // Enrich with customer_po + customer name from orders, plus SO (booking_no) from plan
      if (row && row.contract_no) {
        try {
          var oR = await pool.query(
            "SELECT raw->>'customerPO' AS customer_po, customer FROM orders WHERE contract_no=$1 LIMIT 1",
            [row.contract_no]
          );
          if (oR.rows.length) {
            row.customer_po = oR.rows[0].customer_po || null;
            row.customer = oR.rows[0].customer || null;
          }
          var sR = await pool.query(
            "SELECT forwarder_booking_no FROM shipping_plans WHERE bl_no=$1 LIMIT 1",
            [bl]
          );
          if (sR.rows.length) row.booking_no = sR.rows[0].forwarder_booking_no || null;
        } catch (_) {}
      }
      return res.json({ success: true, data: row });
    }

    if (req.method === "POST") {
      var body = req.body || {};
      var bl = body.bl_no;
      var cno = (body.container_no || "").toUpperCase();
      var role = (body.role || "driver").toLowerCase();   // "driver" | "factory"
      if (!bl || !cno) return res.status(400).json({ error: "bl_no and container_no required" });
      if (role !== "driver" && role !== "factory") return res.status(400).json({ error: "role must be driver or factory" });

      // Must be an existing dispatcher-created row
      var exist = await pool.query(
        "SELECT id, driver_submitted_at, factory_submitted_at FROM container_bookings WHERE bl_no=$1 AND container_no=$2 LIMIT 1",
        [bl, cno]
      );
      if (!exist.rows.length) {
        return res.status(404).json({ error: "No dispatcher record found for this container. Please contact dispatcher." });
      }
      var alreadyAt = role === "driver" ? exist.rows[0].driver_submitted_at : exist.rows[0].factory_submitted_at;
      if (alreadyAt) {
        return res.status(409).json({ error: "Already submitted by " + role, submitted_at: alreadyAt });
      }

      // Pick whitelisted fields by role
      var allowed = role === "driver" ? DRIVER_FIELDS : FACTORY_FIELDS;
      var ipColumn = role === "driver" ? "driver_submitted_ip" : "factory_submitted_ip";

      var sets = [], params = [], i = 0;
      allowed.forEach(function (k) {
        if (body[k] === undefined) return;
        var v = body[k] === "" ? null : body[k];
        if (v != null && JSONB.has(k) && typeof v !== "string") v = JSON.stringify(v);
        i++; sets.push(k + "=$" + i); params.push(v);
      });
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      sets.push("updated_at=NOW()");
      var ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
      if (ip) { i++; sets.push(ipColumn + "=$" + i); params.push(String(ip).split(",")[0].trim()); }

      params.push(bl);   var iBl = ++i;
      params.push(cno);  var iCno = ++i;

      var sql = "UPDATE container_bookings SET " + sets.join(",") +
                " WHERE bl_no=$" + iBl + " AND container_no=$" + iCno + " RETURNING *";
      var r = await pool.query(sql, params);
      return res.json({ success: true, data: r.rows[0], role: role });
    }

    return res.status(405).end();
  } catch (e) {
    console.error("[driver-evidence] error:", e);
    return res.status(500).json({ error: e.message });
  }
}
