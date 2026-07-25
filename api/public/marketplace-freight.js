import { getPool, setCors } from "../db.js";

// 公开牌价（免登录）：只吐上架航线(raw.sharing.enabled=true)的【客户销售价】。
// Lens 死线：gp20/hq40 供应商价、forwarder、supplier_id、profit_*、official_* 一律不出此门。
// 上架动作 = 给 freight_rates 行写 raw.sharing.enabled + customer_gp20/customer_hq40，权在 Damon。
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  const pool = getPool();
  // 同航线同船司取最新一条（多批次报价共存，牌价只挂最新），口径同 forwarder-active 的 loadRateBook
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (lower(btrim(pol)), lower(btrim(pod)), upper(COALESCE(carrier,'')))
           pol, pod, carrier,
           customer_gp20, customer_hq40,
           COALESCE(sail_date::text, next_sailing) AS sailing,
           transit_days, valid_to
      FROM freight_rates
     WHERE raw->'sharing'->>'enabled' = 'true'
       AND (customer_gp20 IS NOT NULL OR customer_hq40 IS NOT NULL)
       AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
     ORDER BY lower(btrim(pol)), lower(btrim(pod)), upper(COALESCE(carrier,'')),
              COALESCE(valid_from, created_at::date) DESC, created_at DESC
     LIMIT 200`);
  const data = rows.map(r => ({
    pol: r.pol,
    pod: r.pod,
    carrier: r.carrier || null,
    price_gp20: r.customer_gp20 != null ? Number(r.customer_gp20) : null,
    price_hq40: r.customer_hq40 != null ? Number(r.customer_hq40) : null,
    sailing: r.sailing || null,
    transit_days: r.transit_days || null,
    valid_to: r.valid_to || null,
  }));
  return res.json({ ok: true, data, count: data.length });
}
