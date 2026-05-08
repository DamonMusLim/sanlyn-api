// customs-summary.js
// 分类报关汇总 — 按 declaration_name 归并多订单的 CTN/NW/GW/CBM
//
// POST /api/db/customs-summary
// Body: { order_nos: ["FS2026...", "XM-264", ...] }
//
// GET  /api/db/customs-summary?order_no=FS2026...   (单订单快捷)
//
// Returns:
// {
//   success: true,
//   rows: [{ declaration_name, ctn, nw_kg, gw_kg, cbm }],
//   total: { ctn, nw_kg, gw_kg, cbm },
//   missing_weight: ["SKU1", ...],   // 有 SKU 但无重量的行，需要人工补
//   orders_found: 3,
//   orders_missing: ["XM-999"],      // 查不到的订单号
// }

import { getPool, setCors } from "../db.js";

// 报关品名合并规则 — 数据库已有历史污染品名，统一归并到标准名
const MERGE_MAP = {
  "喂食器":     "宠物喂食器",
  "宠物喂水器": "宠物喂食器",
  "喂水器":     "宠物喂食器",
  "喂水喂食器": "宠物喂食器",
};

function normalize(name) {
  if (!name) return "其他";
  return MERGE_MAP[name.trim()] || name.trim();
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "GET or POST only" });

  const pool = getPool();

  // 解析订单号列表
  let orderNos = [];
  if (req.method === "POST") {
    const body = req.body || {};
    if (Array.isArray(body.order_nos)) orderNos = body.order_nos.map(String).filter(Boolean);
    else if (body.order_no) orderNos = [String(body.order_no)];
  } else {
    const q = req.query.order_no || req.query.order_nos || "";
    orderNos = q.split(",").map(s => s.trim()).filter(Boolean);
  }

  if (!orderNos.length)
    return res.status(400).json({ success: false, error: "order_nos is required" });

  try {
    // 1. 拉订单
    const { rows: orders } = await pool.query(
      `SELECT order_no, contract_no, products, raw
       FROM orders
       WHERE order_no = ANY($1) OR contract_no = ANY($1)`,
      [orderNos]
    );

    const foundNos = new Set([
      ...orders.map(o => o.order_no),
      ...orders.map(o => o.contract_no).filter(Boolean),
    ]);
    const ordersMissing = orderNos.filter(n => !foundNos.has(n));

    // 2. 展开 products JSONB，解析每行数据
    const lines = [];
    const allSkus = new Set();

    for (const ord of orders) {
      const items = Array.isArray(ord.products) ? ord.products
                  : Array.isArray(ord.raw?.products) ? ord.raw.products
                  : Array.isArray(ord.raw?.items) ? ord.raw.items
                  : [];

      for (const item of items) {
        const qty   = parseFloat(item.qty   || item.boxes || 0);
        const cbm   = parseFloat(item.cbm   || 0);
        // NW/GW 是每 CTN 值，须乘以 qty
        const nwPer = parseFloat(item.netWeight || item.net_weight || item.nw || 0);
        const gwPer = parseFloat(item.grossWeight || item.gross_weight || item.gw || 0);
        const sku   = item.sku || item.SKU || null;
        // 品名来源优先级：declaration_name > category > name_cn > name
        const rawDecl = item.declaration_name || item.category || item.name_cn || item.name || null;

        if (sku) allSkus.add(sku);

        lines.push({
          sku,
          rawDecl,        // 先存原始，后面再 JOIN 产品表覆盖
          qty,
          cbm,            // 行合计
          nwPer,          // 每 CTN
          gwPer,          // 每 CTN
          hasWeight: nwPer > 0 || gwPer > 0,
        });
      }
    }

    // 3. JOIN 产品表 — 用 SKU 取 declaration_name，覆盖 JSONB 里的品名
    let skuDeclMap = {};
    if (allSkus.size > 0) {
      const { rows: prods } = await pool.query(
        `SELECT sku, declaration_name, net_weight, gross_weight
         FROM products WHERE sku = ANY($1)`,
        [[...allSkus]]
      );
      for (const p of prods) {
        skuDeclMap[p.sku] = {
          decl:   p.declaration_name || null,
          nwPer:  parseFloat(p.net_weight  || 0),
          gwPer:  parseFloat(p.gross_weight || 0),
        };
      }
    }

    // 4. 归并
    const buckets = {};   // declaration_name → { ctn, nw_kg, gw_kg, cbm }
    const missingWeight = [];

    for (const line of lines) {
      // 品名：有 SKU 优先从产品表拿，否则用 JSONB 原始品名
      let declRaw = line.rawDecl;
      let nwPer   = line.nwPer;
      let gwPer   = line.gwPer;

      if (line.sku && skuDeclMap[line.sku]) {
        const pInfo = skuDeclMap[line.sku];
        if (pInfo.decl) declRaw = pInfo.decl;
        // 产品表权重优先（更精确），但 JSONB 里有的话保留 JSONB
        if (!nwPer && pInfo.nwPer) nwPer = pInfo.nwPer;
        if (!gwPer && pInfo.gwPer) gwPer = pInfo.gwPer;
      }

      const decl = normalize(declRaw);
      const totalNw = parseFloat((nwPer * line.qty).toFixed(2));
      const totalGw = parseFloat((gwPer * line.qty).toFixed(2));

      if (!buckets[decl]) buckets[decl] = { ctn: 0, nw_kg: 0, gw_kg: 0, cbm: 0 };
      buckets[decl].ctn   += line.qty;
      buckets[decl].nw_kg += totalNw;
      buckets[decl].gw_kg += totalGw;
      buckets[decl].cbm   += line.cbm;

      if (line.qty > 0 && totalNw === 0 && totalGw === 0) {
        missingWeight.push(line.sku || declRaw || "unknown");
      }
    }

    // 5. 整形输出，按 CTN 降序
    const rows = Object.entries(buckets)
      .map(([declaration_name, v]) => ({
        declaration_name,
        ctn:    Math.round(v.ctn),
        nw_kg:  parseFloat(v.nw_kg.toFixed(2)),
        gw_kg:  parseFloat(v.gw_kg.toFixed(2)),
        cbm:    parseFloat(v.cbm.toFixed(4)),
      }))
      .sort((a, b) => b.ctn - a.ctn);

    const total = rows.reduce(
      (acc, r) => ({
        declaration_name: "TOTAL",
        ctn:    acc.ctn    + r.ctn,
        nw_kg:  parseFloat((acc.nw_kg  + r.nw_kg).toFixed(2)),
        gw_kg:  parseFloat((acc.gw_kg  + r.gw_kg).toFixed(2)),
        cbm:    parseFloat((acc.cbm    + r.cbm).toFixed(4)),
      }),
      { ctn: 0, nw_kg: 0, gw_kg: 0, cbm: 0 }
    );

    return res.status(200).json({
      success: true,
      rows,
      total,
      missing_weight: [...new Set(missingWeight)],
      orders_found:   orders.length,
      orders_missing: ordersMissing,
      generated_at:   new Date().toISOString(),
    });

  } catch (err) {
    console.error("[customs-summary]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
