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

// W0-5 (feedback_declaration_fields_mandatory): removed keyword-based
// deriveDeclName(). Inferring declaration_name from product names is a
// customs filing risk — wrong HS bucket → seized goods / fines. The
// declaration_name MUST come from the products master table (set by ops).
// Lines without declaration_name are tracked in missing_fields[] and the
// caller (customs declaration generator) must STOP rather than guess.
function deriveDeclName(_text) {
  return null;
}

// Parse bg_bx like "24PCS/CTN" → 24, "36" → 36, null/undefined → 1
function parseBgBx(bgBx) {
  if (!bgBx) return 1;
  const n = parseFloat(String(bgBx).replace(/[^\d.]/g, "")) || 1;
  return n > 0 ? n : 1;
}

function hasValue(v) {
  return v !== null && v !== undefined && v !== "";
}

function finiteOrNull(v) {
  if (!hasValue(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundOrNull(v, digits) {
  return v == null ? null : parseFloat(Number(v).toFixed(digits));
}

function sumOrdersSnapshot(orders) {
  const missing = [];
  const sums = { cbm: 0, nw_kg: 0, gw_kg: 0 };
  const ok = { cbm: true, nw_kg: true, gw_kg: true };
  const fields = [
    { out: "cbm", key: "total_cbm", label: "total_cbm", digits: 4 },
    { out: "nw_kg", key: "net_weight", label: "net_weight", digits: 2 },
    { out: "gw_kg", key: "gross_weight", label: "gross_weight", digits: 2 },
  ];

  const perOrder = orders.map(o => {
    const orderNo = o.order_no || o.contract_no || "(unknown)";
    const row = { order_no: orderNo };
    for (const f of fields) {
      const n = finiteOrNull(o[f.key]);
      if (n == null) {
        ok[f.out] = false;
        missing.push(`${orderNo}.${f.label}`);
      } else {
        sums[f.out] += n;
      }
      row[f.out] = roundOrNull(n, f.digits);
    }
    return row;
  });

  return {
    cbm: ok.cbm ? roundOrNull(sums.cbm, 4) : null,
    nw_kg: ok.nw_kg ? roundOrNull(sums.nw_kg, 2) : null,
    gw_kg: ok.gw_kg ? roundOrNull(sums.gw_kg, 2) : null,
    per_order: perOrder,
    missing,
  };
}

function rawQty(item) {
  return finiteOrNull(item?.qty || item?.cartons || item?.boxes);
}

function skuOf(item) {
  return item?.sku || item?._code || item?.SKU || null;
}

function rawProductsOf(ord) {
  const raw = ord?.raw || {};
  if (Array.isArray(raw.products)) return raw.products;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(ord?.products)) return ord.products;
  return [];
}

function firstPresent(...values) {
  return values.find(hasValue);
}

function fillFromMaster(prodVal, masterVal) {
  return (prodVal === undefined || prodVal === null || prodVal === "") && masterVal != null
    ? masterVal
    : prodVal;
}

function rawCbmTotal(item, qty, master) {
  const explicitTotal = finiteOrNull(firstPresent(item?._cbmTot, item?.cbmTotal, item?.totalCbm));
  if (explicitTotal != null && explicitTotal > 0) return explicitTotal;
  const perCtn = finiteOrNull(firstPresent(item?.cbmPerCtn, item?.cbm_per_ctn));
  if (perCtn != null && perCtn > 0) return (qty != null && qty > 0) ? perCtn * qty : perCtn;
  const cbm = finiteOrNull(fillFromMaster(item?.cbm, master?.cbm));   // per-CTN canonical
  if (cbm != null && cbm > 0) return (qty != null && qty > 0) ? cbm * qty : cbm;
  return finiteOrNull(item?.volume);
}

function sumCustomerDocs(orders, liByOrder, skuMasterMap) {
  const missing = [];
  const sums = { cbm: 0, nw_kg: 0, gw_kg: 0 };
  const ok = { cbm: true, nw_kg: true, gw_kg: true };

  function mark(metric, orderNo, idx, label) {
    ok[metric] = false;
    missing.push(`${orderNo} 第${idx + 1}行缺 ${label}`);
  }

  for (const ord of orders) {
    const orderNo = ord.order_no || ord.contract_no || "(unknown)";
    const rawProducts = rawProductsOf(ord);
    if (rawProducts.length) {
      rawProducts.forEach((item, idx) => {
        const sku = skuOf(item);
        const master = sku ? skuMasterMap[sku] : null;
        const qty = rawQty(item);

        const cbm = rawCbmTotal(item, qty, master);
        if (cbm != null) sums.cbm += cbm;
        else mark("cbm", orderNo, idx, "cbm(raw+master均无)");

        const nwRaw = firstPresent(item.netWeight, item.net_weight, item.nw);
        const nw = finiteOrNull(fillFromMaster(nwRaw, master?.net_weight));
        if (nw != null) sums.nw_kg += (nw * qty) || nw;
        else mark("nw_kg", orderNo, idx, "nw(raw+master均无)");

        const gwRaw = firstPresent(item.grossWeight, item.gross_weight, item.gw);
        const gw = finiteOrNull(fillFromMaster(gwRaw, master?.gross_weight));
        if (gw != null) sums.gw_kg += (gw * qty) || gw;
        else mark("gw_kg", orderNo, idx, "gw(raw+master均无)");
      });
      continue;
    }

    const oli = liByOrder[ord.id];
    if (Array.isArray(oli) && oli.length) {
      oli.forEach((li, idx) => {
        const qty = finiteOrNull(li.qty_ctn);
        if (qty == null || qty <= 0) {
          mark("cbm", orderNo, idx, "qty_ctn");
          mark("nw_kg", orderNo, idx, "qty_ctn");
          mark("gw_kg", orderNo, idx, "qty_ctn");
          return;
        }

        const cbmCtn = finiteOrNull(li.cbm_ctn);
        if (cbmCtn != null && cbmCtn > 0) sums.cbm += cbmCtn * qty;
        else mark("cbm", orderNo, idx, "cbm_ctn");

        const nwCtn = finiteOrNull(li.nw_ctn);
        if (nwCtn != null) sums.nw_kg += nwCtn * qty;
        else mark("nw_kg", orderNo, idx, "nw_ctn");

        const gwCtn = finiteOrNull(li.gw_ctn);
        if (gwCtn != null) sums.gw_kg += gwCtn * qty;
        else mark("gw_kg", orderNo, idx, "gw_ctn");
      });
      continue;
    }

    ok.cbm = false;
    ok.nw_kg = false;
    ok.gw_kg = false;
    missing.push(`${orderNo} 缺客户单据行`);
  }

  return {
    cbm: ok.cbm ? roundOrNull(sums.cbm, 4) : null,
    nw_kg: ok.nw_kg ? roundOrNull(sums.nw_kg, 2) : null,
    gw_kg: ok.gw_kg ? roundOrNull(sums.gw_kg, 2) : null,
    missing,
  };
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
        `SELECT id, order_no, contract_no, raw, bl_no, issuing_company,
                total_cbm, net_weight, gross_weight
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
          `SELECT id, order_no, contract_no, raw, bl_no, issuing_company,
                  total_cbm, net_weight, gross_weight
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
        `SELECT id, order_no, contract_no, raw, bl_no, issuing_company,
                total_cbm, net_weight, gross_weight
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
        cross_check: {
          orders_snapshot: { cbm: null, nw_kg: null, gw_kg: null, per_order: [], missing: ["该BL无订单"] },
          customer_docs: { cbm: null, nw_kg: null, gw_kg: null, missing: ["该BL无订单"] },
        },
        orders_included: [],
        missing_skus: [],
        missing_weight: [],
        message: "No orders found for this shipment.",
        generated_at: new Date().toISOString(),
      });
    }

    // ── 1b. Load order_line_items as SSOT source (forge 2026-06-03) ────────
    const _orderIds = orders.map(o => o.id).filter(Boolean);
    const liByOrder = {};
    if (_orderIds.length) {
      const { rows: _liRows } = await pool.query(
        `SELECT order_id, sku, qty_ctn, bg_bx, unit_price, subtotal,
                nw_ctn, gw_ctn, cbm_ctn, declaration_name, declaration_name_en, product_name,
                hs_code, size, declare_amount_per_box
         FROM order_line_items WHERE order_id = ANY($1) ORDER BY sort_order NULLS LAST, id`,
        [_orderIds]
      );
      for (const r of _liRows) { (liByOrder[r.order_id] = liByOrder[r.order_id] || []).push(r); }
    }
    // ── 2. Expand all line items, collect SKUs ─────────────────────────────
    const rawLines = [];
    const allSkus = new Set();

    for (const ord of orders) {
      // forge SSOT: order_line_items 优先(杀双源漂移), 无则回退 raw.products
      const _liItems = liByOrder[ord.id];
      const items = (Array.isArray(_liItems) && _liItems.length)
        ? _liItems.map(r => ({
            sku: r.sku, qty: r.qty_ctn, bg_bx: r.bg_bx, _perCtnCanonical: true,
            cbm: r.cbm_ctn, net_weight: r.nw_ctn, gross_weight: r.gw_ctn,
            unit_price: r.unit_price, subtotal: r.subtotal,
            declaration_name: r.declaration_name, declaration_name_en: r.declaration_name_en, name: r.product_name,
            hs_code: r.hs_code, size: r.size,
            declare_amount_per_box: r.declare_amount_per_box,
          }))
        : (Array.isArray(ord.raw?.products) ? ord.raw.products
           : Array.isArray(ord.products) ? ord.products : []);

      for (const item of items) {
        const sku = item.sku || item._code || item.SKU || null;
        if (sku) allSkus.add(sku);
        rawLines.push({
          sku,
          order_no: ord.order_no,
          issuing_company: ord.issuing_company || null,   // 出单公司(境内发货人) → 报关单边界
          // Quantities — qty is cartons
          qty:         parseFloat(item.qty || item.cartons || item.boxes || 0),
          bgBxRaw:     item.bg_bx || item.bgBx || null,
          // cbm canonical semantics = per-carton (2026-06-10 audit: 66 per-ctn orders vs 1 line-total, normalised).
          // nw/gw may still be stored as totals — heuristics below kept for those two only.
          
          cbmPerCtn:   (() => {
            const pc = parseFloat(item.cbmPerCtn || item.cbm_per_ctn || 0);
            if (pc > 0) return pc;
            return parseFloat(item.cbm || 0);   // per-CTN canonical; OLI path feeds cbm_ctn here
          })(),
          nwPerCtn:    (() => {
            const v = parseFloat(item.netWeight || item.net_weight || item.nw || 0);
            if (item._perCtnCanonical) return v;   // OLI=每箱口径铁律，禁用"猜总量"启发式(2026-06-12 955.21kg误差实案)
            const q = parseFloat(item.qty || item.cartons || 1) || 1;
            return (v > 0 && q > 1 && v > q * 2) ? v / q : v;
          })(),
          gwPerCtn:    (() => {
            const v = parseFloat(item.grossWeight || item.gross_weight || item.gw || 0);
            if (item._perCtnCanonical) return v;
            const q = parseFloat(item.qty || item.cartons || 1) || 1;
            return (v > 0 && q > 1 && v > q * 2) ? v / q : v;
          })(),
          // Customer sale price (商业价值，来自订单)
          unitPriceCustomer: parseFloat(item.unitPrice || item.unit_price || 0),
          subtotalCustomer:  parseFloat(item.subtotal || 0),
          // Declared amount fallback: item.subtotal is CNY procurement total when no SKU master
          declaredSubtotalFallback: parseFloat(item.subtotal || 0),
          // forge SSOT: 行项目快照的每箱申报额(优先于现查master)
          declAmtPerBox: parseFloat(item.declare_amount_per_box || 0),
          // Declaration fields from JSONB (may be overridden by products master below)
          declNameRaw:          item.declaration_name || item.category || null,
          declNameEnRaw:        item.declaration_name_en || null,
          nameRaw:              item.name || item.product_name || item.productName || item.nameEN || null,
          hsCodeRaw:            item.hs_code || item.hsCode || null,
          declElementsRaw:      item.declaration_elements || null,
          // Size/spec string from order item (e.g. "70G X 72/CTN")
          sizeRaw:              item.size || item.spec || item.specification || null,
        });
      }
    }

    for (const ord of orders) {
      for (const item of rawProductsOf(ord)) {
        const sku = skuOf(item);
        if (sku) allSkus.add(sku);
      }
    }

    // ── 3. JOIN products master for authoritative declaration fields ────────
    let skuMasterMap = {};
    if (allSkus.size > 0) {
      const { rows: prods } = await pool.query(
        `SELECT DISTINCT ON (sku) sku,
                declaration_name, declaration_name_en, hs_code, declaration_elements,
                origin_country, factory_name, factory_city,
                declaration_amount,
                transaction_unit, legal_unit_1, legal_unit_2, quarantine_required,
                net_weight, gross_weight, cbm, bg_bx
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
    const crossCheck = {
      orders_snapshot: sumOrdersSnapshot(orders),
      customer_docs: sumCustomerDocs(orders, liByOrder, skuMasterMap),
    };

    // ── 4. Group by 报关品名 ───────────────────────────────────────────────
    // Bucket key: normalized declaration_name (from master > raw)
    const buckets = {}; // key → accumulator

    const missingWeightSkus = new Set();
    // W0-5: track SKUs / lines that lack a real declaration_name so we can
    // STOP (400) when caller asked for a customs declaration (type=cd).
    const missingDeclSkus = new Set();

    for (const line of rawLines) {
      const master = line.sku ? skuMasterMap[line.sku] : null;

      // Declaration name: master is authoritative
      const declNameFinal = normalizeDeclName(
        (master?.declaration_name) || line.declNameRaw
      ) || deriveDeclName(line.nameRaw || line.sizeRaw);
      // W0-5: NO fallback to "其他" — skip lines without a real declaration_name
      // and surface them in missing_fields[]. For type=cd callers this returns 400.
      if (!declNameFinal) {
        missingDeclSkus.add(line.sku || line.nameRaw || "(no-sku)");
        continue;
      }
      // HS code: master first
      const hsFinal = master?.hs_code || line.hsCodeRaw || null;

      // Declaration elements: master first
      const elemFinal = master?.declaration_elements || line.declElementsRaw || null;

      // 英文报关品名: master first (报关单需中英文)
      const declNameEnFinal = (master?.declaration_name_en) || line.declNameEnRaw || null;

      // Origin + factory
      const origin  = master?.origin_country || null;
      const factory = master?.factory_name   || null;
      const city    = master?.factory_city   || null;
      // 计量单位/检疫 — 报关权威库(customs_hs_authority)按HS覆盖进 products
      const txnUnit   = master?.transaction_unit || null;   // 成交计量单位
      const legalU1   = master?.legal_unit_1 || null;        // 法定第一计量单位
      const legalU2   = master?.legal_unit_2 || null;
      // 出单公司(境内发货人)=报关单边界(Damon 2026-06-04):出单公司不同才算独立报关单。
      const issuingCompany = line.issuing_company || null;

      // 报关按工厂拆(Damon铁律 feedback_customs_split_by_factory_show_city:
      // 同HS两厂必拆,不跨厂合并)。bucket key = 报关品名 + 工厂(无则城市兜底);
      // 显示层(报关资料表/PDF)仍只露 境内货源地(城市),绝不印工厂公司名(防跳单)。
      // 1行/HS铁律(customs_doc_format 2026-05-02定版, 2026-06-11落码):
      // 聚合键=出单公司+HS+工厂, 品名不参与拆行(同HS多品名合并, 品名取净重占比最大者)
      const key = (issuingCompany || "") + "" + (hsFinal || ("NOHS:" + declNameFinal)) + "" + (factory || city || "");

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

      // 申报金额 = 申报单价(每最小单位) × 最小单位数量(qty×bg_bx)
      // products.declaration_amount 存的是【每箱】申报额(=每个售价×bg_bx),除bg_bx得每最小单位价。
      // 保留“最小单位”链路是为破损CN表(按罐/包/件赔付)。无主数据时回退 raw.subtotal(整箱采购额)/qty。
      const declAmtPerCtn = (line.declAmtPerBox > 0)
        ? line.declAmtPerBox
        : (master?.declaration_amount
            ? parseFloat(master.declaration_amount)
            : (line.declaredSubtotalFallback > 0 && qtyCtn > 0
                ? line.declaredSubtotalFallback / qtyCtn
                : 0));
      const declAmtPerMinUnit = bgBx > 0 ? declAmtPerCtn / bgBx : declAmtPerCtn; // 每最小单位申报价
      const totalDeclAmt = declAmtPerMinUnit * minUnitQty; // FIX 2026-06-03 v2: 显式走最小单位(=declAmtPerCtn×qtyCtn数值等价),保留min_unit供破损CN

      // Customer amount: use subtotal if present, else unitPrice × qty
      const custAmt = line.subtotalCustomer > 0
        ? line.subtotalCustomer
        : line.unitPriceCustomer * qtyCtn;

      if (qtyCtn > 0 && totalNw === 0 && totalGw === 0) {
        if (line.sku) missingWeightSkus.add(line.sku);
      }

      if (!buckets[key]) {
        buckets[key] = {
          declaration_name: declNameFinal,
          declaration_name_en: declNameEnFinal,
          issuing_company:      issuingCompany,
          hs_code:              hsFinal,
          declaration_elements: elemFinal,
          legal_unit_1:         legalU1,
          legal_unit_2:         legalU2,
          origin_country:       origin,
          _nameNw: {},            // 品名→净重累计(同HS多品名时取净重最大者)
          _nameEn: {},            // 品名→英文名
          _txnUnits: new Set(),   // 成交单位冲突检测:同bucket混不同单位则标红不静默取一个
          _factories: new Set(),
          _skus: new Set(),
          _cities: new Set(),
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
      if (!b.declaration_name_en  && declNameEnFinal) b.declaration_name_en = declNameEnFinal;
      if (!b.declaration_elements && elemFinal)  b.declaration_elements = elemFinal;
      if (!b.origin_country       && origin)     b.origin_country       = origin;
      if (!b.legal_unit_1         && legalU1)    b.legal_unit_1         = legalU1;
      if (!b.legal_unit_2         && legalU2)    b.legal_unit_2         = legalU2;
      if (txnUnit) b._txnUnits.add(txnUnit);     // 成交单位冲突检测
      b._nameNw[declNameFinal] = (b._nameNw[declNameFinal] || 0) + totalNw;
      if (declNameEnFinal && !b._nameEn[declNameFinal]) b._nameEn[declNameFinal] = declNameEnFinal;
      if (line.sku) b._skus.add(line.sku);   // SKU 列表(给权威认证/回灌用)

      if (factory) {
        const factoryStr = city ? `${factory} (${city})` : factory;
        b._factories.add(factoryStr);
      }
      if (city) b._cities.add(city);   // 境内货源地(城市), 报关单字段, 不露工厂公司名

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
      .map(b => {
        const nameList = Object.keys(b._nameNw);
        if (nameList.length > 1) {
          const top = nameList.sort((x, y) => b._nameNw[y] - b._nameNw[x])[0];
          b.declaration_name = top;
          if (b._nameEn[top]) b.declaration_name_en = b._nameEn[top];
          b.merged_names = nameList;   // 同HS合并的全部品名(UI可显示+N合并)
        }
        return b;
      })
      .map(b => ({
        declaration_name:     b.declaration_name,
        declaration_name_en:  b.declaration_name_en || null,
        merged_names:         b.merged_names || null,
        issuing_company:      b.issuing_company || null,
        sizes:                [...b._sizes].join(" / "),   // e.g. "70G X 72/CTN / 80G X 24/CTN / 400G X 24/CTN"
        hs_code:              b.hs_code,
        declaration_elements: b.declaration_elements,
        // 成交单位:bucket内唯一才输出值;混了不同单位=null+冲突标记(绝不静默取一个,Codex review)
        transaction_unit:     b._txnUnits.size === 1 ? [...b._txnUnits][0] : null,
        transaction_unit_conflict: b._txnUnits.size > 1 ? [...b._txnUnits] : null,
        legal_unit_1:         b.legal_unit_1 || null,
        legal_unit_2:         b.legal_unit_2 || null,
        origin_country:       b.origin_country,
        factories:            [...b._factories],
        skus:                 [...b._skus],
        cities:               [...b._cities],
        ctn:                  Math.round(b.ctn),
        min_unit_qty:         Math.round(b.min_unit_qty),
        nw_kg:                parseFloat(b.nw_kg.toFixed(2)),
        gw_kg:                parseFloat(b.gw_kg.toFixed(2)),
        cbm:                  parseFloat(b.cbm.toFixed(4)),
        declared_amount:      parseFloat(b.declared_amount.toFixed(2)),
        decl_amt_per_min_unit: b.min_unit_qty > 0 ? parseFloat((b.declared_amount / b.min_unit_qty).toFixed(4)) : 0,
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

    // W0-5: STOP rule for customs declaration (type=cd) when any line is missing
    // declaration_name. Other types (iv/pl/sc draft) still render with a warning.
    const reqType = String((req.query && req.query.type) || "").toLowerCase();
    if (reqType === "cd" && missingDeclSkus.size) {
      return res.status(400).json({
        success: false,
        error: "declaration_name_missing",
        missing_fields: ["declaration_name"],
        missing_skus:   [...missingDeclSkus],
        rule: "feedback_declaration_fields_mandatory",
        hint: "Fill products.declaration_name for the listed SKUs before generating a customs declaration.",
      });
    }

    return res.status(200).json({
      success:          true,
      bl_no:            bl_no || null,
      lines,
      totals,
      cross_check:      crossCheck,
      orders_included:  orders.map(o => o.order_no || o.contract_no).filter(Boolean),
      missing_skus:     missingSkus,
      missing_weight:   [...missingWeightSkus],
      missing_declaration_name: [...missingDeclSkus], // W0-5
      missing_fields:   missingDeclSkus.size ? ["declaration_name"] : [],
      generated_at:     new Date().toISOString(),
    });

  } catch (err) {
    console.error("[customs-consolidated]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
