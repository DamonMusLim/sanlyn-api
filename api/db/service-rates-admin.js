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

    // 统一表 service_rates(2026-08-05 建,四段服务一张表)。
    // 闸2 同类路径:老的 forwarder_service_rates / trucking_rates 已迁入并降级为历史源,
    // 这里只读 service_rates 一处,不再各读各的。
    const conds = ["sr.is_active"], params = [];
    if (service) { params.push(service); conds.push(`sr.service = $${params.length}`); }
    if (pol) { params.push(pol); conds.push(`(sr.pol IS NULL OR sr.pol = '' OR lower(btrim(sr.pol)) = lower(btrim($${params.length})))`); }

    const q = await pool.query(
      `SELECT sr.id, sr.service, sr.factory_name, sr.factory_company_id, sr.pol, sr.pod,
              sr.container_type, sr.tier, sr.rate, sr.currency, sr.unit,
              sr.quote_owner_company_id, qo.name_cn AS quote_owner_cn,
              sr.executor_company_id,    ex.name_cn AS executor_cn,
              sr.payable_company_id,     pa.name_cn AS payable_cn,
              sr.issuing_company_id, sr.issuing_company,
              sr.valid_from, sr.valid_to, sr.source, sr.notes,
              sr.raw->>'id_link'  AS id_link_status,
              sr.raw->>'vendor_cn' AS legacy_vendor_cn,
              sr.updated_at, sr.updated_by
       FROM service_rates sr
       LEFT JOIN companies qo ON qo.id = sr.quote_owner_company_id
       LEFT JOIN companies ex ON ex.id = sr.executor_company_id
       LEFT JOIN companies pa ON pa.id = sr.payable_company_id
       WHERE ${conds.join(" AND ")}
       ORDER BY sr.service, sr.factory_name NULLS LAST, sr.pol, sr.container_type, sr.tier`,
      params
    );

    const rows = q.rows;
    const bySvc = { truck: [], customs: [], ocean: [], port: [] };
    rows.forEach((r) => { (bySvc[r.service] || (bySvc[r.service] = [])).push(r); });
    const needManual = rows.filter((r) => r.id_link_status === "need_manual").length;

    return res.status(200).json({
      ok: true,
      context: { plan_id: planId || null, pol: pol || null, issuing_company: issuingCompany || null, factories },
      rates: rows,
      by_service: bySvc,
      counts: { total: rows.length, truck: bySvc.truck.length, customs: bySvc.customs.length,
                ocean: bySvc.ocean.length, port: bySvc.port.length, need_manual: needManual },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
