import { setCors, getPool } from "./db.js";

var CW = {
  companyCode:      "_widget_1771622930859",  // 客户代号
  selectCompany:    "_widget_1766650731323",  // 选择公司（linkdata）
  nameEN:           "_widget_1762568848071",  // 客户公司（英文）
  brands:           "_widget_1759129256811",  // Brand (combocheck)
  relatedFactory:   "_widget_1774282924487",  // 关联工厂 (combocheck)
  country:          "_widget_1768475611585",  // 国家
  currency:         "_widget_1770797795019",  // 交易币种
  paymentMethod:    "_widget_1772321952179",  // 付款方式
  customerLevel:    "_widget_1766834853664",  // 客户等级
};

function get(row, w) {
  var v = row[w];
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  return v;
}

function parseBrands(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(function(b) { return (typeof b === "string" ? b : b.value || b.name || "").trim(); }).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[,，、]/).map(function(s) { return s.trim(); }).filter(Boolean);
  return [];
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-customer-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var body = req.body;
    var op   = body.op || "";
    if (op === "data_remove") return res.status(200).json({ ok: true, skip: "delete" });

    var row = body.data?.data || body.data || body;
    // 优先用「选择公司」linkdata字段，fallback到「客户代号」
    var selectCompanyRaw = get(row, CW.selectCompany);
    var linkedCode = Array.isArray(selectCompanyRaw)
      ? (selectCompanyRaw[0]?._id || selectCompanyRaw[0])
      : (typeof selectCompanyRaw === "object" ? selectCompanyRaw?._id : selectCompanyRaw);
    var companyCode = linkedCode || get(row, CW.companyCode);
    if (!companyCode) return res.status(200).json({ ok: true, skip: "no companyCode" });

    var nameEN       = get(row, CW.nameEN) || "";
    var brandsRaw    = get(row, CW.brands);
    var brands       = parseBrands(brandsRaw);
    var factoryRaw   = get(row, CW.relatedFactory);
    var factories    = parseBrands(factoryRaw);
    var country      = get(row, CW.country) || "";
    var currency     = get(row, CW.currency) || "";
    var paymentMethod= get(row, CW.paymentMethod) || "";
    var customerLevel= get(row, CW.customerLevel) || "";

    var pool = getPool();

    // Upsert — 更新品牌和基本信息
    var sets = ["updated_at = NOW()"];
    var params = [];
    var idx = 0;

    // 始终更新 raw 中的实时数据
    idx++; params.push(JSON.stringify({ relatedFactory: factories, customerLevel: customerLevel, lastWebhook: new Date().toISOString() }));
    sets.push("raw = raw || $" + idx + "::jsonb");

    if (nameEN) { idx++; params.push(nameEN); sets.push("name_en = COALESCE(NULLIF($" + idx + ",''), name_en)"); }
    if (brands.length > 0) { idx++; params.push(JSON.stringify(brands)); sets.push("brands = $" + idx + "::jsonb"); }
    if (country) { idx++; params.push(country); sets.push("country = COALESCE(NULLIF($" + idx + ",''), country)"); }
    if (currency) { idx++; params.push(currency); sets.push("currency = COALESCE(NULLIF($" + idx + ",''), currency)"); }
    if (paymentMethod) { idx++; params.push(paymentMethod); sets.push("payment_term = COALESCE(NULLIF($" + idx + ",''), payment_term)"); }

    idx++; params.push(companyCode);
    var whereIdx = idx;

    var r = await pool.query(
      "UPDATE customers SET " + sets.join(", ") + " WHERE company_code = $" + whereIdx + " OR raw->>'companyCode' = $" + whereIdx + " RETURNING company_code, brands",
      params
    );

    // 如果没有匹配行（新客户），insert
    if (r.rowCount === 0 && companyCode) {
      var insertR = await pool.query(
        `INSERT INTO customers (company_code, name_en, brands, country, currency, payment_term, portal_role, raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'customer', $7)
         ON CONFLICT (company_code) DO NOTHING
         RETURNING company_code, brands`,
        [companyCode, nameEN, JSON.stringify(brands), country, currency, paymentMethod,
         JSON.stringify({ relatedFactory: factories, customerLevel: customerLevel })]
      );
      return res.status(200).json({ ok: true, inserted: insertR.rowCount, companyCode, brands });
    }

    return res.status(200).json({ ok: true, updated: r.rowCount, companyCode, brands });
  } catch (err) {
    console.error("[jdy-customer-sync]", err);
    return res.status(500).json({ error: err.message });
  }
}
