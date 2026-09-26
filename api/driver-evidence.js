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

// Fields the driver is allowed to write (weight + transport + pickup/return evidence)
const DRIVER_FIELDS = [
  "cargo_weight_kg",
  "weight_ticket_url",
  "driver_submitted_at",
  // Overrides if dispatcher info was wrong
  "truck_plate",
  "driver_name",
  "driver_phone",
  // NEW: stage-specific photo sets
  "pickup_photos",         // JSONB — 提柜阶段照片
  "return_photos",         // JSONB — 还柜阶段照片
  "pickup_submitted_at",
  "return_submitted_at",
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

const JSONB = new Set(["loading_photos","evidence_photos","pickup_photos","return_photos"]);

// Readable subset returned to the page (both factory and driver see all of this)
const READ_FIELDS = [
  "id","bl_no","container_no","contract_no","seal_no","container_type",
  "tare_weight_kg","cargo_weight_kg","pickup_time","pickup_yard","return_yard",
  "loading_address","loading_contact","truck_plate","trailer_plate",
  "driver_name","driver_phone","trucking_company",
  "evidence_photos","loading_photos","pickup_photos","return_photos",
  "loading_note","seal_photo_url","weight_ticket_url",
  "driver_submitted_at","factory_submitted_at","factory_submitted_by",
  "pickup_submitted_at","return_submitted_at",
];

// ⚠️ 2026-08-29:本接口在免登录白名单里,"授权"仅凭 QR 上印的 (bl_no, container_no)——
//    这两个印在柜门和提单上,不是秘密。实测可用猜到的提单号+柜号拿到整柜数据。
//    所以 GET 只返回司机填单必需的字段。
//    ⛔ 新增字段前先想清楚:被人拿提单号猜到,泄露了要紧吗?
//    司机姓名/电话/证件号、车牌、装货地址、合同号 一律不许加回来。
const GET_FIELDS = [
  "id","bl_no","container_no","container_type","seal_no",
  "tare_weight_kg","cargo_weight_kg",
  "pickup_yard","return_yard","pickup_time",
  "evidence_photos","loading_photos","pickup_photos","return_photos",
  "seal_photo_url","weight_ticket_url","loading_note",
  "driver_submitted_at","pickup_submitted_at","return_submitted_at",
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
        "SELECT " + GET_FIELDS.join(",") + " FROM container_bookings WHERE bl_no=$1 AND container_no=$2 LIMIT 1",
        [bl, cno]
      );
      var row = r.rows[0] || null;
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
        "SELECT id, driver_submitted_at, factory_submitted_at, pickup_submitted_at, return_submitted_at FROM container_bookings WHERE bl_no=$1 AND container_no=$2 LIMIT 1",
        [bl, cno]
      );
      if (!exist.rows.length) {
        return res.status(404).json({ error: "No dispatcher record found for this container. Please contact dispatcher." });
      }
      // Stage-aware single-submit guard:
      //   • pickup_photos payload → check pickup_submitted_at
      //   • return_photos payload → check return_submitted_at
      //   • loading_photos payload (factory) → check factory_submitted_at
      //   • weight_ticket_url/cargo_weight_kg (driver weight) → check driver_submitted_at
      var row0 = exist.rows[0];
      var stage = body.stage || null; // optional explicit stage hint from client
      if ((body.pickup_photos || stage === "pickup") && row0.pickup_submitted_at) {
        return res.status(409).json({ error: "pickup already submitted", submitted_at: row0.pickup_submitted_at, stage: "pickup" });
      }
      if ((body.return_photos || stage === "return") && row0.return_submitted_at) {
        return res.status(409).json({ error: "return already submitted", submitted_at: row0.return_submitted_at, stage: "return" });
      }
      if (role === "factory" && row0.factory_submitted_at) {
        return res.status(409).json({ error: "loading already submitted", submitted_at: row0.factory_submitted_at, stage: "loading" });
      }
      if (role === "driver" && (body.weight_ticket_url || body.cargo_weight_kg) && row0.driver_submitted_at) {
        return res.status(409).json({ error: "driver weight already submitted", submitted_at: row0.driver_submitted_at, stage: "weight" });
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
      if (role === "factory") {
        // 工厂扫码提交装柜证据时，记录首次派车/装柜确认时间到票级告警字段。
        await pool.query(
          `UPDATE shipping_plans
              SET factory_dispatch_confirmed_at = COALESCE(factory_dispatch_confirmed_at, NOW()),
                  updated_at = NOW()
            WHERE bl_no = $1`,
          [bl]
        );
      }
      return res.json({ success: true, data: r.rows[0], role: role });
    }

    return res.status(405).end();
  } catch (e) {
    console.error("[driver-evidence] error:", e);
    return res.status(500).json({ error: e.message });
  }
}
