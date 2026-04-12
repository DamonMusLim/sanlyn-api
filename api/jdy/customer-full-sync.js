/**
 * GET  /api/jdy/customer-full-sync          — 拉取全部JDY客户档案到SQL
 * GET  /api/jdy/customer-full-sync?code=XX  — 只拉指定客户
 *
 * 从 JDY 客户档案读取：品牌、地址、联系方式、发票信息等，写入 customers 表
 */
import { getPool, setCors } from "../db.js";

var JDY_TOKEN          = "jgAipmndimpj0endT0wStd6gpspAQpAd";
var JDY_APP_ID         = "689cb08a93c073210bfc772b";
var JDY_CUSTOMER_ENTRY = "68da2738987870a88c839d6e";  // 客户档案
var JDY_API            = "https://api.jiandaoyun.com/api/v5";

// ── JDY 客户档案字段（来自 JDY 表单数据结构）──────────
var W = {
  companyCode:    "_widget_1771622930859",  // 客户代号 (text)
  nameEN:         "_widget_1762568848071",  // 客户公司（英文）(text)
  selectCompany:  "_widget_1766650731323",  // 选择公司 (linkdata)
  brands:         "_widget_1759129256811",  // Brand (combocheck 多选!)
  relatedFactory: "_widget_1774282924487",  // 关联工厂 (combocheck)
  country:        "_widget_1768475611585",  // 国家 (text)
  selectCountry:  "_widget_1768475715971",  // 选择国家 (lookup)
  currency:       "_widget_1770797795019",  // 交易币种 (combo)
  paymentMethod:  "_widget_1772321952179",  // 付款方式 (radiogroup)
  customerLevel:  "_widget_1766834853664",  // 客户等级 (radiogroup)
  defaultPayment: "_widget_1766834853668",  // 默认付款策略 (radiogroup)
  tradeTerms:     "_widget_1766834853675",  // 允许贸易条款 (radiogroup)
  blTypePref:     "_widget_1771622930875",  // 提单类型偏好 (radiogroup)
  pricingTier:    "_widget_1772534679214",  // pricingTier (combo)
  featureFlags:   "_widget_1772534679217",  // featureFlags (textarea)
  // 加价策略
  markupMode:     "_widget_1766840643018",  // 加价模式 (radiogroup)
  markupValue:    "_widget_1766840643036",  // 加价值 (number)
  markupCurrency: "_widget_1766840643023",  // 加价币种 (radiogroup)
  logisticsMarkup:"_widget_1766840643034",  // 物流加价模式 (radiogroup)
  logisticsMarkupPct:  "_widget_1766913411037",  // 加价百分比 (number)
  logisticsMarkupCtn:  "_widget_1766913411038",  // 加价固定金额/柜 (number)
  logisticsMarkupShip: "_widget_1766913411039",  // 加价固定金额/票 (number)
  logisticsMarkupCur:  "_widget_1766840643037",  // 物流加价币种 (radiogroup)
  weHandleOcean:  "_widget_1766840643039",  // 是否我方代办海运 (radiogroup)
  productMarkupPct: "_widget_1771622930877", // 销售产品加价百分比 (radiogroup)
  // 地址子表
  addressSubform: "_widget_1770371120291",  // 地址明细 (subform)
  sub_country:    "_widget_1770371120295",
  sub_port:       "_widget_1771523439038",
  sub_addrShort:  "_widget_1771815411179",
  sub_addrFull:   "_widget_1770371120312",
  sub_consignee:  "_widget_1770371120343",
  // 付款子表
  paySubform:     "_widget_1766891785476",  // 付款子表单 (subform)
  pay_type:       "_widget_1766891785478",  // 类型 (combo)
  pay_pct:        "_widget_1766892526096",  // 百分比 (number)
  pay_currency:   "_widget_1766891785481",  // 币种 (combo)
  pay_company:    "_widget_1766891785484",  // 客户公司 (text)
};

function get(row, w) {
  var v = row[w];
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "value" in v) {
    var val = v.value;
    if (val === null || val === undefined) return "";
    return val;
  }
  return v;
}

function parseBrands(raw) {
  var v = raw;
  if (!v) return [];
  // 可能是数组（多选字段）
  if (Array.isArray(v)) return v.map(function(b) { return (typeof b === "string" ? b : b.value || b.name || "").trim(); }).filter(Boolean);
  // 可能是逗号分隔的字符串
  if (typeof v === "string") return v.split(/[,，、]/).map(function(s) { return s.trim(); }).filter(Boolean);
  return [];
}

function parseAddresses(subformData) {
  if (!Array.isArray(subformData)) return [];
  return subformData.map(function(row) {
    return {
      country:     get(row, W.sub_country) || "",
      port:        get(row, W.sub_port) || "",
      addrShort:   get(row, W.sub_addrShort) || "",
      addrFull:    get(row, W.sub_addrFull) || "",
      consignee:   get(row, W.sub_consignee) || "",
    };
  }).filter(function(a) { return a.consignee || a.addrFull; });
}

async function fetchJDY(filter, fields) {
  var allData = [];
  var dataId = "";
  var hasMore = true;

  while (hasMore) {
    var body = { limit: 100 };
    if (fields) body.fields = fields;
    if (filter) body.filter = filter;
    if (dataId) body.data_id = dataId;

    var resp = await fetch(JDY_API + "/app/" + JDY_APP_ID + "/entry/" + JDY_CUSTOMER_ENTRY + "/data/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + JDY_TOKEN,
      },
      body: JSON.stringify(body),
    });
    var text = await resp.text();
    if (!text || !text.trim()) { hasMore = false; break; }
    var json;
    try { json = JSON.parse(text); } catch(e) { throw new Error("JDY parse error: " + text.slice(0, 200)); }
    if (!resp.ok || json.code) {
      throw new Error("JDY error: " + JSON.stringify({ code: json.code, msg: json.msg, status: resp.status }));
    }
    var records = json.data || [];
    if (records.length === 0) { hasMore = false; break; }
    allData = allData.concat(records);
    dataId = records[records.length - 1]._id;
    if (records.length < 100) hasMore = false;
  }
  return allData;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // 诊断模式：直接返回 JDY 原始响应
  if (req.query.raw === "1") {
    try {
      var testBody = { limit: 3, fields: [W.companyCode, W.nameEN, W.brands] };
      var testResp = await fetch(JDY_API + "/app/" + JDY_APP_ID + "/entry/" + JDY_CUSTOMER_ENTRY + "/data/list", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + JDY_TOKEN },
        body: JSON.stringify(testBody),
      });
      var rawText = await testResp.text();
      return res.status(200).json({
        diagnostic: true,
        httpStatus: testResp.status,
        requestBody: testBody,
        entryId: JDY_CUSTOMER_ENTRY,
        appId: JDY_APP_ID,
        tokenPrefix: JDY_TOKEN.slice(0, 6) + "...",
        rawResponse: rawText.slice(0, 2000),
      });
    } catch (e) {
      return res.status(200).json({ diagnostic: true, error: e.message });
    }
  }

  try {
    var code = req.query.code || "";
    var filter = code ? {
      rel: "and",
      cond: [{ field: W.companyCode, type: "text", method: "eq", value: [code] }]
    } : null;

    var debug = req.query.debug === "1";
    // 必须传 fields，否则 JDY 可能返回空
    var coreFields = [W.companyCode, W.nameEN, W.brands, W.country, W.currency,
      W.paymentMethod, W.customerLevel, W.tradeTerms, W.addressSubform,
      W.relatedFactory, W.pricingTier, W.markupMode, W.markupValue,
      W.logisticsMarkup, W.weHandleOcean, W.blTypePref, W.defaultPayment,
      W.paySubform, W.selectCompany, W.featureFlags, W.productMarkupPct,
      W.logisticsMarkupPct, W.logisticsMarkupCtn, W.logisticsMarkupShip,
      W.markupCurrency, W.logisticsMarkupCur, W.selectCountry];
    var records = await fetchJDY(filter, coreFields);

    // debug 模式返回原始 JDY 数据（只取前两条）
    if (debug) {
      return res.status(200).json({
        success: true,
        total: records.length,
        sample: records.length > 0 ? records.slice(0, 2) : null,
        allKeys: records.length > 0 ? Object.keys(records[0]) : [],
        fieldsRequested: coreFields.length,
      });
    }

    var pool = getPool();
    // ensure table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        company_code VARCHAR(64) UNIQUE,
        name_en VARCHAR(256) DEFAULT '',
        name_cn VARCHAR(256) DEFAULT '',
        brands JSONB DEFAULT '[]'::jsonb,
        addresses JSONB DEFAULT '[]'::jsonb,
        contact_name VARCHAR(128) DEFAULT '',
        contact_phone VARCHAR(64) DEFAULT '',
        contact_email VARCHAR(128) DEFAULT '',
        country VARCHAR(64) DEFAULT '',
        currency VARCHAR(8) DEFAULT 'USD',
        payment_term VARCHAR(128) DEFAULT '',
        portal_role VARCHAR(32) DEFAULT 'customer',
        group_id VARCHAR(64) DEFAULT '',
        invoice JSONB DEFAULT '{}'::jsonb,
        raw JSONB DEFAULT '{}'::jsonb,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    var synced = [];
    var errors = [];

    for (var rec of records) {
      try {
        var companyCode = get(rec, W.companyCode);
        if (!companyCode) continue;

        var nameEN       = get(rec, W.nameEN) || "";
        var country      = get(rec, W.country) || "";
        var currency     = get(rec, W.currency) || "USD";
        var paymentMethod = get(rec, W.paymentMethod) || "";
        var brandsRaw    = get(rec, W.brands);
        var brands       = parseBrands(brandsRaw);

        var subformData  = get(rec, W.addressSubform);
        var addresses    = parseAddresses(Array.isArray(subformData) ? subformData : []);

        // 付款子表
        var paySubRaw    = get(rec, W.paySubform);
        var payTerms     = Array.isArray(paySubRaw) ? paySubRaw.map(function(r) {
          return {
            type: get(r, W.pay_type) || "",
            pct: get(r, W.pay_pct) || 0,
            currency: get(r, W.pay_currency) || "",
            company: get(r, W.pay_company) || "",
          };
        }) : [];

        // 所有策略/配置字段存到 raw
        var rawData = {
          jdyId:          rec._id,
          lastSync:       new Date().toISOString(),
          brandsRaw:      brandsRaw,
          customerLevel:  get(rec, W.customerLevel) || "",
          defaultPayment: get(rec, W.defaultPayment) || "",
          tradeTerms:     get(rec, W.tradeTerms) || "",
          blTypePref:     get(rec, W.blTypePref) || "",
          pricingTier:    get(rec, W.pricingTier) || "",
          featureFlags:   get(rec, W.featureFlags) || "",
          markupMode:     get(rec, W.markupMode) || "",
          markupValue:    get(rec, W.markupValue) || 0,
          markupCurrency: get(rec, W.markupCurrency) || "",
          logisticsMarkup:    get(rec, W.logisticsMarkup) || "",
          logisticsMarkupPct: get(rec, W.logisticsMarkupPct) || 0,
          logisticsMarkupCtn: get(rec, W.logisticsMarkupCtn) || 0,
          logisticsMarkupShip:get(rec, W.logisticsMarkupShip) || 0,
          logisticsMarkupCur: get(rec, W.logisticsMarkupCur) || "",
          weHandleOcean:  get(rec, W.weHandleOcean) || "",
          productMarkupPct: get(rec, W.productMarkupPct) || "",
          relatedFactory: parseBrands(get(rec, W.relatedFactory)),
          payTerms:       payTerms,
          portalRole:     "customer",
        };

        var sql = `
          INSERT INTO customers (company_code, name_en, name_cn, brands, addresses,
            contact_name, contact_phone, contact_email, country, currency,
            payment_term, portal_role, group_id, invoice, raw)
          VALUES ($1,$2,'',$3,$4,'','','',$5,$6,$7,'customer','',$8,$9)
          ON CONFLICT (company_code) DO UPDATE SET
            name_en       = COALESCE(NULLIF($2,''), customers.name_en),
            brands        = CASE WHEN $3::jsonb = '[]'::jsonb THEN customers.brands ELSE $3::jsonb END,
            addresses     = CASE WHEN $4::jsonb = '[]'::jsonb THEN customers.addresses ELSE $4::jsonb END,
            country       = COALESCE(NULLIF($5,''), customers.country),
            currency      = COALESCE(NULLIF($6,''), customers.currency),
            payment_term  = COALESCE(NULLIF($7,''), customers.payment_term),
            invoice       = CASE WHEN $8::jsonb = '{}'::jsonb THEN customers.invoice ELSE $8::jsonb END,
            raw           = customers.raw || $9::jsonb,
            updated_at    = NOW()
          RETURNING company_code, name_en, brands
        `;
        var params = [
          companyCode, nameEN,
          JSON.stringify(brands), JSON.stringify(addresses),
          country, currency, paymentMethod,
          JSON.stringify({}),
          JSON.stringify(rawData),
        ];
        var r = await pool.query(sql, params);
        synced.push(r.rows[0]);
      } catch (e) {
        errors.push({ code: get(rec, W.companyCode), error: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      total: records.length,
      synced: synced.length,
      data: synced,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[customer-full-sync]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
