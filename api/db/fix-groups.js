import { getPool, setCors } from "../db.js";

// Group assignments: group_id → [company_codes]
var GROUPS = [
  { groupId: "PETSOME",       codes: ["PETSOME", "PETSOME_EU", "DIBAQ"] },
  { groupId: "ENRICH",        codes: ["ENRICH"] },
  { groupId: "HARMONIOUS",    codes: ["HARMONIOUS"] },
  { groupId: "EVERSPARKLES",  codes: ["EVERSPARKLES"] },
  { groupId: "FORTUNESANLYN", codes: ["FORTUNESANLYN"] },
  { groupId: "JJ_PET",        codes: ["JJ_PET"] },
];

var ENRICHMENTS = [
  { company_code: "ENRICH",        payment_term: "A：发货前全款", raw_extra: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", weHandleOcean:"是" } },
  { company_code: "HARMONIOUS",    payment_term: "B：30%定金+70%尾款", raw_extra: { customerLevel:"B", defaultPayment:"B：30%定金+70%尾款", tradeTerms:"FOB", weHandleOcean:"是" } },
  { company_code: "EVERSPARKLES",  raw_extra: { customerLevel:"B", tradeTerms:"FOB", blTypePref:"SWB", weHandleOcean:"是" }, addresses: [{ country:"Philippines", port:"", consignee:"Nexquest- KMPInternational Corporation" }] },
  { company_code: "FORTUNESANLYN", raw_extra: { customerLevel:"A", tradeTerms:"FOB", weHandleOcean:"是" }, addresses: [{ country:"Saudi Arabia", port:"", consignee:"AL BASHEK COMPANY" }] },
  { company_code: "PETSOME",       raw_extra: { customerLevel:"A", tradeTerms:"FOB", blTypePref:"SWB", logisticsMarkup:"按固定金额加价（每柜）", weHandleOcean:"是" }, addresses: [{ country:"Malaysia", port:"Kota Kinabalu", consignee:"PETSOME SDN BHD" }] },
  { company_code: "DIBAQ",         raw_extra: { customerLevel:"A", tradeTerms:"FOB", logisticsMarkup:"按百分比加价", logisticsMarkupPct:0.2, weHandleOcean:"是" } },
  { company_code: "JJ_PET",        raw_extra: { customerLevel:"A", tradeTerms:"FOB", weHandleOcean:"是" } },
  { company_code: "PETSOME_EU",    raw_extra: { customerLevel:"A", tradeTerms:"FOB", logisticsMarkup:"按固定金额加价（每柜）", logisticsMarkupCtn:20, weHandleOcean:"是" } },
];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var log = [];

    // Step 1: Set group_id
    log.push("=== Step 1: Setting group_id ===");
    for (var g of GROUPS) {
      for (var code of g.codes) {
        var r = await pool.query(
          "UPDATE customers SET group_id = $1, updated_at = NOW() WHERE company_code = $2 RETURNING company_code, group_id, name_en",
          [g.groupId, code]
        );
        if (r.rowCount > 0) {
          log.push("✓ " + code + " → group=" + g.groupId + " (" + r.rows[0].name_en + ")");
        } else {
          log.push("✗ " + code + " — not found");
        }
      }
    }

    // Step 2: Enrich with JDY data
    log.push("=== Step 2: Enriching customer data ===");
    for (var e of ENRICHMENTS) {
      var sets = [];
      var params = [e.company_code];
      var idx = 2;
      if (e.payment_term) { sets.push("payment_term = $" + idx); params.push(e.payment_term); idx++; }
      if (e.addresses)    { sets.push("addresses = $" + idx);     params.push(JSON.stringify(e.addresses)); idx++; }
      if (e.raw_extra)    { sets.push("raw = raw || $" + idx);    params.push(JSON.stringify(e.raw_extra)); idx++; }
      sets.push("updated_at = NOW()");
      var sql = "UPDATE customers SET " + sets.join(", ") + " WHERE company_code = $1 RETURNING company_code, name_en, payment_term, addresses";
      var r = await pool.query(sql, params);
      if (r.rowCount > 0) {
        log.push("✓ " + e.company_code + " enriched");
      } else {
        log.push("✗ " + e.company_code + " — not found");
      }
    }

    // Step 3: Deactivate old CN-coded records without brands
    log.push("=== Step 3: Deactivating old CN-coded records ===");
    var r = await pool.query(
      "UPDATE customers SET is_active = false, updated_at = NOW() WHERE company_code LIKE 'CN-%' AND (brands IS NULL OR brands = '[]'::jsonb) RETURNING company_code, name_en"
    );
    log.push("Deactivated " + r.rowCount + " CN-coded records");

    // Step 4: Verify
    log.push("=== Step 4: Active customers ===");
    var all = await pool.query(
      "SELECT company_code, name_en, group_id, brands, is_active FROM customers WHERE is_active = true ORDER BY company_code"
    );
    log.push("Total active: " + all.rowCount);
    for (var row of all.rows) {
      log.push(row.company_code + " | group=" + (row.group_id || "—") + " | " + row.name_en + " | brands=" + JSON.stringify(row.brands));
    }

    return res.status(200).json({ success: true, log: log });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
