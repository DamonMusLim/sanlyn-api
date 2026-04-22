// /api/db/vendor-quotes.js
// Returns priced routes belonging to the current logistics vendor.
// Used by FreightPriceCenter → SpotRFQsView to show "已报价" routes
// (quotes where the vendor already has a price in shipping_plans).
//
// Deduped by pol+pod+container_type — the most recent etd wins.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function normCompany(s) {
  if (!s) return "";
  let x = String(s).replace(/[（）()【】\[\]\s、，,。.·\-_/\\]/g, "");
  const geo = ["厦门","上海","天津","青岛","宁波","深圳","山东","江苏","烟台","福建","广州"];
  for (const g of geo) if (x.startsWith(g) && x.length > g.length + 1) { x = x.slice(g.length); break; }
  x = x.replace(/(股份有限公司|有限责任公司|有限公司|分公司)$/g, "");
  return x;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const u = req.user || {};
  if (u.role !== "logistics") {
    return res.status(200).json({ success: true, data: [], count: 0 });
  }

  const col = u.supplierRole === "ocean"   ? "forwarder_cn"
            : u.supplierRole === "customs" ? "customs_cn"
            : u.supplierRole === "truck"   ? "trucking_cn"
            : null;
  const needle = normCompany(u.company);
  if (!col || !needle) {
    return res.status(200).json({ success: true, data: [], count: 0 });
  }

  try {
    const pool = getPool();
    const hint = needle.slice(0, 2);
    // Pull any plan with price columns set for the ocean vendor; all cost
    // columns for others. Keep both sale and cost for ocean so UI can show
    // the vendor's own quote.
    const sql = `
      SELECT shipment_no, pol, pod, container_type, etd,
             forwarder_cn, customs_cn, trucking_cn,
             freight_cost, freight_sale_usd,
             port_surcharge_total, customs_cost_total, trucking_cost_total,
             raw, customer
      FROM shipping_plans
      WHERE ${col} ILIKE $1
      ORDER BY etd DESC
      LIMIT 500`;
    const rows = (await pool.query(sql, [`%${hint}%`])).rows;

    // Node-side tight normalized match
    const matched = rows.filter(r => {
      const cell = normCompany(r[col]);
      return cell && (cell.includes(needle) || needle.includes(cell));
    });

    // Filter to rows that actually have a price for this vendor's service
    const priced = matched.filter(r => {
      if (u.supplierRole === "ocean")   return Number(r.freight_cost) > 0 || Number(r.freight_sale_usd) > 0;
      if (u.supplierRole === "customs") return Number(r.customs_cost_total) > 0;
      if (u.supplierRole === "truck")   return Number(r.trucking_cost_total) > 0;
      return false;
    });

    // Dedupe by pol+pod+container_type (keep most recent etd — first since ORDER BY etd DESC)
    const seen = new Set();
    const unique = [];
    for (const r of priced) {
      const key = [r.pol || "", r.pod || "", r.container_type || ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({
        shipmentNo: r.shipment_no,
        pol: r.pol, pod: r.pod,
        containerType: r.container_type,
        etd: r.etd,
        customer: r.customer,
        priceCost:  u.supplierRole === "ocean" ? Number(r.freight_cost||0)
                  : u.supplierRole === "customs" ? Number(r.customs_cost_total||0)
                  : Number(r.trucking_cost_total||0),
        priceSale:  u.supplierRole === "ocean" ? Number(r.freight_sale_usd||0) : null,
        portSurcharge: Number(r.port_surcharge_total||0),
      });
    }

    return res.status(200).json({ success: true, data: unique, count: unique.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
