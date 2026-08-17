import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { guardBillRow, resolvePayer, ticketTerms } from "./lib/write-guards.js";
import { carrierFromBl, normalizeCarrier, normalizeChargeName, normalizeContainerType, num } from "./lib/portcharge-close-loop.js";

function clean(v) { return String(v ?? "").trim(); }
function n(v) { return v === "" || v == null ? null : num(v); }
function ym(v) { return clean(v || new Date().toISOString().slice(0, 7)); }

async function standards(pool, plan) {
  const carrier = normalizeCarrier(plan.carrier_code || plan.shipping_line || carrierFromBl(plan.bl_no || plan.shipment_no));
  const ct = normalizeContainerType(plan.container_type);
  const port = clean(plan.pol || "青岛");
  const r = await pool.query(
    `SELECT charge_item_name, amount_cny, unit_basis
       FROM carrier_tariff_standards
      WHERE upper(carrier)=upper($1) AND port ILIKE $2 AND container_type=$3
        AND review_status IN ('confirmed','pending')
        AND COALESCE(conditional_flag,false)=false
      ORDER BY charge_item_code, valid_from DESC, id DESC`, [carrier, port, ct]);
  return r.rows;
}

async function feeItems(pool) {
  const r = await pool.query(
    `SELECT standard_item_name AS name, MIN(unit_basis) AS unit_basis
       FROM carrier_tariff_charge_items
      GROUP BY standard_item_name
      ORDER BY standard_item_name
      LIMIT 38`);
  return r.rows;
}

async function listPlans(pool, q) {
  const s = `%${clean(q.search)}%`;
  const r = await pool.query(
    `SELECT id, _id, shipment_no, bl_no, flow_status, status, etd, pol, pod, container_type,
            freight_sale_usd, freight_sale_cny, remarks
       FROM shipping_plans
      WHERE deleted_at IS NULL
        AND ($1='%%' OR shipment_no ILIKE $1 OR bl_no ILIKE $1)
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 80`, [s]);
  return r.rows;
}

async function detail(pool, key) {
  const pr = await pool.query(
    `SELECT * FROM shipping_plans WHERE _id=$1 OR id::text=$1 OR shipment_no=$1 OR bl_no=$1 LIMIT 1`, [key]);
  if (!pr.rows.length) return null;
  const plan = pr.rows[0];
  const bills = await pool.query(
    `SELECT id, bl_no, cost_category, amount, sale_amount, currency, qty, unit_price, charge_basis, remarks, raw
       FROM active_freight_supplier_bills
      WHERE bl_no=$1 OR link_plan_id=$2
      ORDER BY id`, [plan.bl_no, plan._id]);
  return { plan, bills: bills.rows, standards: await standards(pool, plan), fee_items: await feeItems(pool) };
}

async function saveBill(pool, plan, row, user, terms, warnings) {
  const payerResult = await resolvePayer(pool, plan, row);
  let payer = clean(row.payer_company_code || row.payer);
  if (payerResult.owned && !payer) payer = payerResult.payer;
  if (!payerResult.owned) {
    payer = "";
    if (warnings) warnings.push("无我方订单,归属待定,已建待归属任务");
    await pool.query(
      `INSERT INTO tasks (id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', 'payer-guard', 'logistics', $4, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [`payer-${clean(plan.bl_no)}`, "货代账单待归属", "无我方订单却挂巴匕应付", clean(plan.bl_no)]);
  }
  const direction = clean(row.direction || row.inout || "付");
  const qty = n(row.qty) ?? 1;
  const unit = n(row.unit_price) ?? 0;
  const total = n(row.amount) ?? Number((unit * qty).toFixed(2));
  const norm = await normalizeChargeName(pool, row.cost_category || row.fee_name, plan.carrier_code || plan.shipping_line || carrierFromBl(plan.bl_no), plan.bl_no);
  const amount = total;
  let sale = direction === "收" ? (n(row.sale_amount) ?? total) : 0;
  if (sale > 0) {
    const g = guardBillRow({ cost_category: norm.name, currency: row.currency, sale_amount: sale }, terms);
    if (g.warning) { sale = g.sale; if (warnings) warnings.push(g.warning); }
  }
  const raw = { original_name: norm.original_name, unmapped: !!norm.unmapped, entry_direction: direction };
  const vals = [plan.bl_no, String(plan.id), norm.name, amount, clean(row.currency || "CNY"), sale, qty, unit, clean(row.charge_basis || row.unit), clean(row.remarks), ym(row.bill_month), JSON.stringify(raw), payer || null];
  if (row.id) {
    vals.push(row.id);
    const r = await pool.query(
      `UPDATE freight_supplier_bills
          SET bl_no=$1, link_plan_id=$2, cost_category=$3, amount=$4, currency=$5, sale_amount=$6,
              qty=$7, unit_price=$8, charge_basis=$9, remarks=$10, bill_month=$11, raw=$12,
              payer_company_code=$13, updated_at=now()
        WHERE id=$14 RETURNING *`, vals);
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO freight_supplier_bills
       (bl_no, link_plan_id, cost_category, amount, currency, sale_amount, qty, unit_price, charge_basis, remarks, bill_month, raw, payer_company_code, supplier, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'录入表单',now(),now())
     RETURNING *`, vals);
  return r.rows[0];
}

async function save(pool, body, user) {
  const key = clean(body.id || body._id || body.shipment_no || body.bl_no);
  if (!key) throw new Error("shipment id required");
  const old = await detail(pool, key);
  if (!old) throw new Error("shipment not found");
  const p = body.plan || body;
  const saleUsd = n(p.freight_sale_usd ?? (String(old.plan.container_type).includes("20") ? p.actual_20gp_usd : p.actual_40hq_usd));
  const vals = [clean(p.status || p.flow_status || old.plan.flow_status), p.etd || old.plan.etd, saleUsd, n(p.freight_sale_cny), clean(p.remarks ?? old.plan.remarks), old.plan._id];
  const pr = await pool.query(
    `UPDATE shipping_plans
        SET flow_status=$1, etd=$2, freight_sale_usd=COALESCE($3,freight_sale_usd),
            freight_sale_cny=COALESCE($4,freight_sale_cny), remarks=$5, updated_at=now()
      WHERE _id=$6 RETURNING *`, vals);
  const saved = [];
  for (const row of (body.lines || [])) {
    const _terms = await ticketTerms(pool, pr.rows[0]);
    if (clean(row.cost_category || row.fee_name)) saved.push(await saveBill(pool, pr.rows[0], row, user, _terms, body.__warnings = body.__warnings || []));
  }
  return { plan: pr.rows[0], lines: saved };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "GET") {
      if (req.query.id) return res.status(200).json({ success: true, data: await detail(pool, req.query.id) });
      return res.status(200).json({ success: true, data: await listPlans(pool, req.query), fee_items: await feeItems(pool) });
    }
    if (req.method === "PATCH" || req.method === "POST") {
      const body = req.body || {};
      const data = await save(pool, body, req.user);
      return res.status(200).json({ success: true, data, warnings: body.__warnings || [] });
    }
    res.status(405).json({ success: false, error: "GET/PATCH/POST required" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
