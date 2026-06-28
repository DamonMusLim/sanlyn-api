// /api/db/packaging-consume.js — 出货自动扣袋（按 箱数 × bg_bx）+ 8%进项摊销
// POST {order_no, dry_run?}            → 按整票订单所有行自动扣
// POST {sku, cartons, dry_run?}        → 单SKU手动扣
import { getPool, setCors } from "./db.js";

const VAT = 0.08;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  const { order_no, sku, cartons, operator, dry_run } = req.body || {};

  // build work list: [{sku, cartons, declaration_name?}]
  let lines = [];
  try {
    if (order_no) {
      const r = await pool.query(`
        SELECT oli.sku, oli.qty_ctn::numeric AS cartons, oli.declaration_name
        FROM orders o JOIN order_line_items oli ON oli.order_id = o.id
        WHERE o.order_no = $1 AND oli.sku IS NOT NULL`, [order_no]);
      lines = r.rows.map(x => ({ sku: x.sku, cartons: Number(x.cartons), declaration_name: x.declaration_name }));
      if (!lines.length) return res.status(404).json({ success: false, error: `订单 ${order_no} 无可扣行(缺sku)` });
    } else if (sku && cartons) {
      lines = [{ sku, cartons: Number(cartons) }];
    } else {
      return res.status(400).json({ success: false, error: "需 order_no 或 (sku + cartons)" });
    }
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }

  const client = await pool.connect();
  const result = [];
  let totalCost = 0, totalVat = 0;
  try {
    await client.query("BEGIN");
    for (const ln of lines) {
      // bg_bx from products
      const p = await client.query(`SELECT bg_bx::numeric AS bg_bx, product_name FROM products WHERE sku=$1`, [ln.sku]);
      const bgbx = p.rows.length ? Number(p.rows[0].bg_bx) : null;
      // bag material mapped to this sku
      const m = await client.query(
        `SELECT id, sku_code, name, unit, current_stock::numeric AS stock, unit_cost::numeric AS uc
         FROM packaging_materials WHERE product_skus @> $1::jsonb FOR UPDATE`,
        [JSON.stringify([ln.sku])]);
      if (!m.rows.length) { result.push({ sku: ln.sku, status: "skip", reason: "无对应袋档" }); continue; }
      const bag = m.rows[0];
      if (!bgbx) { result.push({ sku: ln.sku, bag: bag.sku_code, status: "skip", reason: "产品缺bg_bx" }); continue; }
      if (bag.unit !== "个") { result.push({ sku: ln.sku, bag: bag.sku_code, status: "skip", reason: `袋按${bag.unit}计,需补每袋单价方可自动扣` }); continue; }

      const bagsNeeded = Math.round(ln.cartons * bgbx);
      const cost = Math.round(bagsNeeded * bag.uc * 100) / 100;
      const vat = Math.round(cost / (1 + VAT) * VAT * 100) / 100;
      const after = bag.stock - bagsNeeded;
      if (after < 0) { result.push({ sku: ln.sku, bag: bag.sku_code, status: "insufficient", reason: `库存${bag.stock}不足扣${bagsNeeded}` }); continue; }

      if (!dry_run) {
        await client.query(`UPDATE packaging_materials SET current_stock=$1, updated_at=NOW() WHERE id=$2`, [after, bag.id]);
        await client.query(
          `INSERT INTO packaging_logs(material_id,type,quantity,before_stock,after_stock,operator,notes)
           VALUES($1,'out',$2,$3,$4,$5,$6)`,
          [bag.id, bagsNeeded, bag.stock, after, operator || "出货扣袋",
           `出货扣袋 ${order_no||""} ${ln.sku} ${ln.cartons}箱×${bgbx} 含税¥${cost} 进项税¥${vat}(VAT8%)`]);
      }
      totalCost += cost; totalVat += vat;
      result.push({ sku: ln.sku, declaration_name: ln.declaration_name, bag: bag.sku_code,
        cartons: ln.cartons, bg_bx: bgbx, bags: bagsNeeded, before: bag.stock, after,
        cost_incl: cost, input_vat: vat, status: dry_run ? "preview" : "deducted" });
    }
    if (dry_run) await client.query("ROLLBACK"); else await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: e.message });
  } finally { client.release(); }

  return res.status(200).json({ success: true, dry_run: !!dry_run,
    total_cost_incl: Math.round(totalCost * 100) / 100,
    total_input_vat: Math.round(totalVat * 100) / 100, lines: result });
}
