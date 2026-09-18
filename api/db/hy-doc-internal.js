// GET /api/db/hy-doc-internal?bl=... — 单据页外壳内部信息,只读,不进客户单据/PDF。
import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

function clean(v) {
  return String(v ?? "").trim();
}

function uniq(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  const bl = clean(req.query?.bl);
  if (!bl) return res.status(400).json({ success: false, error: "bl required" });

  try {
    const pool = getPool();
    const r = await pool.query(
      `WITH plan AS (
         SELECT id, bl_no, shipment_no, contract_no
           FROM shipping_plans
          WHERE UPPER(BTRIM(COALESCE(bl_no, ''))) = UPPER(BTRIM($1))
             OR UPPER(BTRIM(COALESCE(shipment_no, ''))) = UPPER(BTRIM($1))
          ORDER BY id DESC
          LIMIT 1
       )
       SELECT p.bl_no, p.shipment_no,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(o.order_no), '')), NULL) AS order_nos,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(COALESCE(c.name_cn, o.issuing_company::text)), '')), NULL) AS issuing_companies
         FROM plan p
         LEFT JOIN orders o
           ON o.shipping_plan_id = p.id
           OR (NULLIF(BTRIM(p.contract_no), '') IS NOT NULL AND o.contract_no = p.contract_no)
         LEFT JOIN companies c ON c.id::text = o.issuing_company_id::text
        GROUP BY p.bl_no, p.shipment_no`,
      [bl]
    );
    const row = r.rows[0] || {};
    return res.status(200).json({
      success: true,
      data: {
        bl_no: clean(row.bl_no),
        shipment_no: clean(row.shipment_no),
        order_nos: uniq(row.order_nos || []),
        issuing_companies: uniq(row.issuing_companies || []),
      },
    });
  } catch (err) {
    console.error("[hy-doc-internal]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
