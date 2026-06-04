// customs-consolidated.js
// Multi-container consolidated customs declaration
// Groups ALL line items across orders in one shipment (BL) by 报关品名 (declaration_name),
// summing quantities/weights/amounts, keeping declared price SEPARATE from customer sale price.
//
// GET /api/db/customs-consolidated?bl_no=<BL>
// GET /api/db/customs-consolidated?shipment_id=<id>
// GET /api/db/customs-consolidated?contract_nos=FS20260206016,FS20260206017
//
// Returns:
// {
//   success: true,
//   bl_no: "...",
//   lines: [
//     {
//       declaration_name,   // 报关品名 (from products master, authoritative)
//       hs_code,            // HS code
//       declaration_elements, // 申报要素
//       origin_country,     // 产地
//       factories: ["工厂A (泉州)", ...], // distinct factories
//       min_unit_qty,       // 最小单位数量 = Σ(qty_cartons × bg_bx)
//       ctn,                // 箱数 = Σ(qty_cartons)
//       nw_kg,              // 净重 = Σ(net_weight × qty_cartons)
//       gw_kg,              // 毛重 = Σ(gross_weight × qty_cartons)
//       cbm,                // CBM = Σ(cbm × qty_cartons)
//       declared_amount,    // 申报金额 = Σ(declaration_amount × min_unit_qty)  [customs value]
//       customer_amount,    // 客户销售价合计 = Σ(unitPrice × qty_cartons)      [commercial]
//     }
//   ],
//   totals: { ctn, nw_kg, gw_kg, cbm, declared_amount, customer_amount, min_unit_qty },
//   orders_included: ["order_no", ...],
//   missing_skus: ["SKU"],      // SKUs not found in products master
//   missing_weight: ["SKU"],    // SKUs with no weight data
//   generated_at: "ISO",
// }

import { getPool, setCors } from "../db.js";

// 报关品名 merge map — consolidate legacy/variant names to canonical
const MERGE_MAP = {
  "喂食器":     "宠物喂食器",
  "宠物喂水器": "宠物喂食器",
  "喂水器":     "宠物喂食器",
  "喂水喂食器": "宠物喂食器",
};

function normalizeDeclName(name) {
  if (!name) return null;
  const t = name.trim();
  return MERGE_MAP[t] || t;
}

// Keyword fallback: derive a 报关品名 from a product name/size when no master
// declaration_name is available (generic order-line products with no SKU match).
// Avoids the unhelpful "其他" bucket.
function deriveDeclName(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/litter|猫砂|膨润|tofu|bentonite/.test(s)) return "宠物猫砂";
  if (/canned|罐头|loaf|pouch|gravy|food|粮|treat|jerky|stick|零食|饼干|biscuit|kibble/.test(s)) return "宠物食品";
  if (/wash|shampoo|沐浴|清洁|洗|spray|wipe|湿巾|clean/.test(s)) return "宠物清洁用品";
  if (/bed|窝|垫|mat|cushion|nest/.test(s)) return "宠物用品";
  if (/bowl|feeder|碗|喂食|drinker|water|喂水|餐具/.test(s)) return "宠物餐具";
  if (/cage|carrier|笼|出行|kennel/.test(s)) return "宠物用品";
  if (/toy|玩具/.test(s)) return "宠物玩具";
  if (/diaper|尿|纸尿/.test(s)) return "宠物用品";
  if (/cloth|衣|雨衣|apparel/.test(s)) return "宠物用品";
  return null;
}

// Parse bg_bx like "24PCS/CTN" → 24, "36" → 36, null/undefined → 1
function parseBgBx(bgBx) {
  if (!bgBx) return 1;
  const n = parseFloat(String(bgBx).replace(/[^\d.]/g, "")) || 1;
  return n > 0 ? n : 1;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  const { bl_no, shipment_id, contract_nos } = req.query;

  if (!bl_no && !shipment_id && !contract_nos)
    return res.status(400).json({ success: false, error: "Provide ?bl_no=, ?shipment_id=, or ?contract_nos=" });

  try {
    let orders = [];

    // ── 1. Resolve orders for this shipment ────────────────────────────────
    if (bl_no) {
      // Direct: orders.bl_no match
      const { rows: directOrders } = await pool.query(
        `SELECT order_no, contract_no, raw, bl_no
         FROM orders
         WHERE bl_no = $1`,
        [bl_no]
      );

      // Also check shipping_plans.order_contract_nos for additional orders on same BL
      const { rows: plans } = await pool.query(
        `SELECT order_contract_nos FROM shipping_plans WHERE bl_no = $1`,
        [bl_no]
      );

      const linkedNos = new Set(directOrders.map(o => o.order_no).filter(Boolean));
      const linkedContracts = new Set(directOrders.map(o => o.contract_no).filter(Boolean));

      for (const plan of plans) {
        const nos = plan.order_contract_nos;
        if (!nos) continue;
        // order_contract_nos may be a string like "FS20260206018" or "48-5|FS20260509001"
        // or JSON array ["CP26031606-1"] — handle all forms
        let candidates = [];
        if (typeof nos === "string") {
          candidates = nos.split(/[|,\s]+/).map(s => s.trim()).filter(Boolean);
        } else if (Array.isArray(nos)) {
          candidates = nos.map(String).filter(Boolean);
        }
        for (const c of candidates) {
          if (!linkedNos.has(c) && !linkedContracts.has(c)) {
            linkedNos.add(c);
          }
        }
      }

      // Fetch any extra orders referenced by shipping_plans but not yet fetched
      const extraNos = [...linkedNos].filter(n => !directOrders.find(o => o.order_no === n || o.contract_no === n));
      let extraOrders = [];
      if (extraNos.length > 0) {
        const { rows } = await pool.query(
          `SELECT order_no, contract_no, raw, bl_no
           FROM orders
           WHERE order_no = ANY($1) OR contract_no = ANY($1)`,
          [extraNos]
        );
        extraOrders = rows;
      }

      orders = [...directOrders, ...extraOrders];
      // Dedupe by order_no
      const seen = new Set();
      orders = orders.filter(o => {
        const key = o.order_no || o.contract_no || JSON.stringify(o);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    } else if (shipment_id) {
      const { rows: plans } = await pool.query(
        `SELECT order_contract_nos, bl_no FROM shipping_plans WHERE id = $1 OR _id = $1`,
        [shipment_id]
      );
      if (!plans.length) return res.status(404).json({ success: false, error: "Shipment not found" });
      const plan = plans[0];
      const resolvedBlNo = plan.bl_no;
      // Recurse via bl_no path
      const fakeReq = { method: "GET", query: { bl_no: resolvedBlNo } };
      return handler(fakeReq, res);

    } else if (contract_nos) {
      const nos = contract_nos.split(",").map(s => s.trim()).filter(Boolean);
      const { rows } = await pool.query(
        `SELECT order_no, contract_no, raw, bl_no
         FROM orders WHERE order_no = ANY($1) OR contract_no = ANY($1)`,
        [nos]
      );
      orders = rows;
    }

    if (!orders.length) {
      return res.status(200).json({
        success: true,
        bl_no: bl_no || null,
        lines: [],
        totals: { ctn: 0, min_unit_qty: 0, nw_kg: 0, gw_kg: 0, cbm: 0, declared_amount: 0, customer_amount: 0 },
        orders_included: [],
        missing_skus: [],
        missing_weight: [],
        message: "No orders found for this shipment.",
        generated_at: new Date().toISOString(),
      });
    }

    // ── 2. Expand all line items, collect SKUs ─────────────────────────────
    const rawLines = [];
    const allSkus = new Set();

    for (const ord of orders) {
      const items = Array.isArray(ord.raw?.products) ? ord.raw.products
                  : Array.isArray(ord.products) ? ord.products
                  : [];

      for (const item of items) {
        const sku = item.sku || item._code || item.SKU || null;
        if (sku) allSkus.add(sku);
        rawLines.push({
          sku,
          order_no: ord.order_no,
          // Quantities — qty is cartons
          qty:         parseFloat(item.qty || item.cartons || item.boxes || 0),
          bgBxRaw:     item.bg_bx || item.bgBx || null,
          cbmPerCtn:   parseFloat(item.cbm || 0),
          nwPerCtn:    parseFloat(item.netWeight || item.net_weight || item.nw || 0),
          gwPerCtn:    parseFloat(item.grossWeight || item.gross_weight || item.gw || 0),
          // Customer sale price (商业价值，来自订单)
          unitPriceCustomer: parseFloat(item.unitPrice || item.unit_price || 0),
          subtotalCustomer:  parseFloat(item.subtotal || 0),
          // Declaration fields from JSONB (may be overridden by products master below)
          declNameRaw:          item.declaration_name || item.category || null,
          nameRaw:              item.name || item.product_name || item.productName || item.nameEN || null,
          hsCodeRaw:            item.hs_code || item.hsCode || null,
          declElementsRaw:      item.declaration_elements || null,
          // Size/spec string from order item (e.g. "70G X 72/CTN")
          sizeRaw:              item.size || item.spec || item.specification || null,
        });
      }
    }

    // ── 3. JOIN products master for authoritative declaration fields ────────
    let skuMasterMap = {};
    if (allSkus.size > 0) {
      const { rows: prods } = await pool.query(
        `SELECT DISTINCT ON (sku) sku,
                declaration_name, hs_code, declaration_elements,
                origin_country, factory_name, factory_city,
                declaration_amount,
                net_weight, gross_weight, bg_bx
         FROM products
         WHERE sku = ANY($1)
         ORDER BY sku, updated_at DESC NULLS LAST`,
        [[...allSkus]]
      );
      for (const p of prods) {
        skuMasterMap[p.sku] = p;
      }
    }

    const foundSkus   = new Set(Object.keys(skuMasterMap));
    const missingSkus = [...allSkus].filter(s => !foundSkus.has(s));

    // ── 4. Group by 报关品名 ───────────────────────────────────────────────
    // Bucket key: normalized declaration_name (from master > raw)
    const buckets = {}; // key → accumulator

    const missingWeightSkus = new Set();

    for (const line of rawLines) {
      const master = line.sku ? skuMasterMap[line.sku] : null;

      // Declaration name: master is authoritative
      const declNameFinal = normalizeDeclName(
        (master?.declaration_name) || line.declNameRaw
      ) || deriveDeclName(line.nameRaw || line.sizeRaw);
      const key = declNameFinal || "其他";

      // HS code: master first
      const hsFinal = master?.hs_code || line.hsCodeRaw || null;

      // Declaration elements: master first
      const elemFinal = master?.declaration_elements || line.declElementsRaw || null;

      // Origin + factory
      const origin  = master?.origin_country || null;
      const factory = master?.factory_name   || null;
      const city    = master?.factory_city   || null;

      // Quantities
      const qtyCtn = line.qty;
      // bg_bx: master > line item (parseBgBx handles both)
      const bgBxStr = master?.bg_bx || line.bgBxRaw || null;
      const bgBx    = parseBgBx(bgBxStr);
      const minUnitQty = qtyCtn * bgBx;

      // Weights: master per-unit > line item per-carton
      const nwPerCtn = master?.net_weight   ? parseFloat(master.net_weight)   : line.nwPerCtn;
      const gwPerCtn = master?.gross_weight ? parseFloat(master.gross_weight) : line.gwPerCtn;

      const totalNw  = nwPerCtn  * qtyCtn;
      const totalGw  = gwPerCtn  * qtyCtn;
      const totalCbm = line.cbmPerCtn * qtyCtn;

      // Declared amount: master declaration_amount × min unit qty
      const declAmtPerUnit = master?.declaration_amount ? parseFloat(master.declaration_amount) : 0;
      const totalDeclAmt   = declAmtPerUnit * minUnitQty;

      // Customer amount: use subtotal if present, else unitPrice × qty
      const custAmt = line.subtotalCustomer > 0
        ? line.subtotalCustomer
        : line.unitPriceCustomer * qtyCtn;

      if (qtyCtn > 0 && totalNw === 0 && totalGw === 0) {
        if (line.sku) missingWeightSkus.add(line.sku);
      }

      if (!buckets[key]) {
        buckets[key] = {
          declaration_name: key,
          hs_code:              hsFinal,
          declaration_elements: elemFinal,
          origin_country:       origin,
          _factories: new Set(),
          _sizes: new Set(),
          ctn:             0,
          min_unit_qty:    0,
          nw_kg:           0,
          gw_kg:           0,
          cbm:             0,
          declared_amount: 0,
          customer_amount: 0,
        };
      }

      const b = buckets[key];
      // Update HS / elements if not yet set (first non-null wins, master preferred)
      if (!b.hs_code              && hsFinal)   b.hs_code              = hsFinal;
      if (!b.declaration_elements && elemFinal)  b.declaration_elements = elemFinal;
      if (!b.origin_country       && origin)     b.origin_country       = origin;

      if (factory) {
        const factoryStr = city ? `${factory} (${city})` : factory;
        b._factories.add(factoryStr);
      }

      // Collect distinct size/spec strings for this group
      if (line.sizeRaw) {
        b._sizes.add(line.sizeRaw.trim());
      }

      b.ctn             += qtyCtn;
      b.min_unit_qty    += minUnitQty;
      b.nw_kg           += totalNw;
      b.gw_kg           += totalGw;
      b.cbm             += totalCbm;
      b.declared_amount += totalDeclAmt;
      b.customer_amount += custAmt;
    }

    // ── 5. Shape output ───────────────────────────────────────────────────
    const lines = Object.values(buckets)
      .map(b => ({
        declaration_name:     b.declaration_name,
        sizes:                [...b._sizes].join(" / "),   // e.g. "70G X 72/CTN / 80G X 24/CTN / 400G X 24/CTN"
        hs_code:              b.hs_code,
        declaration_elements: b.declaration_elements,
        origin_country:       b.origin_country,
        factories:            [...b._factories],
        ctn:                  Math.round(b.ctn),
        min_unit_qty:         Math.round(b.min_unit_qty),
        nw_kg:                parseFloat(b.nw_kg.toFixed(2)),
        gw_kg:                parseFloat(b.gw_kg.toFixed(2)),
        cbm:                  parseFloat(b.cbm.toFixed(4)),
        declared_amount:      parseFloat(b.declared_amount.toFixed(2)),
        customer_amount:      parseFloat(b.customer_amount.toFixed(2)),
      }))
      .sort((a, b) => b.ctn - a.ctn);

    const totals = lines.reduce(
      (acc, r) => ({
        ctn:             acc.ctn             + r.ctn,
        min_unit_qty:    acc.min_unit_qty    + r.min_unit_qty,
        nw_kg:           parseFloat((acc.nw_kg           + r.nw_kg).toFixed(2)),
        gw_kg:           parseFloat((acc.gw_kg           + r.gw_kg).toFixed(2)),
        cbm:             parseFloat((acc.cbm             + r.cbm).toFixed(4)),
        declared_amount: parseFloat((acc.declared_amount + r.declared_amount).toFixed(2)),
        customer_amount: parseFloat((acc.customer_amount + r.customer_amount).toFixed(2)),
      }),
      { ctn: 0, min_unit_qty: 0, nw_kg: 0, gw_kg: 0, cbm: 0, declared_amount: 0, customer_amount: 0 }
    );

    return res.status(200).json({
      success:          true,
      bl_no:            bl_no || null,
      lines,
      totals,
      orders_included:  orders.map(o => o.order_no || o.contract_no).filter(Boolean),
      missing_skus:     missingSkus,
      missing_weight:   [...missingWeightSkus],
      generated_at:     new Date().toISOString(),
    });

  } catch (err) {
    console.error("[customs-consolidated]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
