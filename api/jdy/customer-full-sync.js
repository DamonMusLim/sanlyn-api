/**
 * GET  /api/jdy/customer-full-sync          — 拉取全部JDY客户档案到SQL
 * GET  /api/jdy/customer-full-sync?code=XX  — 只拉指定客户
 *
 * 从 JDY 客户档案读取：品牌、地址、联系方式、发票信息等，写入 customers 表
 */
import { getPool, setCors } from "../db.js";

var JDY_TOKEN          = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
var JDY_APP_ID         = "689cb08a93c073210bfc772b";
var JDY_CUSTOMER_ENTRY = "68da2738987870a88c839d6e";  // 客户档案
var JDY_API            = "https://api.jiandaoyun.com/api/v5";

// ── JDY 客户档案字段 ──────────────────────────────
var W = {
  companyCode:    "_widget_1771622930859",  // 客户代号
  nameEN:         "_widget_1764392061245",  // 公司英文名
  nameCN:         "_widget_1764394732263",  // 公司中文名
  country:        "_widget_1770371120295",  // 国家
  contactName:    "_widget_1764392061248",  // 联系人
  contactPhone:   "_widget_1764392061252",  // 电话
  contactEmail:   "_widget_1764392061256",  // 邮箱
  currency:       "_widget_1770797914842",  // 交易币种
  paymentTerm:    "_widget_1771815411185",  // 付款条件
  brands:         "_widget_1775071325804",  // 品牌（多选/文本）
  groupId:        "_widget_1771622930865",  // 分组ID
  addressSubform: "_widget_1770371120291",  // 地址子表
  sub_country:    "_widget_1770371120295",
  sub_port:       "_widget_1771523439038",
  sub_addrShort:  "_widget_1771815411179",
  sub_addrFull:   "_widget_1770371120312",
  sub_consignee:  "_widget_1770371120343",
  // 发票信息
  inv_nameEN:     "_widget_1764392061279",  // Invoice公司名
  inv_addressEN:  "_widget_1764394732272",  // Invoice地址
  inv_addressCN:  "_widget_1764394732273",  // Invoice地址CN
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
    if (!text || !text.trim()) break;
    var json = JSON.parse(text);
    if (!resp.ok || json.code) {
      throw new Error("JDY error: " + (json.msg || json.code || resp.status));
    }
    var records = json.data || [];
    if (records.length === 0) break;
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

  try {
    var code = req.query.code || "";
    var filter = code ? {
      rel: "and",
      cond: [{ field: W.companyCode, type: "text", method: "eq", value: [code] }]
    } : null;

    var debug = req.query.debug === "1";
    // 不限制 fields，拉全部字段，方便发现品牌等字段的 widget ID
    var records = await fetchJDY(filter, null);

    // debug 模式返回原始 JDY 数据（只取第一条）
    if (debug) {
      return res.status(200).json({
        success: true,
        total: records.length,
        sample: records.length > 0 ? records[0] : null,
        allKeys: records.length > 0 ? Object.keys(records[0]) : [],
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
        var nameCN       = get(rec, W.nameCN) || "";
        var country      = get(rec, W.country) || "";
        var contactName  = get(rec, W.contactName) || "";
        var contactPhone = get(rec, W.contactPhone) || "";
        var contactEmail = get(rec, W.contactEmail) || "";
        var currency     = get(rec, W.currency) || "USD";
        var paymentTerm  = get(rec, W.paymentTerm) || "";
        var groupId      = get(rec, W.groupId) || "";
        var brandsRaw    = get(rec, W.brands);
        var brands       = parseBrands(brandsRaw);

        var subformData  = get(rec, W.addressSubform);
        var addresses    = parseAddresses(Array.isArray(subformData) ? subformData : []);

        var invNameEN    = get(rec, W.inv_nameEN) || "";
        var invAddrEN    = get(rec, W.inv_addressEN) || "";
        var invAddrCN    = get(rec, W.inv_addressCN) || "";
        var invoice      = { nameEN: invNameEN, addressEN: invAddrEN, addressCN: invAddrCN };

        var sql = `
          INSERT INTO customers (company_code, name_en, name_cn, brands, addresses,
            contact_name, contact_phone, contact_email, country, currency,
            payment_term, portal_role, group_id, invoice, raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'customer',$12,$13,$14)
          ON CONFLICT (company_code) DO UPDATE SET
            name_en       = COALESCE(NULLIF($2,''), customers.name_en),
            name_cn       = COALESCE(NULLIF($3,''), customers.name_cn),
            brands        = CASE WHEN $4::jsonb = '[]'::jsonb THEN customers.brands ELSE $4::jsonb END,
            addresses     = CASE WHEN $5::jsonb = '[]'::jsonb THEN customers.addresses ELSE $5::jsonb END,
            contact_name  = COALESCE(NULLIF($6,''), customers.contact_name),
            contact_phone = COALESCE(NULLIF($7,''), customers.contact_phone),
            contact_email = COALESCE(NULLIF($8,''), customers.contact_email),
            country       = COALESCE(NULLIF($9,''), customers.country),
            currency      = COALESCE(NULLIF($10,''), customers.currency),
            payment_term  = COALESCE(NULLIF($11,''), customers.payment_term),
            group_id      = COALESCE(NULLIF($12,''), customers.group_id),
            invoice       = $13::jsonb,
            raw           = customers.raw || $14::jsonb,
            updated_at    = NOW()
          RETURNING company_code, name_en, brands
        `;
        var params = [
          companyCode, nameEN, nameCN,
          JSON.stringify(brands), JSON.stringify(addresses),
          contactName, contactPhone, contactEmail,
          country, currency, paymentTerm, groupId,
          JSON.stringify(invoice),
          JSON.stringify({ jdyId: rec._id, lastSync: new Date().toISOString(), brandsRaw: brandsRaw }),
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
