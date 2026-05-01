// customs-draft.js
// 报关底稿生成 — 从订单主表自动提取所有字段，颜色标注自动/待核查/报关行填
//
// GET  /api/db/customs-draft?order_no=37-WP-59
// POST /api/db/customs-draft  { order_no: "37-WP-59" }
//
// Returns:
// {
//   success: true,
//   order: { order_no, contract_no, ... },
//   fields: { [fieldId]: { value, status, note?, source? } },
//   items: [{ no, hs_code, declaration_name, declaration_elements, ... }],
//   gaps: [{ field, level, msg }],
//   summary: { auto_count, warn_count, broker_count, completeness }
// }

import { getPool, setCors } from "../db.js";

// ── 知识库：港口 → 出境关别 + 离境口岸 ──────────────────────────────────────
const PORT_LOOKUP = {
  QINGDAO:   { exit_customs: "(4218) 青开发区",  exit_port: "(370201) 黄岛" },
  QINGDAO_DA:{ exit_customs: "(4202) 青岛大港",  exit_port: "(370201) 黄岛" },
  XIAMEN:    { exit_customs: "(4601) 厦门海关",  exit_port: "(350100) 厦门" },
  SHANGHAI:  { exit_customs: "(2244) 洋山港",    exit_port: "(310100) 上海" },
  NINGBO:    { exit_customs: "(2246) 宁波海关",  exit_port: "(330200) 宁波" },
  TIANJIN:   { exit_customs: "(0201) 天津港",    exit_port: "(120100) 天津" },
  GUANGZHOU: { exit_customs: "(5157) 广州黄埔",  exit_port: "(440100) 广州" },
  SHENZHEN:  { exit_customs: "(5158) 深圳海关",  exit_port: "(440300) 深圳" },
};

// ── 知识库：工厂城市 → 境内货源地海关代码 ───────────────────────────────────
const ORIGIN_LOOKUP = {
  "烟台":   "(37069) 烟台其他",
  "连云港": "(32079) 连云港其他",
  "南平":   "(35019) 南平其他",
  "厦门":   "(35010) 厦门",
  "青岛":   "(37020) 青岛",
  "上海":   "(31010) 上海",
  "宁波":   "(33020) 宁波",
};

// ── 知识库：目的国代码映射 ───────────────────────────────────────────────────
const COUNTRY_CODE = {
  Malaysia:    { code: "MYS", name_cn: "马来西亚", port_code: "MYS105", port_name: "巴生港（马来西亚）" },
  Philippines: { code: "PHL", name_cn: "菲律宾",   port_code: "PHL114", port_name: "马尼拉（菲律宾）" },
  Singapore:   { code: "SGP", name_cn: "新加坡",   port_code: "SGP001", port_name: "新加坡" },
  USA:         { code: "USA", name_cn: "美国",      port_code: "USA999", port_name: "目的港" },
  "United States": { code: "USA", name_cn: "美国",  port_code: "USA999", port_name: "目的港" },
  Thailand:    { code: "THA", name_cn: "泰国",      port_code: "THA001", port_name: "曼谷" },
  Vietnam:     { code: "VNM", name_cn: "越南",      port_code: "VNM001", port_name: "胡志明" },
  Indonesia:   { code: "IDN", name_cn: "印度尼西亚",port_code: "IDN001", port_name: "雅加达" },
};

// ── 字段状态类型 ─────────────────────────────────────────────────────────────
// auto   = 系统自动填写（绿）
// warn   = 需人工核查（黄）
// miss   = 系统有数据但不完整（橙）
// broker = 报关行填写（红框）

function field(value, status = "auto", opts = {}) {
  return { value, status, ...opts };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "GET or POST only" });

  const orderNo =
    req.query.order_no ||
    req.query.contract_no ||
    req.body?.order_no ||
    req.body?.contract_no ||
    "";

  if (!orderNo.trim())
    return res.status(400).json({ success: false, error: "order_no is required" });

  const pool = getPool();

  try {
    // ── 1. 拉订单主表 ────────────────────────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT
         id, order_no, contract_no, company_code,
         customer, consignee, country, destination_port, pol,
         issuing_company, issuing_company_en,
         factory, factory_address, factory_city,
         total_qty, gross_weight, net_weight, total_cbm,
         total_amount, currency, declare_amount, exchange_rate,
         trade_terms, bl_no, marks, products, raw
       FROM orders
       WHERE order_no = $1 OR contract_no = $1
       LIMIT 1`,
      [orderNo.trim()]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: `Order not found: ${orderNo}` });

    const o = rows[0];
    const raw = o.raw || {};
    const products = Array.isArray(o.products) ? o.products
                   : Array.isArray(raw.products) ? raw.products : [];

    // ── 2. 港口代码解析 ──────────────────────────────────────────────────────
    const polKey = (o.pol || raw.pol || "").toUpperCase().replace(/[\s-]/g, "_");
    const portInfo = PORT_LOOKUP[polKey] || PORT_LOOKUP[polKey.split("_")[0]] || {};

    // ── 3. 目的国解析 ────────────────────────────────────────────────────────
    const countryRaw = o.country || raw.country || "";
    const countryInfo = COUNTRY_CODE[countryRaw] || {};
    const destCode  = countryInfo.code    ? `(${countryInfo.code}) ${countryInfo.name_cn}` : countryRaw;
    const portCode  = countryInfo.port_code
      ? `(${countryInfo.port_code}) ${countryInfo.port_name}`
      : (o.destination_port || raw.destination || "");

    // ── 4. 工厂城市 → 货源地 ────────────────────────────────────────────────
    const factoryCity = o.factory_city || raw.factoryCity || "";
    const originCode  = factoryCity
      ? (ORIGIN_LOOKUP[factoryCity] || null)
      : null;

    // ── 5. 船名航次 ──────────────────────────────────────────────────────────
    const vessel = raw.vessel || "";
    const voyage = raw.voyage || "";
    const vesselVoyage = vessel && voyage ? `${vessel} / ${voyage}` : vessel || voyage || null;

    // ── 6. 提单号 ────────────────────────────────────────────────────────────
    const blNo = raw.blNo || o.bl_no || null;

    // ── 7. 集装箱号 ──────────────────────────────────────────────────────────
    const containerNo = raw.containerNo || null;

    // ── 8. 申报单价计算 ──────────────────────────────────────────────────────
    const totalAmt = parseFloat(o.total_amount || 0);
    const nwKg     = parseFloat(o.net_weight   || 0);
    const unitDeclPrice = nwKg > 0 ? parseFloat((totalAmt / nwKg).toFixed(4)) : null;

    // ── 9. SKU → 产品表 JOIN (HS码 + 申报要素) ──────────────────────────────
    const skus = [...new Set(products.map(p => p.sku).filter(Boolean))];
    let prodMap = {};
    if (skus.length) {
      const { rows: prods } = await pool.query(
        `SELECT sku, hs_code, declaration_name, declaration_elements,
                net_weight, gross_weight, factory_city
         FROM products WHERE sku = ANY($1)`,
        [skus]
      );
      for (const p of prods) prodMap[p.sku] = p;
    }

    // ── 10. 归并申报商品（按 hs_code + declaration_name 分组）────────────────
    const itemBuckets = {};
    for (const p of products) {
      const prod    = p.sku ? prodMap[p.sku] : null;
      const hsCode  = prod?.hs_code || p.hsCode || p.hs_code || null;
      const declName = prod?.declaration_name || p.declaration_name || p.category || p.name || "";
      const declElems = prod?.declaration_elements || p.declaration_elements || null;
      const qty     = parseFloat(p.qty || 0);
      const nwPer   = parseFloat(prod?.net_weight   || p.netWeight   || p.net_weight   || 0);
      const gwPer   = parseFloat(prod?.gross_weight  || p.grossWeight || p.gross_weight  || 0);
      const subtotal = parseFloat(p.subtotal || (qty * parseFloat(p.unitPrice || 0)));
      const fcity   = prod?.factory_city || factoryCity || "";

      const key = `${hsCode}||${declName}`;
      if (!itemBuckets[key]) {
        itemBuckets[key] = {
          hs_code: hsCode,
          declaration_name: declName,
          declaration_elements: declElems,
          qty_ctn: 0, nw_kg: 0, gw_kg: 0,
          total_price: 0,
          factory_city: fcity,
          hs_status: prod ? "auto" : (hsCode ? "warn" : "miss"),
        };
      }
      const b = itemBuckets[key];
      b.qty_ctn     += qty;
      b.nw_kg       += parseFloat((nwPer * qty).toFixed(2));
      b.gw_kg       += parseFloat((gwPer * qty).toFixed(2));
      b.total_price += subtotal;
    }

    const items = Object.values(itemBuckets).map((b, i) => {
      const unitPrice = b.nw_kg > 0 ? parseFloat((totalAmt / nwKg).toFixed(4)) : null;
      const originC   = b.factory_city ? (ORIGIN_LOOKUP[b.factory_city] || null) : originCode;
      return {
        no: i + 1,
        field_id: `item_${i + 1}`,
        hs_code:              b.hs_code,
        hs_status:            b.hs_status,
        declaration_name:     b.declaration_name,
        declaration_elements: b.declaration_elements,
        qty_kg:               parseFloat(b.nw_kg.toFixed(2)),
        qty_ctn:              Math.round(b.qty_ctn),
        unit_price:           unitPrice,
        total_price:          parseFloat(totalAmt.toFixed(2)),
        price_formula:        unitPrice ? `${totalAmt} ÷ ${nwKg} = ${unitPrice}` : null,
        currency:             "人民币",
        origin_country:       "中国 (CHN)",
        destination_country:  destCode,
        origin_code:          originC,
        origin_code_status:   originC ? "auto" : "miss",
        tax_mode:             "照章征税 (1)",
      };
    });

    // ── 11. 组装 fields ──────────────────────────────────────────────────────
    const fields = {
      // 报关行填
      pre_entry_no:    field(null, "broker", { label: "预录入编号", source: "报关行" }),
      customs_no:      field(null, "broker", { label: "海关编号",   source: "报关行" }),
      export_date:     field(null, "broker", { label: "出口日期",   source: "报关行" }),
      declaration_date:field(null, "broker", { label: "申报日期",   source: "报关行" }),
      record_no:       field(null, "broker", { label: "备案号",     source: "报关行" }),
      customs_record_no: field(null, "broker", { label: "电子底账编号", source: "报关行" }),
      declarant:       field(null, "broker", { label: "报关人员",   source: "报关行" }),
      declarant_cert:  field(null, "broker", { label: "报关人员证号", source: "报关行" }),
      filing_unit:     field(null, "broker", { label: "申报单位",   source: "报关行" }),

      // 自动填
      issuing_company: field(
        o.issuing_company || null, "auto",
        { label: "境内发货人", code: "91350206MA34RW3852", source: "orders.issuing_company" }
      ),
      manufacturer:    field(
        o.issuing_company || null, "auto",
        { label: "生产销售单位", code: "91350206MA34RW3852", source: "orders.issuing_company" }
      ),
      exit_customs:    field(
        portInfo.exit_customs || null,
        portInfo.exit_customs ? "auto" : "miss",
        { label: "出境关别", source: `lookup:${polKey}` }
      ),
      consignee:       field(
        o.customer || raw.companyNameEN || null, "auto",
        { label: "境外收货人", source: "orders.customer" }
      ),
      transport_mode:  field("(2) 水路运输", "auto", { label: "运输方式" }),
      vessel_voyage:   field(
        vesselVoyage, vesselVoyage ? "auto" : "miss",
        { label: "运输工具名称及航次号", source: "orders.raw.vessel+voyage" }
      ),
      bl_no:           field(
        blNo, blNo ? "warn" : "miss",
        { label: "提运单号", source: "orders.raw.blNo", note: blNo ? "请核查末位字母是否完整" : "提单未录入" }
      ),
      supervision_mode: field("(0110) 一般贸易", "auto", { label: "监管方式" }),
      tax_mode:         field("(101) 一般征税",   "auto", { label: "征免性质" }),
      license_no:       field(null, "broker",     { label: "许可证号" }),
      contract_no:      field(
        raw.customerPO || o.contract_no || null, "auto",
        { label: "合同协议号", source: "orders.raw.customerPO" }
      ),
      trade_country:    field(destCode || null, destCode ? "auto" : "miss", { label: "贸易国（地区）" }),
      destination_country: field(destCode || null, destCode ? "auto" : "miss", { label: "运抵国（地区）" }),
      destination_port: field(portCode || null, portCode ? "auto" : "miss", { label: "指运港（地区）", source: "orders.destination_port" }),
      exit_port:        field(
        portInfo.exit_port || null,
        portInfo.exit_port ? "auto" : "miss",
        { label: "离境口岸", source: `lookup:${polKey}` }
      ),
      package_type:     field("(22/92) 纸制或纤维板制盒/箱/再生木托", "auto", { label: "包装种类" }),
      qty_ctn:          field(o.total_qty  || null, o.total_qty  ? "auto" : "miss", { label: "件数" }),
      gross_weight:     field(o.gross_weight || null, o.gross_weight ? "auto" : "miss", { label: "毛重（千克）" }),
      net_weight:       field(o.net_weight   || null, o.net_weight   ? "auto" : "miss", { label: "净重（千克）" }),
      trade_terms:      field(
        o.trade_terms || "FOB",
        o.trade_terms ? "auto" : "warn",
        { label: "成交方式", note: o.trade_terms ? null : "orders.trade_terms 为空，默认 FOB，请确认" }
      ),
      container_nos:    field(
        containerNo, containerNo ? "warn" : "miss",
        { label: "集装箱号", source: "orders.raw.containerNo", note: containerNo ? "请与实际船公司核对箱号" : "集装箱号未录入" }
      ),
      marks:            field(o.marks || "N/M", "auto", { label: "标记唛码" }),
      factory:          field(o.factory || null, o.factory ? "auto" : "miss", { label: "工厂" }),
    };

    // ── 12. 汇总 gaps ────────────────────────────────────────────────────────
    const gaps = [];
    for (const [id, f] of Object.entries(fields)) {
      if (f.status === "warn")   gaps.push({ field: id, label: f.label, level: "warn",   msg: f.note || "需人工核查" });
      if (f.status === "miss")   gaps.push({ field: id, label: f.label, level: "miss",   msg: f.note || "字段缺失" });
      if (f.status === "broker") gaps.push({ field: id, label: f.label, level: "broker", msg: "报关行填写" });
    }
    for (const item of items) {
      if (item.hs_status !== "auto")
        gaps.push({ field: `item_${item.no}_hs`, label: "HS编码", level: item.hs_status, msg: "产品表未匹配，需确认" });
      if (item.origin_code_status !== "auto")
        gaps.push({ field: `item_${item.no}_origin`, label: "境内货源地", level: "miss", msg: "工厂城市海关代码未录入知识库" });
    }

    const auto_count   = Object.values(fields).filter(f => f.status === "auto").length;
    const warn_count   = Object.values(fields).filter(f => f.status === "warn").length;
    const miss_count   = Object.values(fields).filter(f => f.status === "miss").length;
    const broker_count = Object.values(fields).filter(f => f.status === "broker").length;
    const total_fields = Object.keys(fields).length;
    const completeness = Math.round((auto_count / total_fields) * 100);

    return res.status(200).json({
      success: true,
      order: {
        id:          o.id,
        order_no:    o.order_no,
        contract_no: o.contract_no,
        customer:    o.customer,
        country:     o.country,
        factory:     o.factory,
        pol:         o.pol,
      },
      fields,
      items,
      gaps,
      summary: { auto_count, warn_count, miss_count, broker_count, completeness },
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[customs-draft]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
