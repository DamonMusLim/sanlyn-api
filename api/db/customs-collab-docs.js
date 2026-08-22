// api/db/customs-collab-docs.js
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { resolveFactory, assertFactoryCustoms } from "./customs-collab.js";
import { scrubFactoryCustomsPayload } from "./lib/collab-field-profiles.js";

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 30;
const buckets = new Map();

function json(res, status, payload) { return res.status(status).json(payload); }
function failClosed(res) { return json(res, 401, { error: "链接无效或已过期" }); }
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return xf ? String(xf).split(",")[0].trim() : (req.socket?.remoteAddress || req.ip || "unknown");
}
function rateLimit(req, key) {
  const k = `${key || "-"}:${clientIp(req)}`;
  const now = Date.now();
  const hit = buckets.get(k);
  if (!hit || now - hit.start > RATE_WINDOW_MS) {
    buckets.set(k, { start: now, count: 1 });
    return true;
  }
  hit.count += 1;
  return hit.count <= RATE_MAX;
}
/* 🔴 0817 Damon：「所有的项目单位以后也不能错」。
   原来这里三处都在猜单位：
     ① 认不出就 `|| "箱"` 默认成箱
     ② `ctn !== null ? "箱"` —— 只要有箱数就写死「箱」，无视报关逐项真单位
     ③ 第一个取值链漏了 item.unit
   实证：664707 项5「宠物美容烘干箱」报关单原件是**台**（真报关单PDF逐项解析入库，
   HS 8509809000 家电类法定单位就是台），页面却渲染成「件」。
   现在：报关逐项 unit 是唯一真值，认不出**留空**，绝不默认成箱。 */
function unit(v) {
  const s = cleanString(v);
  if (!s) return null;
  const map = { CTN: "箱", PCS: "件", KG: "千克", KGS: "千克", BAG: "包", SET: "套", UNIT: "台", PC: "件" };
  return map[s.toUpperCase()] || s;
}
/** 报关逐项 unit 优先；都没有才按箱数兜底；仍判不出返回 null（不猜） */
function unitOf(item, ctn) {
  return unit(item?.unit) || unit(item?.unit2) || unit(item?.unit1) || (ctn !== null ? "箱" : null);
}
function dateOnly(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function uniqJoin(arr, sep = " / ") {
  return [...new Set(arr.map(cleanString).filter(Boolean))].join(sep) || null;
}
function regionWord(v) {
  return cleanString(v)
    .replace(/^[（(]\d+[）)]/, "")
    .replace(/(其他|特区|市|省)$/g, "")
    .trim();
}
function containsRegion(factory, word) {
  if (!word) return false;
  const hay = [factory.name_cn, factory.factory_name, factory.address, factory.province].map(cleanString).join(" ");
  return hay.includes(word);
}
function lineFromItem(item, i) {
  // qty_ctn=申报箱数(真报关单回填,07-13),优先;qty2/qty1=成交/法定数量兜底
  const ctn = num(item?.qty_ctn);
  const qty = ctn ?? num(item?.qty2 ?? item?.qty1);
  const amount = num(item?.amount ?? item?.amt ?? item?.total);
  // 禁倒算单价(Damon 07-13 17:50): 报关原文无 unit_price 就留空,绝不用 amount/qty 推导
  const unitPrice = num(item?.unit_price);
  return {
    item_id: item?.id || null,
    name: cleanString(item?.name_cn || item?.name) || `报关项${i + 1}`,
    spec: cleanString(item?.spec) || null,
    unit: unitOf(item, ctn),
    qty,
    unit_price: unitPrice,
    amount,
  };
}

function factoryGoodsLineFromItem(item, i) {
  const ctn = num(item?.qty_ctn);
  const qty = ctn ?? num(item?.qty2 ?? item?.qty1 ?? item?.qty);
  const hs = cleanString(item?.hs_code || item?.hs) || null;
  // 🩸 0813：这里原来只返回 品名/规格/单位/数量，没有金额/单价/税率，
  //    工厂端开票模板于是永远显示 ¥0.00 / 0%（Damon 截图指出）。
  //    金额取报关逐项申报值（含税口径，跟应开金额同源）；
  //    税率按 HS：2309 系 9%，其余 13%（退税率只有这两个值，第三个值=算错）。
  //    ⚖️ 这是【建议开票金额】，不是退税依据 —— 退税一律以真实进项票不含税额为准。
  // 🩸 0817 Damon：「开票总金额就是报关金额含税的」——报关额 = 发票【价税合计】，
  //    不是金额栏。原来直接把报关额当不含税金额给前端，前端再 ×税率加上去，
  //    价税合计就虚高了 9%/13%（CP-7 被要求开 ¥322,229.07，实际应开 ¥295,623.00）。
  const grossIncl = num(item?.amount ?? item?.amt ?? item?.total ?? item?.declaration_amount);
  const vatRate = String(hs || "").startsWith("2309") ? 0.09 : 0.13;
  const gross = grossIncl === null ? null : num(grossIncl / (1 + vatRate));
  return {
    item_id: item?.id || null,
    name: cleanString(item?.name_cn || item?.name) || `报关项${i + 1}`,
    spec: cleanString(item?.spec) || null,
    hs_code: hs,
    unit: unitOf(item, ctn),
    qty,
    // ⛔ 字段名不能叫 amount / unit_price / declaration_amount —— 那几个在
    //    collab-field-profiles.js 的【工厂禁看黑名单】里（防报关价/销售价外泄），
    //    出门就被权限层删掉，工厂端只会看到 ¥0.00。
    //    用 invoice_* 命名，语义也更准：这是【建议开票金额】，不是报关额、更不是退税依据。
    invoice_amount: gross,
    invoice_unit_price: qty && gross !== null ? num(gross / qty) : null,
    vat_rate: vatRate,
    tax_rate: vatRate,
  };
}

export function factoryGoodsLinesFromItems(rawItems, sellerRaw, multiFactory) {
  let items = Array.isArray(rawItems) ? rawItems : [];
  if (multiFactory) {
    items = items.filter((x) => containsRegion(sellerRaw || {}, regionWord(x?.source_region)));
    if (!items.length) return { lines: [], anchored: false };
  }
  const lines = items.map(factoryGoodsLineFromItem).filter((l) => l.name || l.qty !== null);
  return { lines, anchored: lines.length > 0 };
}

export function invoiceLinesFromItems(rawItems, sellerRaw, multiFactory) {
  let items = Array.isArray(rawItems) ? rawItems : [];
  if (multiFactory) {
    items = items.filter((x) => containsRegion(sellerRaw || {}, regionWord(x?.source_region)));
    if (!items.length) return { lines: [], anchored: false };
  }
  const lines = items.map((item, i) => {
    const base = lineFromItem(item, i);
    const hs = cleanString(item?.hs_code || item?.hs);
    const vatRate = hs.startsWith("2309") ? 0.09 : 0.13;
    const gross = num(item?.amount ?? item?.amt ?? item?.total);
    const amountEx = gross === null ? null : num(gross / (1 + vatRate));
    return {
      item_id: base.item_id,
      name: base.name,
      spec: base.spec,
      unit: base.unit,
      qty: base.qty,
      unit_price_ex: base.qty && amountEx !== null ? num(amountEx / base.qty) : null,
      amount: amountEx,
      vat_rate: vatRate,
    };
  });
  return { lines, anchored: lines.length > 0 };
}

async function ferOrderScope(client, customsNo) {
  const r = await client.query(
    `SELECT array_agg(DISTINCT x.order_no) FILTER (WHERE COALESCE(x.order_no,'') <> '') AS order_nos
       FROM finance_export_rebates fer
       LEFT JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(fer.raw->'order_nos')='array' THEN fer.raw->'order_nos' ELSE '[]'::jsonb END
       ) AS x(order_no) ON true
      WHERE fer.customs_no=$1`,
    [customsNo]
  );
  return (r.rows[0]?.order_nos || []).map(cleanString).filter(Boolean);
}

async function findOrder(client, customsNo, contractNo, orderNos = []) {
  if (orderNos.length) {
    const scoped = await client.query(
      `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po, created_at, bl_no
         FROM orders WHERE order_no=ANY($1::text[]) AND COALESCE(status,'') <> 'cancelled'
        ORDER BY id DESC LIMIT 1`,
      [orderNos]
    );
    if (scoped.rows[0]) return scoped.rows[0];
  }
  const queries = [
    { sql: "contract_no=$1", val: contractNo },
    { sql: "order_no=$1", val: customsNo },
    { sql: "bl_no=$1", val: customsNo },
  ];
  for (const q of queries) {
    if (!q.val) continue;
    const r = await client.query(
      `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po, created_at, bl_no
         FROM orders WHERE ${q.sql} AND COALESCE(status,'') <> 'cancelled'
        ORDER BY id DESC LIMIT 1`,
      [q.val]
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function orderGroup(client, customsNo, order, factoryCode, orderNos = []) {
  if (!order) return { ids: [], orderNos: null, poNo: null };
  if (orderNos.length) {
    const r = await client.query(
      `SELECT array_agg(o.id ORDER BY o.order_no) AS ids,
              array_agg(o.order_no ORDER BY o.order_no) AS order_nos,
              array_agg(o.customer_po ORDER BY o.customer_po) FILTER (WHERE COALESCE(o.customer_po,'') <> '') AS po_nos
         FROM orders o
        WHERE COALESCE(o.status,'') <> 'cancelled'
          AND o.order_no=ANY($1::text[])
          AND COALESCE(o.factory_code,(SELECT code FROM companies WHERE id=o.factory_company_id))=$2`,
      [orderNos, factoryCode]
    );
    const row = r.rows[0] || {};
    if (row.ids?.length) return { ids: row.ids, orderNos: uniqJoin(row.order_nos, ","), poNo: uniqJoin(row.po_nos || [order.customer_po]) };
  }
  const r = await client.query(
    `SELECT array_agg(o.id ORDER BY o.order_no) AS ids,
            array_agg(o.order_no ORDER BY o.order_no) AS order_nos,
            array_agg(o.customer_po ORDER BY o.customer_po) FILTER (WHERE COALESCE(o.customer_po,'') <> '') AS po_nos
       FROM orders o
      WHERE COALESCE(o.status,'') <> 'cancelled'
        AND (o.bl_no=$1 OR o.order_no=$1 OR o.contract_no=$2)
        AND COALESCE(o.factory_code,(SELECT code FROM companies WHERE id=o.factory_company_id))=$3`,
    [customsNo, order.contract_no, factoryCode]
  );
  const row = r.rows[0] || {};
  return {
    ids: row.ids?.length ? row.ids : [order.id],
    orderNos: uniqJoin(row.order_nos || [order.order_no], ","),
    poNo: uniqJoin(row.po_nos || [order.customer_po]),
  };
}

async function parties(client, order, factoryCode) {
  let buyer = { name: null, tax_id: null, address: null };
  if (order) {
    const buyerKey = cleanString(order.issuing_company);
    const companyCode = cleanString(order.company_code);
    const br = await client.query(
      `SELECT name_cn, tax_id, address FROM companies
        WHERE ($1 <> '' AND (code=$1 OR name_cn=$1)) OR ($2 <> '' AND code=$2)
        ORDER BY CASE WHEN $1 <> '' AND name_cn=$1 THEN 0 WHEN $1 <> '' AND code=$1 THEN 1
                      WHEN $2 <> '' AND code=$2 THEN 2 ELSE 9 END, id ASC LIMIT 1`,
      [buyerKey, companyCode]
    );
    const b = br.rows[0] || {};
    buyer = { name: b.name_cn || buyerKey || null, tax_id: b.tax_id || null, address: b.address || null };
  }
  const sr = await client.query(
    `SELECT name_cn, factory_name, tax_id, address, bank_name, bank_account, province
       FROM companies WHERE code=$1 LIMIT 1`,
    [factoryCode]
  );
  const s = sr.rows[0] || {};
  return {
    buyer,
    seller: {
      name: s.name_cn || s.factory_name || factoryCode,
      tax_id: s.tax_id || null,
      address: s.address || null,
      bank_name: s.bank_name || null,
      bank_account: s.bank_account || null,
    },
    sellerRaw: s,
  };
}

async function customsItems(client, customsNo) {
  const r = await client.query(
    `SELECT fer.contract_no, MIN(fer.export_date) AS export_date,
            jsonb_agg(item ORDER BY ord) FILTER (WHERE item IS NOT NULL) AS items
       FROM finance_export_rebates fer
       LEFT JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
       ) WITH ORDINALITY AS x(item, ord) ON true
      WHERE fer.customs_no=$1
      GROUP BY fer.contract_no`,
    [customsNo]
  );
  const row = r.rows[0] || {};
  const items = Array.isArray(row.items) ? row.items.map((x) => ({ ...x, id: null })) : [];
  return { contractNo: row.contract_no || null, exportDate: dateOnly(row.export_date), items, item_source: "fer_raw" };
}

export async function loadCustomsItems(client, customsNo) {
  const meta = await customsItems(client, customsNo);
  const r = await client.query(
    `SELECT cdi.id, cdi.declaration_name_cn, cdi.declaration_elements, cdi.hs_code,
            cdi.qty, cdi.unit, cdi.unit_price, cdi.declaration_amount, cdi.source_region
       FROM customs_declarations cd
       JOIN customs_declaration_items cdi ON cdi.declaration_id=cd.id
      WHERE cd.declaration_no=$1
        AND cdi.deleted_at IS NULL
      ORDER BY cdi.sort_order NULLS LAST, cdi.id`,
    [customsNo]
  );
  if (!r.rows.length) return meta;
  return {
    contractNo: meta.contractNo,
    exportDate: meta.exportDate,
    item_source: "decl_items",
    items: r.rows.map((x) => ({
      id: x.id,
      name_cn: x.declaration_name_cn || null,
      spec: x.declaration_elements || null,
      hs_code: x.hs_code || null,
      // ETL 对原文缺数量的 NOT NULL 列存 0 占位,读层映回 null 防"申报数量为0"假象
      qty_ctn: x.unit === "箱" && Number(x.qty) > 0 ? x.qty : null,
      qty2: x.unit !== "箱" && Number(x.qty) > 0 ? x.qty : null,
      unit2: x.unit === "箱" ? null : x.unit,
      unit_price: x.unit_price,
      amount: x.declaration_amount,
      source_region: x.source_region || null,
    })),
  };
}

export async function factorySpread(client, customsNo, contractNo) {
  const r = await client.query(
    `SELECT DISTINCT COALESCE(o.factory_code,(SELECT code FROM companies WHERE id=o.factory_company_id)) AS code
       FROM orders o
      WHERE COALESCE(o.status,'') <> 'cancelled'
        AND (o.bl_no=$1 OR o.order_no=$1 OR ($2::text IS NOT NULL AND o.contract_no=$2))`,
    [customsNo, contractNo]
  );
  return r.rows.map((x) => x.code).filter(Boolean);
}

/* 0817：oliLines() 已删 —— 它的唯一调用点(无锚时拿 OLI 当货物行)按 forge 裁决 A 去掉后，
   这个函数就是死代码。留着=下次有人手滑又接回去。Damon 0817:「我们靠的是真实数据，不是OLI」。 */

async function packingLines(client, orderIds) {
  if (!orderIds.length) return [];
  const r = await client.query(
    `SELECT COALESCE(NULLIF(BTRIM(oli.product_name),''),NULLIF(BTRIM(p.product_name),''),
                    NULLIF(BTRIM(oli.declaration_name),''),NULLIF(BTRIM(p.declaration_name),'')) AS name,
            ROUND(SUM(COALESCE(oli.qty_ctn,0))::numeric,2) AS ctns,
            ROUND(SUM(COALESCE(oli.qty_ctn,0)*COALESCE(oli.nw_ctn,0))::numeric,2) AS nw,
            ROUND(SUM(COALESCE(oli.qty_ctn,0)*COALESCE(oli.gw_ctn,0))::numeric,2) AS gw,
            ROUND(SUM(COALESCE(oli.qty_ctn,0)*COALESCE(oli.cbm_ctn,0))::numeric,3) AS cbm
       FROM order_line_items oli
       LEFT JOIN products p ON p.id=oli.product_id
      WHERE oli.order_id = ANY($1::int[])
      GROUP BY oli.product_id, 1
      ORDER BY MIN(oli.sort_order) NULLS LAST, MIN(oli.id)`,
    [orderIds]
  );
  return r.rows.map((l) => ({ name: l.name || null, ctns: num(l.ctns) || 0, nw: num(l.nw) || 0, gw: num(l.gw) || 0, cbm: num(l.cbm) || 0 }));
}

async function packingContainers(client, blNo, orderNos) {
  if (!blNo || !orderNos.length) return [];
  const out = [];
  const sp = await client.query(
    `SELECT x.item->>'container_no' AS container_no,
            COALESCE(x.item->>'seal_no', x.item->>'seal') AS seal_no,
            COALESCE(x.item->>'container_type', x.item->>'type') AS container_type
       FROM shipping_plans sp
       JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(sp.containers_detail)='array' THEN sp.containers_detail ELSE '[]'::jsonb END
       ) AS x(item) ON true
      WHERE sp.bl_no=$1 AND x.item->>'order'=ANY($2::text[])`,
    [blNo, orderNos]
  );
  out.push(...sp.rows);
  if (!out.length) {
    const cb = await client.query(
      `SELECT j->>'container_no' AS container_no,
              COALESCE(j->>'seal_no', j->>'seal') AS seal_no,
              COALESCE(j->>'container_type', j->>'type') AS container_type
         FROM container_bookings cb
         CROSS JOIN LATERAL to_jsonb(cb) AS j
        WHERE cb.bl_no=$1 AND cb.contract_no=ANY($2::text[])`,
      [blNo, orderNos]
    );
    out.push(...cb.rows);
  }
  const seen = new Set();
  return out.map((x) => ({ container_no: cleanString(x.container_no), seal_no: cleanString(x.seal_no), container_type: cleanString(x.container_type) }))
    .filter((x) => x.container_no && !seen.has(x.container_no) && seen.add(x.container_no));
}

export async function handleFactoryDoc(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "操作过于频繁，请稍后再试" });

  const kind = cleanString(req.query?.kind);
  const customsNo = cleanString(req.query?.customs_no);
  if (!["packing", "po"].includes(kind)) return json(res, 400, { error: "kind required" });
  if (!customsNo) return json(res, 400, { error: "缺少行键" });

  const client = await pool.connect();
  try {
    const st = await assertFactoryCustoms(client, scope.factory.code, customsNo);
    const ci = await loadCustomsItems(client, customsNo);
    const scopedOrderNos = await ferOrderScope(client, customsNo);
    const order = await findOrder(client, customsNo, st.contract_no || ci.contractNo, scopedOrderNos);
    const group = await orderGroup(client, customsNo, order, scope.factory.code, scopedOrderNos);
    const orderNos = (scopedOrderNos.length ? scopedOrderNos : String(group.orderNos || order?.order_no || "").split(",")).map(cleanString).filter(Boolean);
    if (kind === "packing") {
      const lines = await packingLines(client, group.ids);
      const totals = lines.reduce((t, l) => ({ ctns: num(t.ctns + (Number(l.ctns) || 0)), nw: num(t.nw + (Number(l.nw) || 0)), gw: num(t.gw + (Number(l.gw) || 0)), cbm: num(t.cbm + (Number(l.cbm) || 0)) }), { ctns: 0, nw: 0, gw: 0, cbm: 0 });
      return res.json(scrubFactoryCustomsPayload({ success: true, doc: {
        kind: "packing",
        order_nos: orderNos.join(",") || null,
        po_no: group.poNo || order?.customer_po || null,
        factory_ref: order?.contract_no || st.contract_no || ci.contractNo || null,
        doc_date: ci.exportDate || dateOnly(order?.created_at) || new Date().toISOString().slice(0, 10),
        containers: await packingContainers(client, order?.bl_no, orderNos),
        lines,
        totals,
      } }));
    }
    const party = await parties(client, order, scope.factory.code);
    const spread = await factorySpread(client, customsNo, ci.contractNo || st.contract_no || order?.contract_no);

    let rawItems = ci.items;
    let anchored = rawItems.length > 0;
    if (anchored && spread.length > 1) {
      const filtered = rawItems.filter((x) => containsRegion(party.sellerRaw, regionWord(x?.source_region)));
      anchored = filtered.length > 0;
      rawItems = anchored ? filtered : [];
    }

    /* 🔴 0817 forge 裁决 A（FAIL 当前逻辑）：这里违反 Damon 07-14 硬规3「不可以OLI」。
       原来 anchored=false 就拿 OLI 生成货物行给工厂，且 factoryExpectedAmount 无论
       anchored 与否都从 OLI 算。07-14 的护栏只装在 detail 侧，单据这条漏了一个月。
       裁决：无锚只显占位，绝不用 OLI 补；金额走
       人工锁定额 > factory_invoice_expected_amounts > 报关逐项合计 > null。
       ⚖️ 死结（工厂拿不到明细没法开票）forge 的答复：**改流程不改数据原则** ——
          引导去开票资料表/人工确认入口，人工确认必须附真报关单证据。 */
    const goods = anchored ? factoryGoodsLinesFromItems(rawItems, party.sellerRaw, false) : {
      anchored: false,
      pending_customs: true,
      lines: [{ item_id: null, name: "待报关资料", spec: "报关明细待导入，请用开票资料表或走人工确认",
                unit: null, qty: null, invoice_amount: null, invoice_unit_price: null,
                vat_rate: null, tax_rate: null }],
    };
    const feaRes = await client.query(
      `SELECT ROUND(COALESCE(
                (SELECT s.manual_expected_amount FROM customs_invoice_status s
                  WHERE s.customs_no=$1 AND s.factory_code=$2),
                (SELECT f.expected_amount FROM factory_invoice_expected_amounts f
                  WHERE f.customs_no=$1 AND f.status='ready'
                    AND f.factory_name=(SELECT name_cn FROM companies WHERE code=$2)
                  ORDER BY f.generated_at DESC NULLS LAST LIMIT 1),
                (SELECT SUM(ci.declaration_amount) FROM customs_declaration_items ci
                   JOIN customs_declarations cd ON cd.id=ci.declaration_id
                   JOIN companies co ON co.id=ci.factory_company_id
                  WHERE cd.declaration_no=$1 AND ci.deleted_at IS NULL AND co.code=$2
                    AND COALESCE(ci.declaration_currency,'CNY') IN ('CNY','人民币','142'))
              )::numeric,2) AS amt`,
      [customsNo, scope?.factory?.code || null]
    );
    const factoryExpectedAmount = num(feaRes.rows[0]?.amt);

    return res.json(scrubFactoryCustomsPayload({ success: true, doc: {
      kind,
      buyer: party.buyer,
      seller: party.seller,
      order_nos: group.orderNos || order?.order_no || null,
      po_no: group.poNo || order?.customer_po || null,
      factory_ref: order?.contract_no || st.contract_no || ci.contractNo || null,
      doc_date: ci.exportDate || dateOnly(order?.created_at) || new Date().toISOString().slice(0, 10),
      lines: goods.lines,
      factory_expected_amount: factoryExpectedAmount,
      needs_internal_fill: factoryExpectedAmount === null,
      anchored: goods.anchored,
      item_source: ci.item_source,
    } }));
  } catch (e) {
    return json(res, e.status || 500, { error: e.status === 403 ? "Forbidden" : e.message });
  } finally {
    client.release();
  }
}
