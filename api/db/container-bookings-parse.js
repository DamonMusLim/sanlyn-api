// /api/db/container-bookings-parse.js
// Parses trucking-dispatcher WeChat card text → upserts container_bookings row.
//
// Input format (either style, ":" or "：", with or without spaces):
//   拖箱时间:2026.04.14 08:00
//   装货地点:
//   详细地址:漳州市华安县圣王大道39号  武雄15960695697
//   车号:闽DH5391        (or 车辆:闽DH5391)
//   司机:徐克峰(15960225855)   (or 司机/电话:徐克峰/15960225855)
//   车架号:(或闽DN899挂)
//   提单号:I228525573
//   箱号:TCNU1446076
//   封签号:YMAV897778
//   箱型:40HQ 出口             (or 尺寸/箱型:40/HQ)
//   柜重:3700KG                 (or 柜重:3700)
//   货重:-                       (optional)
//   提箱地:裕利象屿
//   还箱地:海天码头             (or 卸箱地:海天码头)
//   订单号:-                     (optional)
//
// POST body: { text: "...", bl_no?: "...", contract_no?: "...", shipping_plan_id?: 123 }
//   - If bl_no not provided, derives from 提单号 field (prepends carrier prefix if short).
//   - Upserts on (bl_no, container_no).

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Field patterns ──────────────────────────────────────────────────
// Each regex captures the value. Multiple labels per field for tolerance.
var FIELD_PATTERNS = {
  pickupTime:     [/拖箱时间[:：]\s*([^\n]+)/],
  loadingAddress: [/(?:详细地址|工厂地址|装货地址)[:：]\s*([^\n]+)/],
  truckPlate:     [/(?:车号|车辆)[:：]\s*([^\n]+)/],
  trailerPlate:   [/车架号[:：]\s*\(?([^)\n]*)\)?/],
  driverLine:     [/司机(?:\/电话)?[:：]\s*([^\n]+)/],
  bookingNo:      [/提单号[:：]\s*([^\n]+)/],
  containerNo:    [/箱号[:：]\s*([A-Z]{4}\d{7})/i],
  sealNo:         [/封签号[:：]\s*([^\n]+)/],
  containerType:  [/(?:箱型|尺寸\/箱型)[:：]\s*([^\n]+)/],
  tareWeight:     [/柜重[:：]\s*(\d+(?:\.\d+)?)\s*(?:KG|kg)?/],
  cargoWeight:    [/货重[:：]\s*(\d+(?:\.\d+)?)\s*(?:KG|kg|T|吨)?/],
  pickupYard:     [/提箱地[:：]\s*([^\n]+)/],
  returnYard:     [/(?:还箱地|卸箱地)[:：]\s*([^\n]+)/],
  contractNo:     [/订单号[:：]\s*([^\n\-][^\n]*)/],
};

function matchFirst(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function parsePickupTime(s) {
  if (!s) return null;
  // "2026.04.14 08:00" or "2026-04-14 08:00" or "2026/04/14 08:00"
  var norm = s.replace(/[.\/]/g, "-").trim();
  // Accept "YYYY-MM-DD HH:MM[:SS]"
  var m = norm.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + ":" + (m[6] || "00");
}

function parseDriver(line) {
  // "徐克峰(15960225855)" or "徐克峰/15960225855" or "陈建华(13023920680)"
  var m = line.match(/([\u4e00-\u9fa5A-Za-z·]+)\s*[\(\/]\s*(\d{11})/);
  if (m) return { name: m[1], phone: m[2] };
  // Fallback: split by any separator
  var parts = line.split(/[\s\(\)\/\-,，]+/).filter(Boolean);
  var phone = parts.find(function (p) { return /^\d{11}$/.test(p); }) || "";
  var name = parts.find(function (p) { return /[\u4e00-\u9fa5]/.test(p); }) || "";
  return { name: name, phone: phone };
}

function normalizeContainerType(raw) {
  if (!raw) return "40HQ";
  // "40HQ 出口" → "40HQ"; "40/HQ" → "40HQ"; "20GP" stays
  var up = raw.toUpperCase().replace(/\s+.*$/, "").replace(/\//g, "");
  if (/^(20|40|45)(GP|HQ|HC|RF|OT|FR)/.test(up)) return up.match(/^(20|40|45)(GP|HQ|HC|RF|OT|FR)/)[0];
  return up || "40HQ";
}

export function parseCard(text) {
  var raw = String(text || "");
  var out = {
    pickup_time:     parsePickupTime(matchFirst(raw, FIELD_PATTERNS.pickupTime)),
    loading_address: matchFirst(raw, FIELD_PATTERNS.loadingAddress),
    truck_plate:     matchFirst(raw, FIELD_PATTERNS.truckPlate),
    trailer_plate:   matchFirst(raw, FIELD_PATTERNS.trailerPlate) || null,
    booking_no:      matchFirst(raw, FIELD_PATTERNS.bookingNo),
    container_no:    (matchFirst(raw, FIELD_PATTERNS.containerNo) || "").toUpperCase(),
    seal_no:         matchFirst(raw, FIELD_PATTERNS.sealNo),
    container_type:  normalizeContainerType(matchFirst(raw, FIELD_PATTERNS.containerType)),
    tare_weight_kg:  parseFloat(matchFirst(raw, FIELD_PATTERNS.tareWeight)) || null,
    cargo_weight_kg: parseFloat(matchFirst(raw, FIELD_PATTERNS.cargoWeight)) || null,
    pickup_yard:     matchFirst(raw, FIELD_PATTERNS.pickupYard),
    return_yard:     matchFirst(raw, FIELD_PATTERNS.returnYard),
    contract_no:     matchFirst(raw, FIELD_PATTERNS.contractNo) || null,
  };
  var d = parseDriver(matchFirst(raw, FIELD_PATTERNS.driverLine));
  out.driver_name  = d.name;
  out.driver_phone = d.phone;
  // Split loading_address and loading_contact if address contains trailing phone/name
  // e.g. "漳州市华安县圣王大道39号  武雄15960695697"
  if (out.loading_address) {
    var am = out.loading_address.match(/^(.+?)[\s　]+([\u4e00-\u9fa5]+\s*1\d{10})\s*$/);
    if (am) { out.loading_address = am[1].trim(); out.loading_contact = am[2].trim(); }
  }
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();
  const pool = getPool();

  try {
    var body = req.body || {};
    var text = body.text || "";
    var blOverride = body.bl_no || "";
    var contractOverride = body.contract_no || "";
    var shippingPlanId = body.shipping_plan_id || null;
    var preview = !!body.preview;  // preview=true → no DB write, just return parsed + candidates
    if (!text) return res.status(400).json({ error: "text required" });

    // ── Support multi-card input: split by "---" lines or blank separators ──
    var blocks = text.split(/\n\s*-{3,}\s*\n|\n\s*={3,}\s*\n/).map(function (b) { return b.trim(); }).filter(Boolean);
    if (!blocks.length) blocks = [text];

    var results = [];
    for (var i = 0; i < blocks.length; i++) {
      var parsed = parseCard(blocks[i]);
      if (!parsed.container_no) { results.push({ ok: false, error: "container_no not found", raw: blocks[i].slice(0, 80) }); continue; }

      // Resolve bl_no + shipping_plan + candidate contracts
      var bl_no = blOverride;
      var plan = null;
      if (parsed.booking_no || bl_no) {
        var spR = await pool.query(
          "SELECT id, bl_no, customer, order_contract_nos, forwarder_booking_no, raw FROM shipping_plans " +
          "WHERE ($1::text <> '' AND (forwarder_booking_no=$1 OR bl_no LIKE '%'||$1)) " +
          "   OR ($2::text <> '' AND bl_no=$2) LIMIT 1",
          [parsed.booking_no || "", bl_no || ""]
        );
        if (spR.rows.length) plan = spR.rows[0];
      }
      if (!bl_no) bl_no = (plan && plan.bl_no) || parsed.booking_no;
      if (!bl_no) { results.push({ ok: false, error: "bl_no could not be resolved", parsed: parsed }); continue; }

      // Candidate contracts + factory ready dates (for preview UI to show + let dispatcher pick)
      var candidateContracts = [];
      if (plan && plan.order_contract_nos) {
        var cnos = String(plan.order_contract_nos).split(",").map(function(s){return s.trim();}).filter(Boolean);
        if (cnos.length) {
          var oR = await pool.query(
            "SELECT contract_no, raw->>'actDelivery' AS act_delivery, raw->>'readyDate' AS ready_date, " +
            "       raw->>'deliveryDate' AS delivery_date, raw->>'customerPO' AS customer_po " +
            "FROM orders WHERE contract_no = ANY($1::text[])",
            [cnos]
          );
          var byCno = {};
          oR.rows.forEach(function(r){ byCno[r.contract_no] = r; });
          candidateContracts = cnos.map(function(c){
            var o = byCno[c] || {};
            return {
              contract_no: c,
              customer_po: o.customer_po || null,
              factory_ready: o.act_delivery || o.ready_date || o.delivery_date || null,
            };
          });
        }
      }

      // Resolve contract_no: explicit > parsed > auto if only 1 candidate > null (UI will ask)
      var contract_no = contractOverride || parsed.contract_no || null;
      if (!contract_no && candidateContracts.length === 1) contract_no = candidateContracts[0].contract_no;

      // Preview mode: return everything, do NOT write
      if (preview) {
        results.push({
          ok: true,
          preview: true,
          parsed: parsed,
          resolved: {
            bl_no: bl_no,
            shipping_plan_id: (plan && plan.id) || shippingPlanId || null,
            customer: plan && plan.customer,
            contract_no: contract_no,          // null if dispatcher needs to pick
            candidates: candidateContracts,    // all contracts on this BL with factory_ready dates
          }
        });
        continue;
      }

      // Non-preview: require contract_no to be resolved (single candidate or explicit)
      if (!contract_no && candidateContracts.length > 1) {
        results.push({
          ok: false,
          error: "contract_no ambiguous — multiple orders on this BL, pick one",
          parsed: parsed,
          candidates: candidateContracts,
        });
        continue;
      }

      // Per-row plan id: prefer resolved plan, fall back to body override
      var rowPlanId = (plan && plan.id) || shippingPlanId || null;

      // Build insert
      var fields = {
        bl_no: bl_no,
        booking_no: parsed.booking_no || null,
        shipping_plan_id: rowPlanId,
        contract_no: contract_no,
        container_no: parsed.container_no,
        seal_no: parsed.seal_no || null,
        container_type: parsed.container_type || "40HQ",
        tare_weight_kg: parsed.tare_weight_kg,
        cargo_weight_kg: parsed.cargo_weight_kg,
        pickup_time: parsed.pickup_time,
        pickup_yard: parsed.pickup_yard || null,
        return_yard: parsed.return_yard || null,
        loading_address: parsed.loading_address || null,
        loading_contact: parsed.loading_contact || null,
        truck_plate: parsed.truck_plate || null,
        trailer_plate: parsed.trailer_plate,
        driver_name: parsed.driver_name || null,
        driver_phone: parsed.driver_phone || null,
      };
      var cols = Object.keys(fields);
      var ph = cols.map(function (_, ix) { return "$" + (ix + 1); });
      var setCols = cols.filter(function (c) { return c !== "bl_no" && c !== "container_no"; })
                        .map(function (c) { return c + "=COALESCE(EXCLUDED." + c + ", container_bookings." + c + ")"; })
                        .concat(["updated_at=NOW()"]);
      var sql = "INSERT INTO container_bookings (" + cols.join(",") + ",created_by) VALUES (" +
                ph.join(",") + ",$" + (cols.length + 1) + ")" +
                " ON CONFLICT (bl_no,container_no) DO UPDATE SET " + setCols.join(",") +
                " RETURNING *";
      var params = cols.map(function (c) { return fields[c]; }).concat([(req.user && req.user.username) || "dispatcher"]);
      var r = await pool.query(sql, params);
      results.push({ ok: true, data: r.rows[0] });
    }

    return res.json({ success: true, count: results.length, results: results });
  } catch (e) {
    console.error("[container-bookings-parse] error:", e);
    return res.status(500).json({ error: e.message });
  }
}
