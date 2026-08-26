export const OCEAN_BUSINESS_KEYS = new Set([
  "carrier_code", "shipping_line", "release_type",
  "forwarder_cn", "forwarder_en", "so_no", "so_info", "so_bl_reference", "so_bl_ref_pending",
  "sailings", "customer_selected_sailing", "freight_sale_usd", "rate_usd", "hbl_no",
  "freight_rate_baseline", "ocean_freight", "freight_amount",
]);

export const VOYAGE_FACT_KEYS = new Set(["vessel", "voyage", "pod", "etd", "eta"]);
export const OCEAN_ONLY_KEYS = OCEAN_BUSINESS_KEYS;

const SEGMENT_ORDER = ["ocean", "truck", "customs"];
const TYPE_SEGMENTS = {
  forwarder: new Set(["ocean", "truck", "customs"]),
  trucking: new Set(["truck"]),
  customs_broker: new Set(["customs"]),
};

function clean(v) {
  return String(v || "").trim();
}

function requestedList(requested) {
  return Array.isArray(requested) ? requested.map(clean).filter(Boolean) : [];
}

function makeSegments(requested, allowed) {
  const req = requestedList(requested);
  const reqSet = new Set(req);
  const segments = SEGMENT_ORDER.filter(s => reqSet.has(s) && allowed.has(s));
  if (reqSet.has("factory")) segments.push("factory");
  return segments;
}

async function resolveCompany(pool, label, code) {
  const key = clean(label);
  const companyCode = clean(code);
  if (!key && !companyCode) return null;
  const found = await pool.query(
    `SELECT id, code, name_cn, short_name, type, merged_into_code
       FROM companies
      WHERE name_cn = $1 OR short_name = $1 OR code = $2
      ORDER BY (merged_into_code IS NULL) DESC, id LIMIT 1`,
    [key, companyCode]
  );
  let company = found.rows[0] || null;
  if (company?.merged_into_code) {
    const canon = await pool.query(
      `SELECT id, code, name_cn, short_name, type, merged_into_code
         FROM companies WHERE code = $1 LIMIT 1`,
      [company.merged_into_code]
    );
    company = canon.rows[0] || company;
  }
  return company;
}

async function companyMatchesOcean(pool, planId, company, companyLabel) {
  const plan = await pool.query(
    `SELECT sp.forwarder_company_id, sp.forwarder_cn, sp.bl_no, cf.code AS forwarder_code
       FROM shipping_plans sp
       LEFT JOIN companies cf ON cf.id = sp.forwarder_company_id
      WHERE sp.id = $1 LIMIT 1`,
    [planId]
  );
  const sp = plan.rows[0] || {};
  const names = [company.name_cn, company.short_name].map(clean).filter(Boolean);
  if (sp.forwarder_company_id != null && Number(sp.forwarder_company_id) === Number(company.id)) return true;
  if (clean(sp.forwarder_code) && clean(sp.forwarder_code) === clean(company.code)) return true;
  if (clean(sp.forwarder_cn) && names.includes(clean(sp.forwarder_cn))) return true;
  const bills = await pool.query(
    `SELECT 1
       FROM freight_supplier_bills
      WHERE (link_plan_id = $1::text OR ($2 <> '' AND bl_no = $2))
        AND supplier_company_code = $3
        AND cost_category ~* '海运|ocean|freight|运费|BAF|THC.*OCEAN'
      LIMIT 1`,
    [planId, clean(sp.bl_no), clean(company.code)]
  );
  if (bills.rows.length > 0) return true;
  const shortName = clean(company.short_name);
  if (shortName.length >= 3 && clean(sp.forwarder_cn).includes(shortName)) return true;
  console.warn("[portal-segments] forwarder denied ocean:", {
    planId,
    company: clean(company.code) || clean(companyLabel) || clean(company.name_cn) || clean(company.short_name),
    forwarder_cn: sp.forwarder_cn,
  });
  return false;
}

export async function derivePortalSegments(pool, { planId, companyLabel, companyCode, requested } = {}) {
  try {
    const company = await resolveCompany(pool, companyLabel, companyCode);
    const companyType = company?.type || null;
    const code = company?.code || null;
    const allowed = new Set(TYPE_SEGMENTS[companyType] || []);
    let reason = company ? `company type ${companyType || "unknown"} allows ${[...allowed].join(",") || "no segments"}` : "company not found, fail closed";
    if (allowed.has("ocean")) {
      const match = companyType === "forwarder" && await companyMatchesOcean(pool, planId, company, companyLabel);
      if (!match) {
        allowed.delete("ocean");
        reason = `company ${code || clean(companyLabel)} is not the ocean forwarder for plan ${planId}`;
      } else {
        reason = `company ${code || clean(companyLabel)} matches plan ${planId} ocean forwarder`;
      }
    }
    const segments = makeSegments(requested, allowed);
    return { segments, allowOcean: segments.includes("ocean"), companyType, companyCode: code, reason };
  } catch (e) {
    return { segments: [], allowOcean: false, companyType: null, companyCode: null, reason: `portal segment derive failed: ${e.message}` };
  }
}

export function stripOceanDeep(node, { keepVoyageFacts = false } = {}) {
  if (Array.isArray(node)) { node.forEach(item => stripOceanDeep(item, { keepVoyageFacts })); return; }
  if (!node || typeof node !== "object") return;
  for (const k of Object.keys(node)) {
    if (OCEAN_BUSINESS_KEYS.has(k) || (!keepVoyageFacts && VOYAGE_FACT_KEYS.has(k))) { delete node[k]; continue; }
    stripOceanDeep(node[k], { keepVoyageFacts });
  }
}
