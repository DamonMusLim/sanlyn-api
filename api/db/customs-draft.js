// customs-draft.js
// GET /api/db/customs-draft?order_no=37-WP-59
// Returns enriched order + products with declaration fields from products table

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PORT_LOOKUP = {
  QINGDAO:   { exit_customs: "(4218) 青开发区",  exit_port: "(370201) 黄岛" },
  XIAMEN:    { exit_customs: "(4601) 厦门海关",  exit_port: "(350100) 厦门" },
  SHANGHAI:  { exit_customs: "(2244) 洋山港",    exit_port: "(310100) 上海" },
  NINGBO:    { exit_customs: "(2246) 宁波海关",  exit_port: "(330200) 宁波" },
  TIANJIN:   { exit_customs: "(0201) 天津港",    exit_port: "(120100) 天津" },
  GUANGZHOU: { exit_customs: "(5157) 广州黄埔",  exit_port: "(440100) 广州" },
  SHENZHEN:  { exit_customs: "(5158) 深圳海关",  exit_port: "(440300) 深圳" },
};

const COUNTRY_LOOKUP = {
  Malaysia:    { code: "MYS", cn: "马来西亚", portCode: "MYS105", portName: "巴生港（马来西亚）" },
  Philippines: { code: "PHL", cn: "菲律宾",   portCode: "PHL114", portName: "马尼拉（菲律宾）" },
  Singapore:   { code: "SGP", cn: "新加坡",   portCode: "SGP001", portName: "新加坡" },
  USA:         { code: "USA", cn: "美国",      portCode: "USA999", portName: "目的港" },
  Thailand:    { code: "THA", cn: "泰国",      portCode: "THA001", portName: "曼谷" },
  Vietnam:     { code: "VNM", cn: "越南",      portCode: "VNM001", portName: "胡志明" },
  Indonesia:   { code: "IDN", cn: "印度尼西亚",portCode: "IDN001", portName: "雅加达" },
};

const ORIGIN_LOOKUP = {
  "烟台":   "(37069) 烟台其他",
  "连云港": "(32079) 连云港其他",
  "南平":   "(35019) 南平其他",
  "厦门":   "(35010) 厦门",
  "青岛":   "(37020) 青岛",
  "上海":   "(31010) 上海",
};

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ success: false, error: "order_no is required" });

  const pool = getPool();

  // Find order by order_no OR contract_no
  const orderRes = await pool.query(
    `SELECT * FROM orders WHERE order_no = $1 OR contract_no = $1 LIMIT 1`,
    [order_no]
  );
  if (!orderRes.rows.length) {
    return res.status(404).json({ success: false, error: "Order not found: " + order_no });
  }
  const o = orderRes.rows[0];
  const raw = o.raw || {};

  // Enrich products: join products table by barcode to get declaration fields
  const orderProducts = Array.isArray(o.products) ? o.products : [];
  let enriched = orderProducts;

  if (orderProducts.length > 0) {
    const barcodes = orderProducts.map(p => p.barcode).filter(Boolean);
    if (barcodes.length > 0) {
      const ph = barcodes.map((_, i) => "$" + (i + 1));
      const pRes = await pool.query(
        `SELECT barcode, hs_code, declaration_name, declaration_elements, factory_city
         FROM products WHERE barcode IN (${ph.join(",")})`,
        barcodes
      );
      const byBarcode = {};
      pRes.rows.forEach(r => { byBarcode[r.barcode] = r; });

      enriched = orderProducts.map(p => {
        const pr = byBarcode[p.barcode] || {};
        return {
          ...p,
          hsCode:               p.hsCode || pr.hs_code || "",
          declaration_name:     pr.declaration_name || p.name || p.category || "宠物食品",
          declaration_elements: pr.declaration_elements || "",
          factory_city:         pr.factory_city || raw.factoryCity || "",
        };
      });
    }
  }

  // Resolve lookup fields
  const polKey    = (o.pol || raw.pol || "").toUpperCase().split(/[\s_-]/)[0];
  const portInfo  = PORT_LOOKUP[polKey] || {};
  const ctry      = COUNTRY_LOOKUP[o.country || raw.country] || {};
  const destCode  = ctry.code ? `(${ctry.code}) ${ctry.cn}` : (o.country || "");
  const destPort  = ctry.portCode ? `(${ctry.portCode}) ${ctry.portName}` : (o.destination_port || "");

  // Bucket products by hs_code + declaration_name (merge same HS)
  const buckets = {};
  enriched.forEach(p => {
    const dname = p.declaration_name || "宠物食品";
    const hs    = p.hsCode || "";
    const key   = hs + "||" + dname;
    if (!buckets[key]) {
      buckets[key] = {
        hs, name: dname, elems: p.declaration_elements || "",
        city: p.factory_city || "", ctn: 0, nw: 0, gw: 0,
      };
    }
    const qty = parseFloat(p.qty || 0);
    const nwPer = parseFloat(p.netWeight || p.net_weight || 0);
    const gwPer = parseFloat(p.grossWeight || p.gross_weight || 0);
    buckets[key].ctn += qty;
    buckets[key].nw  = parseFloat((buckets[key].nw + nwPer * qty).toFixed(2));
    buckets[key].gw  = parseFloat((buckets[key].gw + gwPer * qty).toFixed(2));
    if (!buckets[key].city && p.factory_city) buckets[key].city = p.factory_city;
  });
  const items = Object.values(buckets).map((b, i) => ({
    no: i + 1, ...b,
    originCode: ORIGIN_LOOKUP[b.city] || null,
  }));

  const totalAmt = parseFloat(o.total_amount || 0);
  const nwKg     = parseFloat(o.net_weight || 0);
  const unitPrice = nwKg > 0 ? (totalAmt / nwKg).toFixed(4) : null;

  return res.status(200).json({
    success: true,
    order: {
      order_no:        o.order_no,
      contract_no:     o.contract_no,
      customer_po:     o.customer_po || raw.customerPO || "",
      customer:        o.customer,
      issuing_company: o.issuing_company || raw.issuingCompany || "",
      issuing_company_en: o.issuing_company_en || "",
      pol:             o.pol || raw.pol || "",
      country:         o.country || raw.country || "",
      destination_port: o.destination_port || raw.destinationPort || "",
      total_qty:       o.total_qty,
      gross_weight:    o.gross_weight,
      net_weight:      o.net_weight,
      total_amount:    o.total_amount,
      currency:        o.currency || "USD",
      vessel:          raw.vessel || "",
      voyage:          raw.voyage || "",
      blNo:            raw.blNo || "",
      containerNo:     raw.containerNo || "",
      marks:           raw.marks || "N/M",
      // resolved fields
      portInfo, destCode, destPort, unitPrice,
    },
    items,
  });
}
