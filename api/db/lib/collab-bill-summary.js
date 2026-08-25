import { requireAuth } from "../../auth.js";
import { rawToHash } from "./collab-shared.js";

const INTERNAL_PROFILES = new Set(["shipping_booking", "upstream_downstream"]);
const ROLE_SEGMENT = {
  supplier_portal: { segment: "port_charge" },
  broker_booking: { segment: "customs" },
  trucking_booking: { segment: "trucking" },
};
const OWN_COMPANY_COL = {
  supplier_portal: "forwarder_company_id",
  trucking_booking: "trucking_company_id",
  broker_booking: "customs_broker_id",
};
const ALL_SEGS = ["ocean", "trucking", "port_charge", "customs"];

function cleanText(v, max = 120) { return String(v || "").trim().slice(0, max); }
function normCcy(v) { return cleanText(v, 8).toUpperCase(); }
function segmentForCategory(cat) {
  return /拖车|陆运|truck/i.test(cat) ? "trucking"
    : /报关|超项|报检|custom/i.test(cat) ? "customs"
    : /海运|ocean|freight|运费/i.test(cat) ? "ocean"
    : "port_charge";
}
function totalsByCurrency(rows, valueOf = r => Number(r.amount || 0)) {
  return rows.reduce((a, r) => {
    const c = normCcy(r.currency || "CNY");
    a[c] = Number(((a[c] || 0) + valueOf(r)).toFixed(2));
    return a;
  }, {});
}

async function readBillToken(pool, token) {
  const roles = Object.keys(ROLE_SEGMENT);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role=ANY($2::text[])
        AND expires_at>NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(token), roles]
  );
  if (!rows.length) return null;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  return { role: rows[0].recipient_role, meta, planId: parseInt(meta.shipment_id, 10) };
}

async function billPlan(pool, planId) {
  const { rows } = await pool.query(
    `SELECT id, bl_no, hbl_no, pol, pod, container_type, container_qty, carrier_code, shipping_line
       FROM shipping_plans WHERE id=$1 LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

async function declarationStats(pool, planId) {
  const { rows } = await pool.query(
    `SELECT o.order_no,
            COALESCE(NULLIF(BTRIM(oli.declaration_name),''),NULLIF(BTRIM(oli.product_name),''),
              NULLIF(BTRIM(p.declaration_name),''),NULLIF(BTRIM(p.product_name),''),NULLIF(BTRIM(oli.sku),'')) AS name
       FROM orders o JOIN order_line_items oli ON oli.order_id=o.id
       LEFT JOIN products p ON p.sku=oli.sku
      WHERE o.shipping_plan_id=$1
         OR o.order_no IN (SELECT unnest(COALESCE((SELECT order_nos FROM shipping_plans WHERE id=$1),'{}'::text[])))`,
    [planId]
  );
  const names = [...new Set(rows.map(r => cleanText(r.name)).filter(Boolean))];
  const byOrder = {};
  for (const r of rows) {
    const order = cleanText(r.order_no || "unknown", 80), name = cleanText(r.name);
    if (name) (byOrder[order] ||= new Set()).add(name);
  }
  return {
    declaration_name_count: names.length,
    excess_item_count: Math.max(0, names.length - 5),
    per_order: Object.fromEntries(Object.entries(byOrder).map(([k, v]) => [k, v.size])),
    names,
  };
}

async function ownQuotePortal(pool, planId, role) {
  const col = OWN_COMPANY_COL[role];
  if (!col) return null;
  try {
    const { rows } = await pool.query(
      `SELECT t.code, t.forwarder_co, t.expires_at > NOW() AS alive
         FROM shipping_plans sp JOIN forwarder_portal_tokens t ON t.company_id = sp.${col}
        WHERE sp.id = $1 ORDER BY t.expires_at DESC LIMIT 1`,
      [planId]
    );
    const r = rows[0];
    if (!r || !r.code) return null;
    return { url: "/forwarder-quote/" + encodeURIComponent(r.code), company: r.forwarder_co || "", expired: !r.alive };
  } catch (e) {
    console.warn("[collab-billing] ownQuotePortal:", e.message);
    return null;
  }
}

function visibleSegments(auth, internal) {
  if (internal) return ALL_SEGS;
  if (!auth) return [];
  if (auth.role === "supplier_portal") {
    const scoped = Array.isArray(auth.meta?.segments)
      ? auth.meta.segments.map(normalizeSegment).filter(s => s && s !== "ocean")
      : [];
    return scoped.length ? scoped.filter(s => ALL_SEGS.includes(s)) : ["port_charge"];
  }
  const seg = ROLE_SEGMENT[auth.role]?.segment;
  return seg ? [seg] : [];
}

function normalizeSegment(seg) {
  const s = cleanText(seg, 20).toLowerCase();
  if (s === "truck") return "trucking";
  return s;
}

function segmentPayload(rows, internal) {
  const pending = rows.filter(r => r.pending && r.pending.status);
  const confirmed = rows.filter(r => r.confirmed_at && !(r.pending && r.pending.status));
  const visibleRows = internal ? rows : (confirmed.length ? confirmed : rows.filter(r => !(r.pending && r.pending.status)));
  const pick = r => internal
    ? Number(r.amount || 0)
    : (r.sale_amount != null ? Number(r.sale_amount) : Number(r.amount || 0));
  const lines = visibleRows.map(r => ({
    name: r.cost_category || "费用",
    qty: r.qty == null ? null : Number(r.qty),
    unit_price: r.unit_price == null ? null : Number(r.unit_price),
    amount: pick(r),
    currency: r.currency || "CNY",
    charge_basis: r.charge_basis || null,
    confirmed: !!r.confirmed_at,
    pending: !!(r.pending && r.pending.status),
  }));
  return {
    status: pending.length ? "待确认" : confirmed.length ? "已定" : rows.length ? "已录入" : "待贵司填",
    reported_by: [...new Set(visibleRows.map(r => r.supplier || r.supplier_type).filter(Boolean))],
    amount: totalsByCurrency(visibleRows, pick),
    pending_amount: internal ? totalsByCurrency(pending) : {},
    lines,
  };
}

export async function handleCollabBillSummary(req, res, pool) {
  const token = req.query && req.query.token;
  let planId = req.query && req.query.plan_id, internal = false, auth = null;
  if (token) {
    auth = await readBillToken(pool, token);
    if (!auth || !auth.planId) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
    planId = auth.planId;
    internal = INTERNAL_PROFILES.has(cleanText(auth.meta.field_profile));
  } else {
    if (!requireAuth(req, res)) return;
    internal = true;
  }
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const plan = await billPlan(pool, planId), blNo = plan && (plan.bl_no || plan.hbl_no);
  if (!plan) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  if (!blNo) return res.status(400).json({ ok: false, error: "BL 尚未录入，不能汇总账单" });
  const { rows } = await pool.query(
    `SELECT id,cost_category,amount,sale_amount,currency,qty,unit_price,charge_basis,supplier,supplier_type,
            confirmed_at,raw->'collab_pending' AS pending
       FROM freight_supplier_bills
      WHERE bl_no=$1 AND COALESCE(rebill_status,'') <> 'voided'`,
    [blNo]
  );
  const segs = { ocean: [], trucking: [], port_charge: [], customs: [] };
  for (const r of rows) (segs[segmentForCategory(r.cost_category)] || segs.port_charge).push(r);
  const segments = {};
  for (const k of visibleSegments(auth, internal)) segments[k] = segmentPayload(segs[k] || [], internal);
  const out = { ok: true, shipping_plan_id: plan.id, bl_no: blNo, segments };
  if (!internal && auth) {
    const qp = await ownQuotePortal(pool, plan.id, auth.role);
    if (qp && !qp.expired) out.quote_portal = qp;
  }
  if (internal) {
    const refs = await pool.query(
      `SELECT (SELECT row_to_json(lc) FROM local_charges lc
                WHERE ($1='' OR lc.pol ILIKE $1) AND ($2='' OR lc.pod ILIKE $2)
                ORDER BY lc.updated_at DESC LIMIT 1) AS local_charge_last,
              (SELECT json_agg(x) FROM (SELECT company_name, container_type, cost_total, sell_total, updated_at
                FROM local_charges WHERE ($1='' OR pol ILIKE $1) AND ($2='' OR pod ILIKE $2)
                ORDER BY updated_at DESC LIMIT 5) x) AS route_base`,
      [plan.pol || "", plan.pod || ""]
    );
    out.references = {
      local_charges_last: refs.rows[0].local_charge_last || null,
      route_base: refs.rows[0].route_base || [],
      declaration_stats: await declarationStats(pool, plan.id),
    };
  }
  return res.json(out);
}
