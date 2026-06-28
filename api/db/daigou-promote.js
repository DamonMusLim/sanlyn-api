// /api/db/daigou-promote.js — 代购品「收入产品库」：把一次性代购OLI行转成正式产品(CP码)
// POST {oli_id}  或  {order_no, declaration_name}
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  const { oli_id, order_no, declaration_name, brand } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // locate the OLI line + its order (for order-level supplier fallback)
    let q, args;
    if (oli_id) { q = `WHERE oli.id=$1`; args = [oli_id]; }
    else if (order_no && declaration_name) { q = `WHERE o.order_no=$1 AND oli.declaration_name=$2`; args = [order_no, declaration_name]; }
    else { await client.query("ROLLBACK"); return res.status(400).json({ success:false, error:"需 oli_id 或 (order_no+declaration_name)" }); }

    const r = await client.query(`
      SELECT oli.id, oli.product_id, oli.declaration_name, oli.declaration_name_en, oli.product_name,
             oli.hs_code, oli.nw_ctn, oli.gw_ctn, oli.unit, oli.vat_rate, oli.tax_rebate_rate,
             COALESCE(p.factory_code, o.factory_code) AS factory_code
      FROM order_line_items oli
      JOIN orders o ON o.id = oli.order_id
      LEFT JOIN products p ON p.id = oli.product_id
      ${q} LIMIT 1`, args);
    if (!r.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success:false, error:"找不到该明细行" }); }
    const ln = r.rows[0];
    if (ln.product_id) { await client.query("ROLLBACK"); return res.status(409).json({ success:false, error:"该行已是产品库商品", sku: null }); }

    // next CP code
    const mx = await client.query(`SELECT sku FROM products WHERE sku ~ '^CP[0-9]+$' ORDER BY (regexp_replace(sku,'CP','')::int) DESC LIMIT 1`);
    const nextNum = mx.rows.length ? parseInt(mx.rows[0].sku.replace("CP","")) + 1 : 1;
    const sku = "CP" + String(nextNum).padStart(4, "0");

    const ins = await client.query(`
      INSERT INTO products (sku, product_name, product_name_cn, declaration_name, declaration_name_en,
        hs_code, factory_code, net_weight, gross_weight, vat_rate, rebate_rate, bg_bx, unit, brand, active, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,0.13),COALESCE($11,0.13),1,COALESCE($12,'CTN'),$13,true,NOW(),NOW())
      RETURNING id`,
      [sku, ln.declaration_name_en || ln.product_name || ln.declaration_name, ln.declaration_name,
       ln.declaration_name, ln.declaration_name_en || ln.product_name, ln.hs_code, ln.factory_code,
       ln.nw_ctn, ln.gw_ctn, ln.vat_rate, ln.tax_rebate_rate, ln.unit, brand || null]);
    const pid = ins.rows[0].id;

    await client.query(`UPDATE order_line_items SET product_id=$1, sku=$2, updated_at=NOW() WHERE id=$3`, [pid, sku, ln.id]);
    await client.query("COMMIT");
    return res.status(200).json({ success: true, sku, product_id: pid, declaration_name: ln.declaration_name,
      message: `已收入产品库: ${sku} (${ln.declaration_name})` });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: e.message });
  } finally { client.release(); }
}
