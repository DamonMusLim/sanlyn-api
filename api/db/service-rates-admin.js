// admin 侧只读:一票的拖车/报关费率明细 —— Damon 2026-08-05
// 「下面单独切开---报关-票-- 拖车点进去另外完整的界面---哪个工厂哪个价格」
//
// 两个数据源合并(别只看一个,会漏):
//   ① forwarder_service_rates —— 货代在 v22 门户自己填的(带 forwarder_company_id,符合 ID 铁律)
//   ② trucking_rates          —— 我方自维护的老表(vendor_cn/factory_name 还是文本,待 ID 化)
// 工厂取自本票订单(order_nos → orders.factory),港口取票上 pol。
// 只读,不写库。货代成本对我方内部可见(这是 admin 侧,不是对外协同页)。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const clean = (v) => (v == null ? "" : String(v).trim());

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const planId = clean(req.query.plan_id || req.query.id);
  const service = clean(req.query.service) || "";   // truck | customs | 空=两者

  try {
    let pol = clean(req.query.pol);
    let factories = [];
    let issuingCompany = "";

    if (planId) {
      const p = await pool.query(
        `SELECT sp.pol, sp.issuing_company, sp.order_nos, sp.trucking_company_id, sp.customs_broker_id, sp.forwarder_company_id
         FROM shipping_plans sp WHERE sp._id = $1 OR sp.id::text = $1 LIMIT 1`, [planId]);
      if (p.rows.length) {
        const row = p.rows[0];
        pol = pol || clean(row.pol);
        issuingCompany = clean(row.issuing_company);
        const nos = Array.isArray(row.order_nos) ? row.order_nos : [];
        if (nos.length) {
          const f = await pool.query(
            `SELECT DISTINCT factory FROM orders WHERE order_no = ANY($1::text[]) AND COALESCE(factory,'') <> ''`, [nos]);
          factories = f.rows.map((r) => r.factory);
        }
      }
    }

    // ① 货代门户填的费率
    const conds = [], params = [];
    if (service) { params.push(service); conds.push(`service = $${params.length}`); }
    if (pol) { params.push(pol); conds.push(`(port IS NULL OR port = '' OR lower(btrim(port)) = lower(btrim($${params.length})))`); }
    const fsr = await pool.query(
      `SELECT r.id, r.forwarder_company_id, c.name_cn AS forwarder_cn, r.service, r.factory, r.port,
              r.container_type, r.tier, r.rate_cny, r.updated_at, r.updated_by
       FROM forwarder_service_rates r
       LEFT JOIN companies c ON c.id = r.forwarder_company_id
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY r.factory NULLS LAST, r.port, r.container_type, r.tier`, params);

    // ② 我方自维护的拖车价(老表,文本键)
    let ours = [];
    if (!service || service === "truck") {
      const t = await pool.query(
        `SELECT _id, vendor_cn, factory_name, pol, rates, currency, valid_from, valid_to, notes
         FROM trucking_rates ${pol ? "WHERE lower(btrim(pol)) = lower(btrim($1))" : ""}
         ORDER BY factory_name NULLS LAST`, pol ? [pol] : []);
      ours = t.rows;
    }

    return res.status(200).json({
      ok: true,
      context: { plan_id: planId || null, pol: pol || null, issuing_company: issuingCompany || null, factories },
      portal_rates: fsr.rows,     // 货代自己填的(带 company_id)
      our_trucking_rates: ours,   // 我方自维护(待 ID 化,见任务 join-by-id-migration-0804)
      counts: { portal: fsr.rows.length, ours: ours.length },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
