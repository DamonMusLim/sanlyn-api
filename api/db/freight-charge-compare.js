// api/db/freight-charge-compare.js
// GET /api/db/freight-charge-compare?bl_no=X&supplier=Y
// Returns current bill charges vs 12-month historical average.
// Port charges (港杂) get diff/pct; ocean freight (海运费) is shown only.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const OCEAN_RE = /海运|ocean.?freight/i;

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!requireAuth(req, res)) return;

  const { bl_no, supplier } = req.query;
  if (!bl_no) return res.status(400).json({ error: "bl_no required" });

  const pool = getPool();
  try {
    // 1. Current bill lines for this BL
    const cur = await pool.query(
      `SELECT cost_category, amount, currency, bill_month, supplier
       FROM our_freight_cost_lines
       WHERE bl_no = $1
         AND ($2::text IS NULL OR supplier ILIKE '%' || $2 || '%')
       ORDER BY cost_category`,
      [bl_no, supplier || null]
    );
    if (!cur.rows.length) return res.status(404).json({ error: "no bills found for bl_no" });

    const billMonth = cur.rows[0].bill_month;
    const sup = cur.rows[0].supplier;

    // 2. Historical avg for same supplier + each cost_category (past 12 months, exclude current BL)
    //    bill_month is TEXT in 'YYYY-MM' form, which sorts chronologically — so compare it
    //    as text against to_char(NOW(),'YYYY-MM'). The regex guard skips malformed values
    //    (e.g. '2024-misc') so a date cast never throws (was: text < timestamptz → 500).
    const cats = cur.rows.map(r => r.cost_category);
    const hist = await pool.query(
      `SELECT cost_category, currency,
              ROUND(AVG(amount)::numeric, 2) AS avg_12m,
              COUNT(*)::int                  AS sample_count,
              MIN(amount)                    AS min_12m,
              MAX(amount)                    AS max_12m
       FROM our_freight_cost_lines
       WHERE supplier       ILIKE '%' || $1 || '%'
         AND cost_category  = ANY($2::text[])
         AND bl_no          != $3
         AND bill_month ~ '^[0-9]{4}-[0-9]{2}$'
         AND bill_month <  to_char(NOW(), 'YYYY-MM')
         AND bill_month >= to_char(NOW() - INTERVAL '12 months', 'YYYY-MM')
       GROUP BY cost_category, currency`,
      [sup, cats, bl_no]
    );
    const histMap = {};
    for (const h of hist.rows) histMap[h.cost_category + ":" + h.currency] = h;

    // 3. Merge
    const lines = cur.rows.map(r => {
      const isOcean = OCEAN_RE.test(r.cost_category);
      const h = isOcean ? null : histMap[r.cost_category + ":" + r.currency];
      let diff = null, diff_pct = null, flag = "ok";

      if (!isOcean && h && h.sample_count >= 3) {
        diff     = parseFloat((Number(r.amount) - Number(h.avg_12m)).toFixed(2));
        diff_pct = h.avg_12m > 0
          ? parseFloat(((diff / Number(h.avg_12m)) * 100).toFixed(2))
          : null;
        if (diff > 0)        flag = "high";
        else if (diff < 0)   flag = "low";
        else                 flag = "same";
      } else if (!isOcean && (!h || h.sample_count < 3)) {
        flag = "insufficient";
      } else if (isOcean) {
        flag = "ocean";
      }

      return {
        cost_category: r.cost_category,
        amount:        Number(r.amount),
        currency:      r.currency,
        is_port_charge: !isOcean,
        history: h ? {
          avg_12m:      Number(h.avg_12m),
          sample_count: h.sample_count,
          min_12m:      Number(h.min_12m),
          max_12m:      Number(h.max_12m),
        } : null,
        diff, diff_pct, flag,
      };
    });

    res.json({ bl_no, supplier: sup, bill_month: billMonth, lines });
  } catch (err) {
    console.error("[freight-charge-compare]", err.message);
    res.status(500).json({ error: err.message });
  }
}
