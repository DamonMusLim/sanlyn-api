// /api/db/ingest.js
// AI 智能录入引擎（可复用）：粘贴单据文本 → 按 schema 提取 → 匹配 DB → 返回填充/缺失/多义/新品
// READ-ONLY：只返回预览，不写库。写库由各界面原有保存 API 完成（人工确认后）。
//
// POST { text, schema_id }
//   schema_id: 'order_lineitems' | 'shipping_plan' | 'finance_record'
// 返回 { ok, schema_id, rows:[{...,_match:'ok'|'ambiguous'|'new',_candidates:[]}], summary }

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Schema 注册中心：每个界面声明要什么字段 + 怎么匹配 ──
const SCHEMAS = {
  order_lineitems: {
    label: "订单产品行",
    // 从 packing list 行提取：货号/品名/罐数/箱数/净重
    match_key: "sku",
    match_table: "products",
  },
  // 预留：shipping_plan / finance_record 后续加
};

// ── Packing list 行解析 ──
// 匹配形如：TN-48 WANPY MEAT LOAF TURKEY CANNED FOOD FOR DOG / 375G/CANX24/CTN 2400 CANS 100 CTNS 900KGS
function parsePackingList(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  let pending = null; // 跨行：品名行 + 数量行
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 货号开头：TN-48 / CA-01HJ 等（字母-数字/字母）
    const skuM = line.match(/^([A-Z]{1,4}-?\d{1,3}[A-Z]{0,3})\s+(.+)$/);
    if (skuM) {
      if (pending) rows.push(pending);
      pending = { sku: skuM[1], desc: skuM[2].trim(), spec: null, cans: null, ctns: null, nw: null };
      // 同行可能就带数量
      grabQty(line, pending);
      continue;
    }
    // 规格/数量行（接在货号行后）：375G/CANX24/CTN 2400 CANS 100 CTNS 900KGS
    if (pending) {
      const specM = line.match(/(\d+\s*G\s*\/\s*CANX\d+\s*\/\s*CTN|\d+G\/CANX\d+\/CTN)/i);
      if (specM) pending.spec = specM[1].replace(/\s+/g, "");
      grabQty(line, pending);
    }
  }
  if (pending) rows.push(pending);
  // 只保留确实抓到数量的行（过滤标题/合计）
  return rows.filter(r => r.cans || r.ctns || r.nw);
}
function grabQty(line, row) {
  let m;
  if ((m = line.match(/([\d,]+)\s*CANS/i))) row.cans = num(m[1]);
  if ((m = line.match(/([\d,]+)\s*CTNS?/i))) row.ctns = num(m[1]);
  if ((m = line.match(/([\d,]+(?:\.\d+)?)\s*KGS?/i))) row.nw = num(m[1]);
}
function num(s) { return parseFloat(String(s).replace(/,/g, "")) || null; }

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body || {};

    // ── 新品注册：货号不在 products 表时，把货号+HS+申报名写进产品主表 ──
    if (body.action === "register_product") {
      const p = body.product || {};
      if (!p.sku || !p.product_name) return res.status(400).json({ error: "sku+product_name required" });
      if (!p.hs_code) return res.status(400).json({ error: "hs_code required (严禁编造)" });
      const pool0 = getPool();
      const exist = await pool0.query("SELECT id FROM products WHERE sku=$1 LIMIT 1", [p.sku]);
      if (exist.rows.length) return res.json({ ok: true, id: exist.rows[0].id, existed: true });
      const ins = await pool0.query(
        `INSERT INTO products (sku, product_name, hs_code, declaration_name, net_weight, gross_weight, spec)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [p.sku, p.product_name, p.hs_code, p.declaration_name || "宠物食品", p.net_weight || null, p.gross_weight || null, p.spec || null]
      );
      return res.json({ ok: true, id: ins.rows[0].id, created: true });
    }

    const text = body.text;
    const schema_id = body.schema_id || "order_lineitems";
    if (!text) return res.status(400).json({ error: "text required" });
    const schema = SCHEMAS[schema_id];
    if (!schema) return res.status(400).json({ error: "unknown schema_id" });

    const pool = getPool();

    if (schema_id === "order_lineitems") {
      const parsed = parsePackingList(text);
      if (!parsed.length) return res.json({ ok: true, schema_id, rows: [], summary: { total: 0, note: "未识别到产品行" } });

      const skus = [...new Set(parsed.map(r => r.sku))];
      const q = await pool.query(
        `SELECT sku, product_name, spec, net_weight, gross_weight, hs_code, declaration_name, declaration_elements,
                sale_price_cny, factory_price, carton_qty AS bg_bx
         FROM products WHERE sku = ANY($1)`, [skus]
      );
      const bySku = {};
      for (const p of q.rows) { (bySku[p.sku] = bySku[p.sku] || []).push(p); }

      let ok = 0, ambiguous = 0, missing = 0;
      const rows = parsed.map(r => {
        const cand = bySku[r.sku] || [];
        let _match, product = null;
        if (cand.length === 0) { _match = "new"; missing++; }
        else if (cand.length === 1) { _match = "ok"; product = cand[0]; ok++; }
        else { _match = "ambiguous"; ambiguous++; }
        return {
          sku: r.sku, desc: r.desc, spec: r.spec, cans: r.cans, ctns: r.ctns, nw: r.nw,
          _match,
          // 匹配上的：自动带出报关字段（绝不编造，全来自 products）
          product: product ? {
            product_name: product.product_name, hs_code: product.hs_code,
            declaration_name: product.declaration_name, net_weight: product.net_weight,
            gross_weight: product.gross_weight, spec: product.spec,
            sale_price_cny: product.sale_price_cny,
            factory_price: product.factory_price,
            bg_bx: product.bg_bx,
            unit_price_ctn: product.sale_price_cny && product.bg_bx
              ? parseFloat((parseFloat(product.sale_price_cny) * parseInt(product.bg_bx)).toFixed(4))
              : null,
          } : null,
          // 多义的：列候选给前端弹窗选
          _candidates: _match === "ambiguous" ? cand.map(c => ({
            product_name: c.product_name, spec: c.spec, hs_code: c.hs_code, net_weight: c.net_weight,
          })) : [],
        };
      });

      return res.json({
        ok: true, schema_id, rows,
        summary: {
          total: rows.length, matched: ok, ambiguous, new_skus: missing,
          total_ctns: rows.reduce((s, r) => s + (r.ctns || 0), 0),
          total_nw: rows.reduce((s, r) => s + (r.nw || 0), 0),
        },
      });
    }

    return res.status(400).json({ error: "schema not implemented: " + schema_id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
