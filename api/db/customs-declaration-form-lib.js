export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function clean(v) {
  return String(v ?? "").trim();
}

export function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return "";
}

export function parseRaw(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

export function fmtM(v, dec) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: dec == null ? 2 : dec,
    maximumFractionDigits: dec == null ? 2 : dec,
    useGrouping: false,
  });
}

export function fmtInt(v) {
  if (v == null || v === "") return "";
  var n = Number(v);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n));
}

export function fmtDate(v) {
  if (!v) return "";
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    var d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (_) {}
  return s.slice(0, 10);
}

export function blank(v) {
  var s = clean(v);
  return s ? esc(s) : '<span class="empty">—</span>';
}

// 目的国/贸易国规范化（2026-08-08 修）
// 病根：orders.country 存法五花八门 —— MALAYSIA/Malaysia/MY/SG/MM/Espana/CHILE…
//       原来只认 MYS/MALAYSIA/马来 这种写法，遇到 ISO2 的 "MY" 直接原样印上报关单
//       （LL-23 的贸易国/运抵国/最终目的国就印成了 "MY"）。全库有 8 票是 ISO2 写法。
// 规矩：认不出来就【原样返回】并让人看见，绝不猜一个国家。
const _COUNTRY_TABLE = [
  { cn: "马来西亚(MYS)",   iso2: "MY", keys: ["MYS","MALAYSIA","马来","KLANG","WESTPORT","PASIR GUDANG","PENANG","巴生","KOTA KINABALU","BINTULU"] },
  { cn: "泰国(THA)",       iso2: "TH", keys: ["THA","THAILAND","泰国","LAEM CHABANG","BANGKOK"] },
  { cn: "越南(VNM)",       iso2: "VN", keys: ["VNM","VIETNAM","越南","HAIPHONG","HO CHI MINH","CAI MEP"] },
  { cn: "新加坡(SGP)",     iso2: "SG", keys: ["SGP","SINGAPORE","新加坡"] },
  { cn: "印度尼西亚(IDN)", iso2: "ID", keys: ["IDN","INDONESIA","印尼","印度尼西亚","JAKARTA","SURABAYA"] },
  { cn: "菲律宾(PHL)",     iso2: "PH", keys: ["PHL","PHILIPPINES","菲律宾","MANILA"] },
  { cn: "缅甸(MMR)",       iso2: "MM", keys: ["MMR","MYANMAR","BURMA","缅甸","YANGON"] },
  { cn: "孟加拉国(BGD)",   iso2: "BD", keys: ["BGD","BANGLADESH","孟加拉","CHITTAGONG","CHATTOGRAM"] },
  { cn: "柬埔寨(KHM)",     iso2: "KH", keys: ["KHM","CAMBODIA","柬埔寨","SIHANOUKVILLE"] },
  { cn: "沙特阿拉伯(SAU)", iso2: "SA", keys: ["SAU","SAUDI","沙特","JEDDAH","DAMMAM"] },
  { cn: "西班牙(ESP)",     iso2: "ES", keys: ["ESP","SPAIN","ESPANA","ESPAÑA","西班牙","BARCELONA","VALENCIA"] },
  { cn: "智利(CHL)",       iso2: "CL", keys: ["CHL","CHILE","智利","VALPARAISO","SAN ANTONIO"] },
  { cn: "日本(JPN)",       iso2: "JP", keys: ["JPN","JAPAN","日本","TOKYO","OSAKA","YOKOHAMA"] },
  { cn: "韩国(KOR)",       iso2: "KR", keys: ["KOR","KOREA","韩国","BUSAN","INCHEON"] },
  { cn: "美国(USA)",       iso2: "US", keys: ["USA","UNITED STATES","美国","LOS ANGELES","LONG BEACH","NEW YORK"] },
  { cn: "澳大利亚(AUS)",   iso2: "AU", keys: ["AUS","AUSTRALIA","澳大利亚","SYDNEY","MELBOURNE"] },
];
export function countryFromPod(pod) {
  var s = clean(pod).toUpperCase();
  if (!s) return "";
  // ① ISO2 精确匹配（"MY" 这种，必须整串相等，否则会被别的词误伤）
  for (var a = 0; a < _COUNTRY_TABLE.length; a++) {
    if (s === _COUNTRY_TABLE[a].iso2) return _COUNTRY_TABLE[a].cn;
  }
  // ② 关键词包含匹配
  for (var b = 0; b < _COUNTRY_TABLE.length; b++) {
    var ks = _COUNTRY_TABLE[b].keys;
    for (var c = 0; c < ks.length; c++) if (s.includes(ks[c])) return _COUNTRY_TABLE[b].cn;
  }
  return clean(pod);   // 认不出来原样返回：宁可人看出来不对，也不猜
}

export function sellerLabel(name, company) {
  var n = clean(name || company?.name_cn || company?.name_en);
  var uscc = clean(company?.tax_id || company?.registration_no || company?.uscc);
  if (uscc && n) return uscc + " " + n;
  return n;
}

export function firstOrderValue(orders, field, rawField) {
  for (var i = 0; i < orders.length; i++) {
    var raw = parseRaw(orders[i].raw);
    var v = pick(orders[i][field], rawField ? raw[rawField] : "");
    if (v) return v;
  }
  return "";
}

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
  var r = await pool.query(
    `WITH product_one AS (
       SELECT DISTINCT ON (sku)
              sku, hs_code, declaration_name, declaration_elements
       FROM products
       WHERE NULLIF(btrim(sku), '') IS NOT NULL
       ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
     ),
     keyed AS (
       SELECT
         NULLIF(btrim(COALESCE(oli.hs_code, p.hs_code, '')), '') AS hs_code,
         COALESCE(NULLIF(btrim(oli.declaration_name), ''), NULLIF(btrim(p.declaration_name), ''), NULLIF(btrim(oli.product_name), '')) AS declaration_name,
         NULLIF(btrim(p.declaration_elements), '') AS declaration_elements,
         oli.qty_ctn,
         oli.nw_ctn, oli.gw_ctn,
         oli.unit_price,
         oli.subtotal
       FROM order_line_items oli
       LEFT JOIN product_one p ON p.sku = oli.sku
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
       CASE WHEN SUM(k.qty_ctn) > 0 THEN ROUND(SUM(k.subtotal)::numeric / SUM(k.qty_ctn)::numeric, 5)
            ELSE MIN(k.unit_price) END AS unit_price,
       SUM(k.subtotal) AS total_amount
     FROM keyed k
     LEFT JOIN hs_elements h ON h.hs_code IS NOT DISTINCT FROM k.hs_code
     LEFT JOIN name_by_hs n ON n.hs_code IS NOT DISTINCT FROM k.hs_code
     GROUP BY k.hs_code, n.dominant_name
     ORDER BY hs_code`,
    [orderIds]
  );
  return r.rows;
}

export function cell(label, value, cls, field) {
  var fa = field ? ` data-field="${field}"` : "";
  return `<div class="cell ${cls || ""}"><div class="lbl">${esc(label)}</div><div class="val"${fa}>${blank(value)}</div></div>`;
}

export function bigCell(label, value, field) {
  var fa = field ? ` data-field="${field}"` : "";
  return `<div class="cell wide"><div class="lbl">${esc(label)}</div><div class="val"${fa}>${blank(value)}</div></div>`;
}

// 报关单「商品名称及规格型号」栏的申报要素写法(2026-08-08 对照真实海关单修正)
// 实样(海关出的 COAU9506731780 膨润土猫砂):
//   膨润土猫砂
//   0|1|宠物清洁用|蒙脱石70%-80%,水10%,二氧化硅5%-15%|15.6KG/BAG|无中文或外文品牌|无型号
// → 只写【值】,用 | 分隔,**不写"1:品牌类型:"这种序号和标签**。
// 我们库里 products.declaration_elements 是带标签存的(便于人看/校验),
// 印到报关单上必须剥掉标签。Damon 2026-08-08:「猫砂下面没有写这些的」。
export function declElementsForCustoms(v) {
  var raw = clean(v);
  if (!raw) return "";
  return raw.split("|").map(function (part) {
    var t = String(part || "").trim();
    if (!t) return "";
    // 形如 "3:用途:宠物用猫砂" → 取最后一段值; 值里含冒号的(如 "成分:A:B")只剥前两段
    var m = /^\s*\d+\s*:\s*[^:]+?\s*:\s*([\s\S]*)$/.exec(t);
    if (m) return m[1].trim();
    // 形如 "用途:宠物用猫砂"(无序号)
    var m2 = /^\s*[^:：]{1,12}\s*[:：]\s*([\s\S]*)$/.exec(t);
    if (m2 && /品牌|用途|成分|型号|规格|享惠|类型|等级|种类|包装/.test(t.split(/[:：]/)[0])) return m2[1].trim();
    return t;
  }).filter(Boolean).join("|");
}

export function cargoRows(lines, destination, sourceArea) {
  if (!lines.length) {
    return `<tr><td colspan="9" class="empty-row">无货物明细</td></tr>`;
  }
  // 2026-07-06: SQL已按hs_code唯一分组(见loadLines name_by_hs),每行天然对应唯一HS,不再需要按HS去重申报要素
  // (旧逻辑按"见过的HS"清空后续行文字,同HS下不同品名如"宠物罐头/宠物软罐头"被误判成重复行,第二行整段申报要素被清空——已改成SQL层合并解决)
  return lines.map(function (l, i) {
    var qty = [
      // 2026-08-04: 原为 0 位小数，71,354.40→71354，与箱单/汇总栏对不上(报关行据此报"不一样")。
      // 件数保持整数(箱/袋本就是整数)，重量一律两位。
      fmtM(l.net_weight_kg, 2) ? fmtM(l.net_weight_kg, 2) + "千克" : "",
      fmtInt(l.qty_ctn) ? fmtInt(l.qty_ctn) + "箱" : "",
    ].filter(Boolean).join("<br>");
    // 单价精度: 两位能精确表示就两位(55.30), 否则最多5位并去尾零(56.155), 保证 单价×数量=总价
    var _upn = Number(l.unit_price);
    var _up = !Number.isFinite(_upn) ? "" :
      (Math.abs(Number(_upn.toFixed(2)) - _upn) < 1e-9
        ? fmtM(_upn, 2)
        : _upn.toFixed(5).replace(/0+$/, "").replace(/\.$/, ""));
    var money = [
      _up,
      fmtM(l.total_amount, 2),
      "人民币",
    ].filter(Boolean).join("<br>");
    var elements = declElementsForCustoms(l.declaration_elements);
    var name = [clean(l.declaration_name), elements].filter(Boolean).map(esc).join("<br>");
    return `<tr>
      <td data-field="item_no" data-row="${i}">${i + 1}</td>
      <td data-field="hs_code" data-row="${i}">${blank(l.hs_code)}</td>
      <td class="goods-name" data-field="goods_name" data-row="${i}">${name || '<span class="empty">—</span>'}</td>
      <td data-field="qty_unit" data-row="${i}">${qty || '<span class="empty">—</span>'}</td>
      <td data-field="price_amount_currency" data-row="${i}">${money || '<span class="empty">—</span>'}</td>
      <td data-field="origin_country" data-row="${i}">中国(CHN)</td>
      <td data-field="dest_country" data-row="${i}">${blank(destination)}</td>
      <td data-field="source_area" data-row="${i}">${sourceArea ? esc(sourceArea) : '<span class="empty">—</span>'}</td>
      <td data-field="levy_exempt" data-row="${i}">照章征税</td>
    </tr>`;
  }).join("");
}

export function sumOrderMetric(orders, fields, rawFields) {
  return orders.reduce(function (sum, o) {
    var raw = parseRaw(o.raw);
    var v = "";
    for (var i = 0; i < fields.length && v === ""; i++) v = pick(o[fields[i]]);
    for (var j = 0; j < rawFields.length && v === ""; j++) v = pick(raw[rawFields[j]]);
    var n = Number(v);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

export async function loadContainersForBl(pool, plan) {
  try {
    var out = [];
    var raw = parseRaw(plan.raw);
    var blNo = clean(pick(plan.bl_no, raw.blNo, raw.bl_no));
    var pushList = function (v) {
      String(v == null ? "" : v).split(/[,/;\s]+/).forEach(function (c) {
        c = clean(c); if (c && out.indexOf(c) < 0) out.push(c);
      });
    };
    if (blNo) {
      try {
        var r0 = await pool.query(
          `SELECT DISTINCT btrim(c.container_no) AS c
             FROM order_containers oc
             JOIN containers c ON c.id = oc.container_id
             LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id
             JOIN orders o ON o.id = oc.order_id
            WHERE (sg.bl_master = $1 OR o.bl_no = $1 OR o.raw->>'blNo' = $1 OR o.raw->>'bl_no' = $1)
              AND NULLIF(btrim(c.container_no), '') IS NOT NULL
            ORDER BY btrim(c.container_no)`,
          [blNo]
        );
        r0.rows.forEach(function (x) { pushList(x.c); });
      } catch (e) {}
    }
    try {
      var r1 = await pool.query(
        "SELECT DISTINCT btrim(container_no) AS c FROM container_bookings WHERE shipping_plan_id = $1 OR ($2 <> '' AND btrim(bl_no) = $2)",
        [plan.id, blNo]);
      r1.rows.forEach(function (x) { pushList(x.c); });
    } catch (e) {}
    if (blNo) {
      try {
        var r2 = await pool.query("SELECT container_no FROM shipping_plans WHERE btrim(bl_no) = $1", [blNo]);
        r2.rows.forEach(function (x) { pushList(x.container_no); });
      } catch (e) {}
    }
    pushList(plan.container_no);
    return out;
  } catch (e) { return []; }
}
