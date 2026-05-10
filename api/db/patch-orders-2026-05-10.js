// ONE-SHOT patch endpoint — remove after use
// Auth: header x-patch-secret must match CRON_SECRET
import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const secret = req.headers["x-patch-secret"] || "";
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET)
    return res.status(403).json({ error: "Forbidden" });
  const pool = getPool();
  const client = await pool.connect();
  const log = [];
  try {
    await client.query("BEGIN");
    // Fix orders 75 and 77: add hs_code + declaration_name to raw.products items
    for (const orderId of [75, 77]) {
      const { rows } = await client.query("SELECT id, raw FROM orders WHERE id=$1", [orderId]);
      if (!rows.length) { log.push("Order " + orderId + " not found"); continue; }
      const raw = rows[0].raw || {};
      const products = Array.isArray(raw.products) ? raw.products : [];
      const patched = products.map(p => ({
        ...p,
        hs_code: p.hs_code || "3824999999",
        declaration_name: p.declaration_name || "膨润土猫砂",
      }));
      raw.products = patched;
      await client.query("UPDATE orders SET raw=$1, updated_at=NOW() WHERE id=$2", [JSON.stringify(raw), orderId]);
      log.push("Order " + orderId + ": patched " + patched.length + " products (hs_code+declaration_name)");
    }
    // Fix order 1142: CP1578 weights/cbm + CP1578/CP1580 subtotals
    {
      const { rows } = await client.query("SELECT id, raw FROM orders WHERE id=1142");
      if (!rows.length) { log.push("Order 1142 not found"); }
      else {
        const raw = rows[0].raw || {};
        const products = Array.isArray(raw.products) ? raw.products : [];
        const patched = products.map(p => {
          const code = String(p.item_no || p.sku || p.product_code || "");
          if (code === "CP1578") {
            const qty = Number(p.qty || p.quantity || 0);
            const up = Number(p.unit_price || p.unitPrice || 0);
            return { ...p, netWeight: 4.65, grossWeight: 5.25, cbm: 0.0313281,
              subtotal: qty && up ? parseFloat((qty * up).toFixed(2)) : p.subtotal };
          }
          if (code === "CP1580") {
            const qty = Number(p.qty || p.quantity || 0);
            const up = Number(p.unit_price || p.unitPrice || 0);
            return { ...p, subtotal: qty && up ? parseFloat((qty * up).toFixed(2)) : p.subtotal };
          }
          return p;
        });
        raw.products = patched;
        await client.query("UPDATE orders SET raw=$1, updated_at=NOW() WHERE id=1142", [JSON.stringify(raw)]);
        const cp78 = patched.find(p => String(p.item_no||p.sku||p.product_code||"")==="CP1578");
        const cp80 = patched.find(p => String(p.item_no||p.sku||p.product_code||"")==="CP1580");
        log.push("Order 1142 CP1578: " + JSON.stringify(cp78 ? {nw:cp78.netWeight,gw:cp78.grossWeight,cbm:cp78.cbm,sub:cp78.subtotal} : "not found"));
        log.push("Order 1142 CP1580: subtotal=" + (cp80 ? cp80.subtotal : "not found"));
      }
    }
    await client.query("COMMIT");
    log.push("COMMIT OK");
    return res.status(200).json({ success: true, log });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: e.message, log });
  } finally {
    client.release();
  }
}
