// collab-misc.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { requireAuth } from "../../auth.js";
import { rawToHash } from "./collab-shared.js";
import vesselMapHandler from "../../vessel-map.js";

// ── GET /vessel-track?token=<raw> ──────────────────────────────
// 客户协同页拿真船位:客户没有登录态,vessel-map 直调会 401。这里用 collab token 换出
// 本票 BL 的 portun token+subscriptionId(复用 vessel-map 全部成本守卫+缓存订阅,不新增花费),
// 前端据此内嵌 portun-map.html 显示真 GPS 船位。只放行 portun_allowed 的票,否则 tracked:false 退回航线示意图。
async function handleVesselTrack(req, res, pool) {
  const raw = (req.query && req.query.token) || "";
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT sp.bl_no, (sp.raw->>'portun_allowed') AS allowed
       FROM magic_links ml
       JOIN shipping_plans sp ON sp.id = NULLIF(ml.meta->>'shipment_id','')::int
      WHERE ml.token_hash = $1 AND ml.recipient_role = 'customer_booking'
        AND ml.revoked_at IS NULL AND ml.expires_at > NOW() LIMIT 1`,
    [rawToHash(raw)]
  );
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const blNo = (rows[0].bl_no || "").trim();
  if (rows[0].allowed !== "true" || !blNo) return res.json({ ok: true, tracked: false });

  // 复用 vessel-map handler:mock res 抓返回。它内部走 DB 缓存(30天内不重复订阅=不重复收费)。
  const cap = { code: 200, body: null };
  const mockRes = { setHeader() {}, status(c) { cap.code = c; return this; }, json(j) { cap.body = j; return this; }, end() { return this; } };
  try { await vesselMapHandler({ method: "POST", body: { blNo } }, mockRes); }
  catch (e) { return res.json({ ok: true, tracked: false, error: String(e.message || e) }); }
  const d = cap.body || {};
  return res.json({
    ok: true,
    tracked: !d.arrived && !!d.token && !!d.subscriptionId,
    blNo, carrierCode: d.carrierCode || null,
    token: d.token || null, subscriptionId: d.subscriptionId || null,
    arrived: !!d.arrived, reason: d.reason || null,
  });
}

// ── GET /validate?token=<raw> ──────────────────────────────────
async function handleCustomsDocStatus(req, res, pool) {
  if (!requireAuth(req, res)) return;

  const { plan_id, contract_no } = req.query || {};
  if (!plan_id && !contract_no) {
    return res.status(400).json({ ok: false, error: "plan_id or contract_no required" });
  }

  const vals = [];
  const where = [];
  if (plan_id) {
    vals.push(String(plan_id));
    where.push(`(sp._id = $${vals.length} OR sp.id::text = $${vals.length})`);
  }
  if (contract_no) {
    vals.push(String(contract_no));
    where.push(`o.contract_no = $${vals.length}`);
  }

  const { rows } = await pool.query(`
    SELECT sp.id,
           sp.customs_arrange,
           min(o.order_no) AS doc_id,
           min(o.contract_no) AS contract_no,
           count(DISTINCT o.contract_no) FILTER (WHERE o.contract_no IS NOT NULL AND o.contract_no <> '') AS contract_count,
           bool_or(du.doc_type IN ('customs_decl','customs_declaration')) AS uploaded,
           max(CASE WHEN du.doc_type IN ('customs_decl','customs_declaration')
                    THEN COALESCE(du.stamped_url, du.url) END) AS customs_url
      FROM shipping_plans sp
      LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      LEFT JOIN document_uploads du ON du.contract_no = o.contract_no
     WHERE ${where.join(" AND ")}
     GROUP BY sp.id, sp.customs_arrange
     LIMIT 1`,
    vals
  );

  if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

  const row = rows[0];
  return res.json({
    ok: true,
    show: row.customs_arrange !== "self",
    uploaded: !!row.uploaded,
    customs_url: row.customs_url || null,
    need_manual: Number(row.contract_count || 0) > 1,
    doc_id: row.doc_id || null,
    contract_no: row.contract_no || contract_no || null,
  });
}

// ── GET /collab-messages?plan_id=xxx ─────────────────────────────────────────
// Returns message threads grouped by party from collab_party_messages.
async function handleCollabMessages(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`, [planId]);
  if (!planRow.rows.length) return res.json({ ok: true, threads: {} });
  const numId = planRow.rows[0].id;
  const r = await pool.query(
    `SELECT id, party, direction, body, author, created_at
       FROM collab_party_messages
      WHERE shipping_plan_id = $1
      ORDER BY created_at ASC`, [numId]);
  const threads = {};
  for (const m of r.rows) {
    if (!threads[m.party]) threads[m.party] = [];
    threads[m.party].push({ id: m.id, direction: m.direction || "sanlyn", body: m.body, author: m.author, created_at: m.created_at });
  }
  return res.json({ ok: true, threads });
}

// ── POST /collab-message ─────────────────────────────────────────────────────
// Send a message to a party (direction="sanlyn" = outbound from us).
async function handlePostCollabMessage(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, party, from: dir, body: msgBody } = req.body || {};
  if (!plan_id || !party || !msgBody) return res.status(400).json({ ok: false, error: "plan_id/party/body 必填" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numId = planRow.rows[0].id;
  await pool.query(
    `INSERT INTO collab_party_messages (shipping_plan_id, party, direction, body, author, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [numId, party, dir || "sanlyn", msgBody, dir || "sanlyn"]);
  return res.json({ ok: true });
}

// ── GET /shipment-orders?plan_id=xxx ─────────────────────────────────────────
// Returns orders currently in this plan + unassigned candidates for same customer.
async function handleShipmentOrders(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const planRow = await pool.query(
    `SELECT id, _id, customer, customer_en, pol, pod, raw FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`,
    [planId]);
  if (!planRow.rows.length) return res.json({ ok: true, current: [], candidates: [], plan: null });
  const plan = planRow.rows[0];
  const raw = (typeof plan.raw === "string" ? JSON.parse(plan.raw) : plan.raw) || {};

  // current: orders with shipping_plan_id pointing here
  const curR = await pool.query(
    `SELECT o.id, o.order_no, o.factory, o.customer, o.company_code,
            o.trade_terms, o.issuing_company,
            COALESCE(o.company_name_en, o.company_name_cn, o.customer, o.company_code, '') AS customer_label,
            COALESCE((SELECT SUM(qty_ctn) FROM order_line_items WHERE order_id = o.id), 0)::int AS total_qty
       FROM orders o
      WHERE o.shipping_plan_id = $1 AND (o.status IS NULL OR o.status NOT IN ('cancelled'))
      ORDER BY o.order_no`,
    [plan.id]);

  // candidates: active orders for same customer not yet assigned to any plan
  const custName = plan.customer_en || plan.customer || "";
  let candR = { rows: [] };
  if (custName) {
    candR = await pool.query(
      `SELECT o.id, o.order_no, o.factory, o.customer, o.pol, o.company_code,
              COALESCE(o.company_name_en, o.company_name_cn, o.customer, o.company_code, '') AS customer_label,
              COALESCE((SELECT SUM(qty_ctn) FROM order_line_items WHERE order_id = o.id), 0)::int AS total_qty
        FROM orders o
       WHERE o.shipping_plan_id IS NULL
          AND o.status IN ('confirmed', 'ready')
          AND (o.customer ILIKE $1 OR o.company_name_en ILIKE $1 OR o.company_name_cn ILIKE $1
               OR o.company_code IN (
                 SELECT company_code FROM companies
                  WHERE name_en ILIKE $1 OR name_cn ILIKE $1 LIMIT 5
               ))
        ORDER BY o.order_no LIMIT 20`,
      [`%${custName.trim()}%`]);
  }

  const candidates = candR.rows.map(o => {
    const reasons = [];
    if (plan.pol && o.pol && o.pol !== plan.pol) reasons.push(`POL不符(${o.pol}≠${plan.pol})`);
    if (plan.pod && o.pod && o.pod !== plan.pod) reasons.push(`POD不符(${o.pod}≠${plan.pod})`);
    return { ...o, match: { ok: reasons.length === 0, reasons } };
  });

  const shipDate = raw.shipment_date || null;
  const shipped = raw.shipped === true || !!shipDate;
  // 读时派生:本票挂着的订单里一致的值,供前端自动带(只在计划字段空时用,不落库)
  const uniq = (f) => [...new Set(curR.rows.map(r => (r[f] == null ? "" : String(r[f]).trim())).filter(Boolean))];
  const one = (f) => { const a = uniq(f); return a.length === 1 ? a[0] : null; };
  const derived = {
    freight_term: one("trade_terms"),
    issuing_company: one("issuing_company"),
    factory: one("factory"),
    customer: one("customer"),
    freight_term_conflict: uniq("trade_terms").length > 1 ? uniq("trade_terms") : null,
  };
  return res.json({
    ok: true,
    current: curR.rows,
    candidates,
    derived,
    plan: { id: plan.id, _id: plan._id, version: raw.version || 1, shipped, shipment_date: shipDate },
  });
}

export { handleCustomsDocStatus, handleCollabMessages, handlePostCollabMessage, handleShipmentOrders, handleVesselTrack };
