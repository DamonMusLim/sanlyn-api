export function cleanText(v){
  return String(v == null ? "" : v).trim();
}

export function numOrNull(v){
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function dateTime(v){
  if (!v) return null;
  var d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export function portChargeBoxGroup(boxType){
  var s = cleanText(boxType).toUpperCase();
  if (/^20/.test(s)) return "20";
  if (/^(40|45)/.test(s)) return "40";
  return "";
}

export function isUsablePortCharge(amount){
  var n = numOrNull(amount);
  return n != null && n > 0 && n <= 20000;
}

export async function loadSupplierPortCharges(pool, companyId, supplierName){
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT sp.id AS sp_id, sp.carrier_code, sp.container_type, sp.container_qty, sp.etd,
              b.id AS bill_id, b.bl_no, b.cost_category, b.amount, b.unit_price,
              COALESCE(NULLIF(b.currency_norm, ''), b.currency) AS currency,
              b.charge_basis,
              CASE
                WHEN b.link_plan_id = sp.id::text THEN 1
                WHEN b.resolved_plan_id = sp.id THEN 2
                ELSE 3
              END AS match_rank
         FROM shipping_plans sp
         JOIN freight_supplier_bills b
           ON b.link_plan_id = sp.id::text
           OR b.resolved_plan_id = sp.id
           OR (sp.bl_no IS NOT NULL AND sp.bl_no <> '' AND b.bl_no = sp.bl_no)
        WHERE sp.forwarder_company_id = $1
          AND b.supplier = $2
          AND (sp.etd >= CURRENT_DATE - interval '6 months' OR sp.etd IS NULL)
     ), picked AS (
       SELECT DISTINCT ON (bill_id) *
         FROM candidate
        ORDER BY bill_id, match_rank
     )
     SELECT p.sp_id, p.carrier_code, p.container_type, p.container_qty, p.etd, p.bill_id, p.bl_no,
            p.cost_category, p.amount, p.unit_price, p.currency, p.charge_basis,
            i.standard_item_code, i.standard_item_name, i.unit_basis, i.include_in_baseline
       FROM picked p
       LEFT JOIN LATERAL (
         SELECT standard_item_code, standard_item_name, unit_basis, include_in_baseline
           FROM carrier_tariff_charge_items i
          WHERE COALESCE(NULLIF(UPPER(BTRIM(p.currency)), ''), '') = 'CNY'
            AND i.raw_item_name = p.cost_category
            AND i.normalized_carrier IN (COALESCE(NULLIF(UPPER(BTRIM(p.carrier_code)), ''), '*'), '*')
          ORDER BY CASE WHEN i.normalized_carrier = COALESCE(NULLIF(UPPER(BTRIM(p.carrier_code)), ''), '*') THEN 0 ELSE 1 END,
                   i.confidence DESC NULLS LAST
          LIMIT 1
       ) i ON TRUE
      ORDER BY p.sp_id, p.bill_id`,
    [companyId, supplierName]
  );
  return rows;
}

export function attachSupplierPortCharges(plans, billRows){
  var byPlan = {};
  (plans || []).forEach(function(row){
    row._supplier_port_charges = { byGroup:{}, unmapped_count:0 };
    if (row && row.id != null) byPlan[String(row.id)] = row._supplier_port_charges;
  });
  (billRows || []).forEach(function(row){
    var target = byPlan[String(row.sp_id)];
    if (!target) return;
    var feeName = cleanText(row.cost_category);
    var blNo = cleanText(row.bl_no);
    if (cleanText(row.currency).toUpperCase() !== "CNY") return;
    if (!row.standard_item_code) {
      logUnmappedPortCharge(feeName, blNo, "dictionary_missing");
      target.unmapped_count += 1;
      return;
    }
    if (row.include_in_baseline !== true) return;
    var group = portChargeBoxGroup(row.container_type);
    if (!group) return;
    var slot = target.byGroup[group] || (target.byGroup[group] = {
      total:null, per_container:0, per_bill_total:0, container_qty:null, src_plan_id:row.sp_id, invalid:false,
    });
    var qty = numOrNull(row.container_qty);
    if (!(qty > 0)) { slot.invalid = true; return; }
    slot.container_qty = qty;
    var unit = numOrNull(row.unit_price);
    var amount = unit > 0 ? unit : numOrNull(row.amount);
    if (!(amount > 0)) return;
    var basis = cleanText(row.unit_basis).toLowerCase();
    if (basis === "container" && !(unit > 0) && qty > 1) {
      slot.invalid = true;
      logAmbiguousAmount(feeName, blNo, qty);
      return;
    }
    if (basis === "container") slot.per_container += amount;
    else slot.per_bill_total += amount;
    slot.total = slot.invalid ? null : slot.per_container + slot.per_bill_total / qty;
  });
}

function logUnmappedPortCharge(feeName, blNo, reason){
  console.warn("[port-charge] unmapped fee_name=" + feeName + " bl_no=" + blNo + " reason=" + reason);
}

function logAmbiguousAmount(feeName, blNo, qty){
  console.warn("[port-charge] ambiguous_amount fee_name=" + feeName + " bl_no=" + blNo + " qty=" + qty);
}

export function addSupplierPortCharge(carrier, row, ct, tk){
  var facts = row && row._supplier_port_charges;
  var group = portChargeBoxGroup(ct);
  if (!facts || !group) return;
  var charge = facts.byGroup[group];
  if (charge && !charge.invalid && isUsablePortCharge(charge.total)) {
    var existing = carrier.charges[group];
    if (!existing || tk >= existing.t) {
      carrier.charges[group] = {
        t:tk, total:charge.total, src_plan_id:charge.src_plan_id,
        parts:{
          per_container:charge.per_container,
          per_bill_total:charge.per_bill_total,
          container_qty:charge.container_qty,
        },
      };
    }
  } else if (charge) {
    carrier.chargeSkipped[group] = (carrier.chargeSkipped[group] || 0) + 1;
  }
  if (facts.unmapped_count) {
    carrier.portChargeUnmappedCount = (carrier.portChargeUnmappedCount || 0) + facts.unmapped_count;
  }
}

function stripSpec(label){
  return cleanText(label)
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .replace(/\bHS\s*(?:码\s*)?[\d.\s]{4,}/gi, " ")
    .replace(/\s\d+(\.\d+)?\s*(KG|G|ML|L)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dropChineseDuplicate(label){
  var s = cleanText(label);
  if (!/[A-Za-z]{3,}/.test(s) || !/[\u4e00-\u9fff]{2,}/.test(s)) return s;
  return s
    .replace(/\s*[\u4e00-\u9fff]{2,}\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function publicCargoName(v){
  var s = cleanText(v);
  if (!s) return null;
  var parts = s.split(/\s\/\s/).map(function(part){
    return dropChineseDuplicate(stripSpec(part));
  }).filter(Boolean);
  var seen = {}, base = [];
  parts.forEach(function(p){
    var k = p.toUpperCase();
    if (!seen[k]) { seen[k] = 1; base.push(p); }
  });
  if (!base.length) return null;
  var head = base.slice(0, 2).join(" / ");
  if (head.length > 40) head = head.slice(0, 39) + "…";
  return head + (base.length > 2 ? " 等" + base.length + "项" : "");
}

export function countWeekQuotedCarriers(carriers){
  return (carriers || []).filter(function(carrier){
    return carrierHasWeekQuote(carrier);
  }).length;
}

export function carrierHasWeekQuote(carrier){
  return (carrier && carrier.weeks || []).some(function(week){
    return week && (week.quoted || Object.keys(week.prices || {}).length > 0);
  });
}

export function refreshLaneQuoteStats(lane){
  (lane.carriers || []).forEach(function(carrier){
    carrier.quoted = carrierHasWeekQuote(carrier);
  });
  lane.quoted_carriers = countWeekQuotedCarriers(lane.carriers);
  lane.week_quoted_carriers = lane.quoted_carriers;
  lane.week_pending_carriers = (lane.carriers || []).length - lane.quoted_carriers;
  lane.has_any_week_quote = lane.quoted_carriers > 0;
}
