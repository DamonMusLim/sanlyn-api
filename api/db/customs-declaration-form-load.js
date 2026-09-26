// customs-declaration-form-load.js — 报关单：读库（计划/订单/明细/CIQ 行）
// 从 customs-declaration-form-lib.js 拆出（0926，code-guard 600 行上限）。逐行原样搬移，未改逻辑。
import {
  CUSTOMS_DECLARATION_ELEMENTS_EXPR,
  CUSTOMS_DECLARATION_NAME_EXPR,
  CUSTOMS_HS_EXPR,
  CUSTOMS_PRODUCT_JOIN_SQL,
  CUSTOMS_PRODUCT_ONE_CTE,
} from "./customs-product-resolver.js";

import { clean, parseRaw, pick } from "./customs-declaration-form-fmt.js";

export async function getColumns(pool, table) {
  try {
    var r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    return new Set(r.rows.map(function (x) { return x.column_name; }));
  } catch (_) {
    return new Set();
  }
}

export async function loadCompany(pool, name) {
  name = clean(name);
  if (!name) return null;
  var cols = await getColumns(pool, "companies");
  if (!cols.size) return null;

  var select = ["name_cn", "name_en", "tax_id", "registration_no", "uscc"]
    .filter(function (c) { return cols.has(c); });
  if (!select.length) return null;

  var conds = [];
  var args = [name];
  if (cols.has("name_cn")) conds.push("btrim(name_cn) = btrim($1)");
  if (cols.has("name_en")) conds.push("btrim(name_en) = btrim($1)");
  if (!conds.length) return null;

  try {
    var r = await pool.query(
      `SELECT ${select.join(", ")} FROM companies WHERE ${conds.join(" OR ")} LIMIT 1`,
      args
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

export async function loadPlan(pool, shipmentId) {
  var r = await pool.query(
    `SELECT * FROM shipping_plans
     WHERE _id::text=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1
     LIMIT 1`,
    [String(shipmentId)]
  );
  return r.rows[0] || null;
}

export function orderKeys(plan) {
  var raw = parseRaw(plan.raw);
  var xs = []
    .concat(Array.isArray(plan.order_nos) ? plan.order_nos : [])
    .concat(Array.isArray(plan.contract_nos) ? plan.contract_nos : [])
    .concat(Array.isArray(raw.orderNos) ? raw.orderNos : [])
    .concat(Array.isArray(raw.order_nos) ? raw.order_nos : [])
    .concat(Array.isArray(raw.contractNos) ? raw.contractNos : [])
    .concat(clean(plan.contract_no) ? [plan.contract_no] : []);
  var seen = new Set();
  return xs.map(clean).filter(function (x) {
    if (!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

export async function loadOrders(pool, plan) {
  var keys = orderKeys(plan);
  if (!keys.length) return [];
  var r = await pool.query(
    `SELECT * FROM orders
     WHERE order_no = ANY($1::text[])
        OR contract_no = ANY($1::text[])
        OR _id::text = ANY($1::text[])
        OR id::text = ANY($1::text[])
     ORDER BY id ASC`,
    [keys]
  );
  return r.rows;
}

export async function loadOrdersByIds(pool, orderIds) {
  if (!orderIds.length) return [];
  var r = await pool.query(
    `SELECT * FROM orders
     WHERE id = ANY($1::int[])
     ORDER BY id ASC`,
    [orderIds]
  );
  return r.rows;
}

export async function resolveOrdersForContainer(pool, planOrBl, container_no) {
  var containerNo = clean(container_no);
  if (!containerNo) return [];

  var blNo = "";
  var planId = "";
  if (planOrBl && typeof planOrBl === "object") {
    var raw = parseRaw(planOrBl.raw);
    blNo = clean(pick(planOrBl.bl_no, raw.blNo, raw.bl_no));
    planId = clean(pick(planOrBl.id, planOrBl._id));
  } else {
    blNo = clean(planOrBl);
  }

  if (blNo) {
    try {
      var oc = await pool.query(
        `SELECT DISTINCT o.id
           FROM order_containers oc
           JOIN containers c ON c.id = oc.container_id
           LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
           JOIN orders o ON o.id = oc.order_id
          WHERE btrim(c.container_no) = btrim($1)
            AND (sg.bl_master = $2 OR o.bl_no = $2 OR o.raw->>'blNo' = $2 OR o.raw->>'bl_no' = $2)
          ORDER BY o.id ASC`,
        [containerNo, blNo]
      );
      var ocIds = oc.rows.map(function (o) { return Number(o.id); }).filter(function (id) { return Number.isFinite(id); });
      if (ocIds.length) return ocIds;
    } catch (_) {}
  }

  var cb = await pool.query(
    `SELECT id, bl_no, shipping_plan_id, contract_no, container_no
       FROM container_bookings
      WHERE btrim(container_no) = btrim($1)
      ORDER BY id ASC`,
    [containerNo]
  );
  if (!cb.rows.length) return [];

  var matched = cb.rows.filter(function (b) {
    var sameBl = blNo && clean(b.bl_no) === blNo;
    var samePlan = planId && clean(b.shipping_plan_id) === planId;
    return sameBl || samePlan;
  });
  var rows = matched.length ? matched : cb.rows;

  var refs = [];
  var seenRefs = new Set();
  rows.forEach(function (b) {
    var ref = clean(b.contract_no);
    if (!ref || /^TBD(?:-|$)/i.test(ref) || seenRefs.has(ref)) return;
    seenRefs.add(ref);
    refs.push(ref);
  });
  if (!refs.length) return [];

  var byOrderNo = await pool.query(
    `SELECT id, order_no, contract_no FROM orders WHERE order_no = ANY($1::text[])`,
    [refs]
  );
  var matchedOrderNos = new Set(byOrderNo.rows.map(function (o) { return clean(o.order_no); }));
  var ids = [];
  var seenIds = new Set();
  byOrderNo.rows.forEach(function (o) {
    var id = Number(o.id);
    if (Number.isFinite(id) && !seenIds.has(id)) {
      seenIds.add(id);
      ids.push(id);
    }
  });

  var remaining = refs.filter(function (ref) { return !matchedOrderNos.has(ref); });
  if (remaining.length) {
    var byContractNo = await pool.query(
      `SELECT id, order_no, contract_no FROM orders WHERE contract_no = ANY($1::text[])`,
      [remaining]
    );
    byContractNo.rows.forEach(function (o) {
      var id = Number(o.id);
      if (Number.isFinite(id) && !seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    });
  }

  return ids;
}

export async function loadLines(pool, orderIds) {
  if (!orderIds.length) return [];
  var ciqRows = await loadCiqLines(pool, orderIds);
  if (ciqRows) return ciqRows;
  var r = await pool.query(
    `WITH ${CUSTOMS_PRODUCT_ONE_CTE},
     keyed AS (
       SELECT
         ${CUSTOMS_HS_EXPR} AS hs_code,
         ${CUSTOMS_DECLARATION_NAME_EXPR} AS declaration_name,
         ${CUSTOMS_DECLARATION_ELEMENTS_EXPR} AS declaration_elements,
         oli.qty_ctn,
         oli.nw_ctn, oli.gw_ctn,
         oli.unit_price, oli.declare_amount_per_box,
         oli.subtotal
       FROM order_line_items oli
       ${CUSTOMS_PRODUCT_JOIN_SQL}
       WHERE oli.order_id = ANY($1::int[])
     ),
     -- 2026-08-07 DNA「合并 + 全写要么无」(Damon): 合并行的申报要素绝不用 MIN/MAX 随便取一个 SKU 的。
     --   逐要素字段(形如 "5:品牌(中文或外文名称):ECO")在【本票SKU范围内】聚合:
     --   同值→用之; 不同值→全部列出用 "/" 连接(如 ECO/ENRICH); 没有→留空。
     --   踩过的坑: 原 MIN() 让报关单印 ECO、同源CSV取到 ENRICH,同一票两个品牌互相打架。
     elem_parts AS (
       SELECT k.hs_code,
              (regexp_match(t.part, '^\s*([0-9]+)\s*:\s*([^:]+?)\s*:\s*(.*)$'))[1] AS e_no,
              (regexp_match(t.part, '^\s*([0-9]+)\s*:\s*([^:]+?)\s*:\s*(.*)$'))[2] AS e_name,
              btrim((regexp_match(t.part, '^\s*([0-9]+)\s*:\s*([^:]+?)\s*:\s*(.*)$'))[3]) AS e_val
       FROM keyed k,
            LATERAL unnest(string_to_array(k.declaration_elements, '|')) AS t(part)
       WHERE k.declaration_elements IS NOT NULL
     ),
     elem_merged AS (
       SELECT hs_code, e_no, e_name,
              string_agg(DISTINCT NULLIF(e_val,''), '/' ORDER BY NULLIF(e_val,'')) AS e_val
       FROM elem_parts
       WHERE e_no IS NOT NULL
       GROUP BY hs_code, e_no, e_name
     ),
     hs_elements AS (
       SELECT hs_code,
              string_agg(e_no || ':' || e_name || ':' || COALESCE(e_val,''), '|' ORDER BY e_no::int) AS declaration_elements
       FROM elem_merged
       GROUP BY hs_code
     ),
     -- 2026-07-06: 同HS只报一行(照商检单口径,别按品名再拆),品名取该HS下箱数最大的那个
     name_by_hs AS (
       SELECT DISTINCT ON (hs_code) hs_code, declaration_name AS dominant_name
       FROM (
         SELECT hs_code, declaration_name, SUM(qty_ctn) AS qty_sum
         FROM keyed
         GROUP BY hs_code, declaration_name
       ) g
       ORDER BY hs_code, qty_sum DESC NULLS LAST
     )
     SELECT
       k.hs_code,
       n.dominant_name AS declaration_name,
       MAX(h.declaration_elements) AS declaration_elements,
       SUM(k.qty_ctn) AS qty_ctn,
       SUM(CASE WHEN k.nw_ctn IS NOT NULL AND k.qty_ctn IS NOT NULL THEN k.nw_ctn * k.qty_ctn ELSE NULL END) AS net_weight_kg,
       SUM(CASE WHEN k.gw_ctn IS NOT NULL AND k.qty_ctn IS NOT NULL THEN k.gw_ctn * k.qty_ctn ELSE NULL END) AS gross_weight_kg,
       -- 2026-08-07: 原为 MIN(unit_price) —— 合并行取了最便宜那个(猫砂 ECO 55.3 vs ENRICH 61 → 印55.30),
       --   与报检申报单价(总值/数量=56.155)对不上, 且 单价×数量≠总价。改为加权均价(总价÷数量), 自洽且与报检一致。
       CASE WHEN SUM(k.qty_ctn) > 0 THEN ROUND(SUM(COALESCE(k.qty_ctn * NULLIF(k.declare_amount_per_box, 0), k.subtotal))::numeric / SUM(k.qty_ctn)::numeric, 5)
            ELSE MIN(k.unit_price) END AS unit_price,
       SUM(COALESCE(k.qty_ctn * NULLIF(k.declare_amount_per_box, 0), k.subtotal)) AS total_amount
     FROM keyed k
     LEFT JOIN hs_elements h ON h.hs_code IS NOT DISTINCT FROM k.hs_code
     LEFT JOIN name_by_hs n ON n.hs_code IS NOT DISTINCT FROM k.hs_code
     GROUP BY k.hs_code, n.dominant_name
     ORDER BY hs_code`,
    [orderIds]
  );
  return r.rows;
}

function _ciqNum(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _ciqSku(v) {
  return clean(v).toUpperCase();
}

function _mergeDeclarationElements(rows) {
  var parts = {};
  (rows || []).forEach(function (row) {
    String(row.declaration_elements || "").split("|").forEach(function (part) {
      var m = /^\s*([0-9]+)\s*:\s*([^:]+?)\s*:\s*(.*)$/.exec(part || "");
      if (!m) return;
      var k = m[1] + ":" + m[2];
      var val = clean(m[3]);
      if (!parts[k]) parts[k] = { no: Number(m[1]), name: m[2], vals: {} };
      if (val) parts[k].vals[val] = 1;
    });
  });
  return Object.keys(parts).sort(function (a, b) {
    return parts[a].no - parts[b].no;
  }).map(function (k) {
    var p = parts[k];
    return p.no + ":" + p.name + ":" + Object.keys(p.vals).sort().join("/");
  }).join("|");
}

function _ciqWarn(kind, detail) {
  console.warn("[customs-decl] ciq_lines_" + kind + ": " + detail);
}

async function loadCiqLines(pool, orderIds) {
  var ordersR = await pool.query("SELECT id, order_no, raw FROM orders WHERE id = ANY($1::int[]) ORDER BY id", [orderIds]);
  var ciqGroups = [];
  ordersR.rows.forEach(function (o) {
    var raw = parseRaw(o.raw);
    var ciq = raw && raw.ciq;
    var lines = ciq && Array.isArray(ciq.lines) ? ciq.lines : [];
    if (lines.length) ciqGroups.push({ orderId: Number(o.id), orderNo: o.order_no, lines: lines });
  });
  if (!ciqGroups.length) return null;

  var liR = await pool.query(
    `WITH ${CUSTOMS_PRODUCT_ONE_CTE}
     SELECT
       oli.order_id,
       oli.sku,
       ${CUSTOMS_HS_EXPR} AS hs_code,
       ${CUSTOMS_DECLARATION_NAME_EXPR} AS declaration_name,
       ${CUSTOMS_DECLARATION_ELEMENTS_EXPR} AS declaration_elements,
       oli.qty_ctn,
       oli.nw_ctn, oli.gw_ctn,
       oli.unit_price, oli.declare_amount_per_box,
       oli.subtotal
     FROM order_line_items oli
     ${CUSTOMS_PRODUCT_JOIN_SQL}
     WHERE oli.order_id = ANY($1::int[])
     ORDER BY oli.order_id, oli.sort_order, oli.id`,
    [orderIds]
  );
  var allItems = liR.rows || [];
  var byOrder = {};
  allItems.forEach(function (li) {
    (byOrder[String(li.order_id)] || (byOrder[String(li.order_id)] = [])).push(li);
  });

  var covered = {};
  var out = [];
  ciqGroups.forEach(function (group) {
    var items = byOrder[String(group.orderId)] || [];
    group.lines.slice().sort(function (a, b) { return Number(a.no || 0) - Number(b.no || 0); }).forEach(function (line) {
      var lineSkus = Array.isArray(line.skus) ? line.skus.map(_ciqSku).filter(Boolean) : null;
      var lineSkuSet = {};
      (lineSkus || []).forEach(function (s) { lineSkuSet[s] = 1; });
      var hs = clean(line.hs);
      var matched = items.filter(function (li) {
        var sku = _ciqSku(li.sku);
        if (lineSkus) return !!lineSkuSet[sku];
        if (line.sku_rule && hs) return clean(li.hs_code) === hs;
        return false;
      });
      matched.forEach(function (li) {
        if (li.sku) covered[String(group.orderId) + "|" + _ciqSku(li.sku)] = 1;
      });
      if (lineSkus) {
        lineSkus.forEach(function (sku) {
          if (!items.some(function (li) { return _ciqSku(li.sku) === sku; })) {
            _ciqWarn("missing_sku", "order " + (group.orderNo || group.orderId) + " line " + clean(line.no) + " sku " + sku);
          }
        });
      }
      var qtySum = matched.reduce(function (s, li) { return s + (Number(li.qty_ctn) || 0); }, 0);
      var amountSum = matched.reduce(function (s, li) {
        var q = Number(li.qty_ctn) || 0;
        return s + Number(q * Number(li.declare_amount_per_box || 0) || li.subtotal || 0);
      }, 0);
      var grossSum = matched.reduce(function (s, li) {
        var q = Number(li.qty_ctn) || 0;
        var gw = Number(li.gw_ctn);
        return s + (Number.isFinite(gw) ? gw * q : 0);
      }, 0);
      out.push({
        hs_code: hs,
        declaration_name: clean(line.decl_name),
        declaration_elements: _mergeDeclarationElements(matched),
        qty_ctn: _ciqNum(line.qty_ctn),
        net_weight_kg: _ciqNum(line.nw_kg),
        gross_weight_kg: grossSum || null,
        unit_price: qtySum > 0 ? Number((amountSum / qtySum).toFixed(5)) : null,
        total_amount: _ciqNum(line.amount_cny),
        origin: clean(line.origin),
        packing: clean(line.packing),
        ciq_no: line.no,
      });
    });
  });
  allItems.forEach(function (li) {
    var sku = _ciqSku(li.sku);
    if (sku && !covered[String(li.order_id) + "|" + sku]) {
      _ciqWarn("uncovered_sku", "order_id " + li.order_id + " sku " + sku);
    }
  });
  return out;
}

