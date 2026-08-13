// doc-data.js — database loading functions for document rendering

export function scrubCustomerFacingHtml(html) {
  if (typeof html !== "string" || !html) return html;
  // 1. CN-000XX codes (Sanlyn internal company codes) → blank
  html = html.replace(/\bCN-?\d{4,6}\b(?!-\d)/g, "");
  // 2. Stray "company_code: ..." or "companyCode: ..." token tails in JSON-ish output
  html = html.replace(/&quot;(?:company_code|companyCode|issuing_company_code|factory_code|middleman_code|middleman_markup_total|middleman_markup_pct|profit|margin_amount|margin_pct|pricing_snapshot|vault|tax_rebate_amount)&quot;\s*:\s*&quot;[^&]*&quot;,?/g, "");
  html = html.replace(/"(?:company_code|companyCode|issuing_company_code|factory_code|middleman_code|middleman_markup_total|middleman_markup_pct|profit|margin_amount|margin_pct|pricing_snapshot|vault|tax_rebate_amount)"\s*:\s*"[^"]*",?/g, "");
  // 3. Collapse double-spaces produced by the strips
  html = html.replace(/[ \t]{2,}/g, " ");
  return html;
}

// ── Seller config: loaded from seller_profiles table (no hardcoding) ──────────
// To add a new issuing company, INSERT a row into seller_profiles.
// Shape returned: { nameEN, nameCN, address, tel, email, bank:{...}, terms:{sc:[],iv:[]} }
//
// 2026-05-19 (damon 上下游规矩):
//   货物类 (PI/SC/IV/PL)  → 客户下单时手选出单方 (raw.issuingCompany)
//   海运类 (SO/SQ/DN)     → 自动绑 OCEANBABY (上海洋宝宝)
//     预留接口: raw.shippingVendor / spraw.shipping_vendor 未来可手选
//     现在写死 'OCEANBABY' 默认，但不 hardcode 在模板里，全过 seller_profiles
function firstCompanyText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(firstCompanyText).filter(Boolean).join("\n");
  if (typeof v === "object") return v.en || v.full_en || v.full || v.cn || v.address || v.text || v.value || Object.keys(v).map(function(k) { return firstCompanyText(v[k]); }).filter(Boolean)[0] || "";
  return String(v || "");
}

function cfgFromCompany(c) {
  return {
    nameEN: c.name_en || "", nameCN: c.name_cn || "",
    address: firstCompanyText(c.address_en) || firstCompanyText(c.address), tel: c.contact_phone || "", email: c.einvoice_email || "",
    taxNo: c.tax_id || c.registration_no || "",
    termsPO: [],
    bank: {
      beneficiary: c.name_en || c.name_cn || "",
      bankName: "", bankNameCN: "", swift: "",
      bankAddr: "", usdAccount: "", rmbAccount: "",
    },
    terms: { sc: [], iv: [] },
    seal_url: "",
  };
}

function cfgFromSeller(s) {
  return {
    nameEN: s.name_en||"", nameCN: s.name_cn||"",
    address: s.address||"", tel: s.tel||"", email: s.email||"",
    taxNo: s.tax_no||"",   // 卖方统一社会信用代码（采购合同买方税号）
    termsPO: Array.isArray(s.terms_po) ? s.terms_po : (s.terms_po||[]),
    bank: {
      beneficiary: s.bank_beneficiary||s.name_en||"",
      bankName: s.bank_name||"", bankNameCN: s.bank_name_cn||"",
      swift: s.bank_swift||"",
      bankAddr: s.bank_addr||"", usdAccount: s.usd_account||"",
      rmbAccount: s.rmb_account||"",
    },
    terms: {
      sc: Array.isArray(s.terms_sc) ? s.terms_sc : (s.terms_sc||[]),
      iv: Array.isArray(s.terms_iv) ? s.terms_iv : (s.terms_iv||[]),
    },
    seal_url: s.seal_url||"",  // 卖方公章图 URL（sigBlock 自动盖章用）
  };
}

export async function loadSellerCfg(pool, raw, qco, opts) {
  opts = opts || {};
  raw = raw || {};
  var issuingId = parseInt(raw.issuing_company_id || raw.issuingCompanyId || 0, 10);
  var companyCfg = null, companyCode = "";
  var code = qco || "";
  if(!code){ var h=(raw.issuingCompanyEN||raw.issuingCompany||"").toLowerCase(); if(h.includes("sanlyn"))code="sanlyn"; }
  // 海运类强制 OCEANBABY (除非 raw.shippingVendor 显式给出)
  if(opts.shipping){
    code = raw.shipping_vendor || raw.shippingVendor || code || "yangbaobao";
  }
  try {
    if(issuingId > 0 && !opts.shipping){
      var cr = await pool.query("SELECT id, code, name_cn, name_en, address, address_en, contact_phone, einvoice_email, registration_no, tax_id FROM companies WHERE id=$1 LIMIT 1", [issuingId]);
      if(cr.rows.length){
        companyCfg = cfgFromCompany(cr.rows[0]);
        companyCode = cr.rows[0].code || "";
        if(!code && companyCode) code = companyCode;
      }
    }
    var q = code
      ? "SELECT * FROM seller_profiles WHERE code=$1 LIMIT 1"
      : "SELECT * FROM seller_profiles WHERE is_default=TRUE LIMIT 1";
    var p = code ? [code] : [];
    var r = await pool.query(q, p);
    // ⚠️2026-07-24 护栏：companies.code 与 seller_profiles.code 不是一套编码——
    //   companies id=37 的 code 是 'BABI'，而真正在用的 profile 是 'petbaby'(128/132 单，is_default，银行齐全)；
    //   'BABI' 那条 profile 银行字段全空。若拿 company code 撞到一条**没有银行**的 profile，
    //   就会把 IV/SC 的收款信息印成空白 → 回退到 is_default 那条（银行是付款命脉，宁可用默认也不能空）。
    var _hasBank = row => !!(row && (row.bank_name || row.usd_account || row.rmb_account));
    if (r.rows.length && companyCode && code === companyCode && !_hasBank(r.rows[0])) {
      var dflt = await pool.query("SELECT * FROM seller_profiles WHERE is_default=TRUE LIMIT 1");
      if (dflt.rows.length && _hasBank(dflt.rows[0])) r = dflt;
    }
    if(!r.rows.length && companyCfg) return companyCfg;
    if(!r.rows.length){ // fallback: first row
      var fb = await pool.query("SELECT * FROM seller_profiles ORDER BY id LIMIT 1");
      if(!fb.rows.length) throw new Error("No seller profile found");
      r = fb;
    }
    var s = r.rows[0];
    var sellerCfg = cfgFromSeller(s);
    return companyCfg ? Object.assign({}, sellerCfg, {
      nameEN: companyCfg.nameEN,
      nameCN: companyCfg.nameCN,
      address: companyCfg.address,
      tel: companyCfg.tel,
      email: companyCfg.email,
      taxNo: companyCfg.taxNo,
      bank: Object.assign({}, sellerCfg.bank, {
        beneficiary: companyCfg.nameEN || companyCfg.nameCN || sellerCfg.bank.beneficiary,
      }),
    }) : sellerCfg;
  } catch(e) {
    return { nameEN:"", nameCN:"", address:"", tel:"", email:"",
      bank:{beneficiary:"",bankName:"",swift:"",bankAddr:"",usdAccount:""},
      terms:{sc:[],iv:[]}, _err: e.message };
  }
}

export async function enrichProdsFromMaster(pool, prods) {
  if (!prods || !prods.length) return prods;
  var skus = prods.map(function(p) { return p && p.sku; }).filter(Boolean);
  // 2026-05-18: fallback to barcode lookup when SKU not on raw product.
  // Many legacy raw.products carry only barcode (no sku), preventing bl_description fill.
  var barcodes = prods.map(function(p) { return p && (p.barcode || p.code); }).filter(Boolean);
  if (!skus.length && !barcodes.length) return prods; // nothing to JOIN

  var masterMap = {};
  var bcMap = {};
  try {
    if (skus.length) {
      var r = await pool.query(
        "SELECT sku, product_name, hs_code, declaration_name, declaration_elements," +
        " bl_description, net_weight, gross_weight, cbm, carton_qty AS inner_qty, NULL AS inner_unit, unit," +
        " barcode, factory_name" +
        " FROM products WHERE sku = ANY($1::text[]) AND active = true",
        [skus]
      );
      r.rows.forEach(function(row) { masterMap[row.sku] = row; if (row.barcode) bcMap[row.barcode] = row; });
    }
    if (barcodes.length) {
      // 2026-05-18: legacy raw.products often store SKU in the `barcode` field
      // (TNC-06, CP1894, etc — not real EAN barcodes). Match on barcode OR sku
      // so either column hits work.
      var r2 = await pool.query(
        "SELECT sku, hs_code, declaration_name, declaration_elements," +
        " bl_description, net_weight, gross_weight, cbm, carton_qty AS inner_qty, NULL AS inner_unit, unit," +
        " barcode, factory_name" +
        " FROM products WHERE (barcode = ANY($1::text[]) OR sku = ANY($1::text[])) AND active = true",
        [barcodes]
      );
      r2.rows.forEach(function(row) {
        if (row.barcode) bcMap[row.barcode] = row;
        if (row.sku) bcMap[row.sku] = row; // also key by sku so 'barcode'-named SKUs resolve
        if (row.sku && !masterMap[row.sku]) masterMap[row.sku] = row;
      });
    }
  } catch (e) {
    console.warn("[documents] enrichProdsFromMaster: DB error —", e.message, "— using raw products only");
    return prods; // fail-open: DB unreachable, render with existing data
  }

  // _f: fill from master only when prod value is undefined / null / ""
  // Never fills when prod value is 0, false, or any other defined value.
  function _f(prodVal, masterVal) {
    return (prodVal === undefined || prodVal === null || prodVal === "") && masterVal != null
      ? masterVal
      : prodVal;
  }

  return prods.map(function(p) {
    if (!p) return p;
    // Try SKU first, then barcode fallback (2026-05-18)
    var m = (p.sku && masterMap[p.sku]) || ((p.barcode || p.code) && bcMap[p.barcode || p.code]);
    if (!m) {
      return p; // unknown — render with raw values
    }
    // Build enriched copy. Pricing / cost / margin fields are NOT in this list.
    return Object.assign({}, p, {
      netWeight:           _f(p.netWeight,           m.net_weight),
      grossWeight:         _f(p.grossWeight,         m.gross_weight),
      cbm:                 _f(p.cbm,                 m.cbm),
      blDescription:       _f(p.blDescription   || p.bl_description,   m.bl_description),
      declarationName:     _f(p.declarationName  || p.declaration_name, m.declaration_name),
      hsCode:              _f(p.hsCode || p.hs_code || p.hscode,        m.hs_code),
      declarationElements: _f(p.declarationElements,                    m.declaration_elements),
      inner_qty:           _f(p.inner_qty,                              m.inner_qty),
      inner_unit:          _f(p.inner_unit,                             m.inner_unit),
      barcode:             _f(p.barcode || p.code,                      m.barcode),
      factory_name:        _f(p.factory_name,                           m.factory_name),
      productName:         _f(p.productName || p.name,                  m.product_name),
      unit:                _f(p.unit, m.unit),
      productNameEN:       m.product_name || "",  // always master EN name; used by PI/en docs
    });
  });
}

// ── loadDocColConfig ─────────────────────────────────────────────────────────
// Loads col order/label/visibility from doc_column_config.
// Falls back to [] on error so hardcoded defaults still work.
export async function loadDocColConfig(pool, docType) {
  try {
    var r = await pool.query(
      "SELECT col_key, label, col_width, col_align, sort_order FROM doc_column_config " +
      "WHERE doc_type=$1 AND visible=true ORDER BY sort_order ASC",
      [docType]
    );
    return r.rows;
  } catch(e) {
    console.warn("[documents] loadDocColConfig(" + docType + "):", e.message);
    return [];
  }
}

export function buildColsFromConfig(dbCols, fnMap, fallback) {
  if (!dbCols || !dbCols.length) return fallback;
  return dbCols.map(function(row) {
    var def = fnMap[row.col_key] || {};
    return {
      k:   row.col_key,
      al:  row.col_align || def.defaultAlign || "",
      w:   row.col_width || def.defaultWidth || undefined,
      lbl: row.label,
      fn:  def.fn || undefined,
    };
  });
}
