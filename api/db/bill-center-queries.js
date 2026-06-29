import { getPool, setCors } from "../db.js";
import { bad, requireFinance } from "./bill-center-auth.js";

function side(direction) {
  if (direction === "payable") return {
    code: "supplier_company_code", total: "amount", status: "ap_status", paid: "ap_paid_amount", company: "supplier",
  };
  if (direction === "receivable") return {
    code: "payer_company_code", total: "sale_amount", status: "ar_status", paid: "ar_paid_amount", company: "payer",
  };
  return null;
}

function commonFilters(query, params) {
  const conds = [];
  if (query.currency) {
    params.push(String(query.currency));
    conds.push(`b.currency = $${params.length}`);
  }
  if (query.bl_no) {
    params.push(String(query.bl_no));
    conds.push(`b.bl_no = $${params.length}`);
  }
  if (query.cost_category) {
    params.push(String(query.cost_category));
    conds.push(`b.cost_category = $${params.length}`);
  }
  return conds;
}

export async function getSummary(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (!requireFinance(req, res)) return;
  const s = side(req.query.direction);
  if (!s) return bad(res, 400, "bad_direction", "direction must be payable or receivable");
  const params = [];
  const conds = commonFilters(req.query, params);
  conds.push(`b.${s.code} IS NOT NULL`, `COALESCE(b.${s.total}, 0) > 0`);
  const where = `WHERE ${conds.join(" AND ")}`;
  const sql = `
    SELECT b.${s.code} AS company_code,
           COALESCE(c.name_cn, c.name_en, b.${s.code}) AS company_name,
           c.province AS company_city,
           b.currency,
           COUNT(*)::int AS line_count,
           COUNT(DISTINCT b.bl_no)::int AS order_count,
           SUM(b.${s.total}) AS total_amount,
           SUM(b.${s.paid}) AS paid_amount,
           SUM(b.${s.total}) FILTER (WHERE COALESCE(b.${s.status}, 'unpaid') <> 'paid') AS unpaid_amount,
           COUNT(*) FILTER (WHERE COALESCE(b.${s.status}, 'unpaid') IN ('unpaid','partial'))::int AS open_count,
           COUNT(*) FILTER (WHERE COALESCE(b.${s.status}, 'unpaid') = 'paid')::int AS paid_count
      FROM active_freight_supplier_bills b
      LEFT JOIN companies c ON c.code = b.${s.code}
      ${where}
     GROUP BY b.${s.code}, c.name_cn, c.name_en, c.province, b.currency
     ORDER BY unpaid_amount DESC NULLS LAST, total_amount DESC NULLS LAST`;
  const r = await getPool().query(sql, params);
  return res.status(200).json({ success: true, direction: req.query.direction, data: r.rows });
}

export async function getCompany(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (!requireFinance(req, res)) return;
  const s = side(req.query.direction);
  const companyCode = String(req.query.company_code || "").trim();
  if (!s) return bad(res, 400, "bad_direction", "direction must be payable or receivable");
  if (!companyCode) return bad(res, 400, "missing_company_code", "company_code required");
  const params = [companyCode];
  const conds = [`b.${s.code} = $1`, `COALESCE(b.${s.total}, 0) > 0`].concat(commonFilters(req.query, params));
  if (req.query.bucket === "open") conds.push(`COALESCE(b.${s.status}, 'unpaid') IN ('unpaid','partial')`);
  if (req.query.bucket === "paid") conds.push(`COALESCE(b.${s.status}, 'unpaid') = 'paid'`);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10) || 200, 1), 500);
  params.push(limit);
  const r = await getPool().query(
    `SELECT b.id, b.bl_no, b.container_no, b.cost_category, b.currency, b.qty, b.unit_price,
            b.amount, b.sale_amount, b.charge_basis, b.confirmed_at, b.confirmed_by,
            b.ap_status, b.ap_paid_amount, b.ap_paid_at, b.ar_status, b.ar_paid_amount, b.ar_paid_at,
            b.payment_note, b.created_at, b.updated_at,
            c.province AS company_city,
            sp.id AS shipping_plan_id, sp.pol, sp.pod, sp.etd, sp.eta, sp.container_type, sp.container_qty
       FROM active_freight_supplier_bills b
       LEFT JOIN companies c ON c.code = b.${s.code}
       LEFT JOIN LATERAL (
         SELECT id, pol, pod, etd, eta, container_type, container_qty
           FROM shipping_plans sp
          WHERE sp.bl_no = b.bl_no OR sp.hbl_no = b.bl_no
          ORDER BY sp.updated_at DESC NULLS LAST
          LIMIT 1
       ) sp ON TRUE
      WHERE ${conds.join(" AND ")}
      ORDER BY b.updated_at DESC NULLS LAST, b.id DESC
      LIMIT $${params.length}`,
    params
  );
  return res.status(200).json({ success: true, direction: req.query.direction, data: r.rows });
}

export async function getOrder(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (!requireFinance(req, res)) return;
  const s = side(req.query.direction);
  const companyCode = String(req.query.company_code || "").trim();
  const blNo = String(req.query.bl_no || "").trim();
  if (!s) return bad(res, 400, "bad_direction", "direction must be payable or receivable");
  if (!companyCode || !blNo) return bad(res, 400, "missing_scope", "company_code and bl_no required");
  const r = await getPool().query(
    `SELECT b.id, b.bl_no, b.container_no, b.cost_category, b.currency, b.qty, b.unit_price,
            b.amount, b.sale_amount, b.charge_basis, b.raw->'invoice' AS invoice,
            b.raw->'invoice_uploads' AS invoice_uploads, b.raw->'collab_pending' AS collab_pending,
            b.ap_status, b.ap_paid_amount, b.ap_paid_at, b.ar_status, b.ar_paid_amount, b.ar_paid_at,
            b.confirmed_at, b.confirmed_by, b.payment_note,
            sp.id AS shipping_plan_id, sp.pol, sp.pod, sp.etd, sp.eta, sp.container_type, sp.container_qty
       FROM active_freight_supplier_bills b
       LEFT JOIN LATERAL (
         SELECT id, pol, pod, etd, eta, container_type, container_qty
           FROM shipping_plans sp
          WHERE sp.bl_no = b.bl_no OR sp.hbl_no = b.bl_no
          ORDER BY sp.updated_at DESC NULLS LAST
          LIMIT 1
       ) sp ON TRUE
      WHERE b.${s.code} = $1 AND b.bl_no = $2 AND COALESCE(b.${s.total}, 0) > 0
      ORDER BY b.id`,
    [companyCode, blNo]
  );
  return res.status(200).json({ success: true, direction: req.query.direction, data: r.rows });
}
