// collab-sailings-plans.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import fs from "fs";
import { requireAuth } from "../../auth.js";
import { derivePlanFactories } from "../booking-collab-view.js";
import { rawToHash } from "./collab-shared.js";

// ── GET /sailings?token=<raw> ─────────────────────────────────
async function handleGetSailings(req, res, pool) {
  const raw = req.query && req.query.token;
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(raw);
  const { rows: lnk } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role IN ('factory_booking','customer_booking')
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!lnk.length) return res.status(403).json({ ok: false, error: "链接无效" });

  const meta = (typeof lnk[0].meta === "string" ? JSON.parse(lnk[0].meta) : lnk[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);

  const { rows } = await pool.query(
    `SELECT id, carrier, vessel, voyage, etd, eta, cutoff_date, rate_usd, currency, is_recommended
       FROM plan_sailings
      WHERE shipping_plan_id = $1
      ORDER BY etd ASC`,
    [planId]
  );
  return res.json({ ok: true, rows });
}

// ── POST /sailings (Sanlyn内部) ───────────────────────────────
async function handlePostSailing(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, freight_quote_id, carrier, vessel, voyage,
          etd, eta, cutoff_date, rate_usd, currency, is_recommended } = req.body || {};
  if (!plan_id || !carrier || !etd)
    return res.status(400).json({ ok: false, error: "plan_id / carrier / etd 必填" });

  // Accept either integer id or varchar _id
  let numericId;
  if (/^\d+$/.test(String(plan_id))) {
    numericId = parseInt(plan_id, 10);
  } else {
    const r = await pool.query(`SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
    numericId = r.rows[0].id;
  }

  const r = await pool.query(
    `INSERT INTO plan_sailings
       (shipping_plan_id, freight_quote_id, carrier, vessel, voyage,
        etd, eta, cutoff_date, rate_usd, currency, is_recommended)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [numericId, freight_quote_id || null, carrier, vessel || null, voyage || null,
     etd, eta || null, cutoff_date || null, rate_usd || null, currency || "USD", is_recommended || false]
  );
  return res.json({ ok: true, id: r.rows[0].id });
}

// ── GET /plan/:id  (Sanlyn内部 JWT) ──────────────────────────
async function handleGetPlan(req, res, pool, planId) {
  if (!requireAuth(req, res)) return;
  const numId = parseInt(planId, 10);
  if (!numId) return res.status(400).json({ ok: false, error: "无效 plan id" });

  const planRes = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
            sp.vessel, sp.voyage, sp.container_type, sp.collab_status,
            sp.customer AS customer_name, sp.customer_en,
            sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
            sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
            sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
            sp.customer_remarks, sp.customer_submitted_at,
            sp.raw->'factory_bill_versions' AS factory_bill_versions,
            sp.raw->>'factory_bill_current_version' AS factory_bill_current_version,
            sp.raw->>'finance_bill_sent_at' AS finance_bill_sent_at,
            sp.raw->>'finance_bill_sent_by' AS finance_bill_sent_by,
            sp.raw->>'factory_bill_confirmed_at' AS factory_bill_confirmed_at,
            sp.raw->>'factory_bill_confirmed_by' AS factory_bill_confirmed_by,
            sp.raw->>'prebill_status' AS prebill_status,
            sp.raw->>'prebill_confirmed_at' AS prebill_confirmed_at,
            sp.raw->'pricing_decisions' AS pricing_decisions,
            COALESCE(
              json_agg(
                json_build_object(
                  'order_no', o.order_no,
                  'items', (
                    SELECT COALESCE(json_agg(json_build_object(
                      'sku', oli.sku, 'description', oli.declaration_name,
                      'hs_code', oli.hs_code, 'ctns', oli.qty_ctn, 'gw_kgs', oli.gw_ctn
                    )), '[]'::json)
                    FROM order_line_items oli WHERE oli.order_id = o.id
                  )
                )
              ) FILTER (WHERE o.id IS NOT NULL), '[]'::json
            ) AS orders
       FROM shipping_plans sp
       LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      WHERE sp.id = $1
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
               sp.vessel, sp.voyage, sp.container_type, sp.collab_status,
               sp.customer, sp.customer_en,
               sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
               sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
               sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
               sp.customer_remarks, sp.customer_submitted_at`,
    [numId]
  );
  if (!planRes.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const sailingsRes = await pool.query(
    `SELECT id, carrier, vessel, voyage, etd, eta, cutoff_date, rate_usd, currency, is_recommended
       FROM plan_sailings WHERE shipping_plan_id = $1 ORDER BY etd ASC`,
    [numId]
  );
  return res.json({ ok: true, booking_sheet: { ...planRes.rows[0], sailings: sailingsRes.rows } });
}

// ── PATCH /plan/:id (Sanlyn内部 JWT) — 直接改字段 ────────────
async function handlePatchPlan(req, res, pool, planId) {
  if (!requireAuth(req, res)) return;
  const numId = parseInt(planId, 10);
  if (!numId) return res.status(400).json({ ok: false, error: "无效 plan id" });

  const allowed = ["collab_status","vessel","voyage","etd","eta","container_type",
                   "factory_cargo_ready","factory_container_type","factory_cargo_type","factory_remarks"];
  const sets = [], vals = [];
  const body = req.body || {};
  for (const k of allowed) {
    if (k in body) { vals.push(body[k]); sets.push(`${k} = $${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "没有可更新的字段" });
  vals.push(numId);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// ── DELETE /sailings/:id (Sanlyn内部) ────────────────────────
async function handleDeleteSailing(req, res, pool, sailingId) {
  if (!requireAuth(req, res)) return;
  if (!sailingId) return res.status(400).json({ ok: false, error: "sailing id 必填" });
  await pool.query(`DELETE FROM plan_sailings WHERE id = $1`, [sailingId]);
  return res.json({ ok: true });
}

// ── GET /plans-list?q=... (Sanlyn内部 JWT) ───────────────────
async function handlePlansList(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const q = (req.query && req.query.q) || "";
  const { rows } = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod,
            sp.etd, sp.customer, sp.customer_en, sp.vessel, sp.voyage,
            sp.collab_status, sp.container_type, sp.factory_cargo_ready,
            COUNT(o.id) AS order_count
       FROM shipping_plans sp
       LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      WHERE ($1 = ''
          OR sp.shipment_no ILIKE '%' || $1 || '%'
          OR sp.customer    ILIKE '%' || $1 || '%'
          OR sp.customer_en ILIKE '%' || $1 || '%')
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod,
               sp.etd, sp.customer, sp.customer_en, sp.vessel, sp.voyage,
               sp.collab_status, sp.container_type, sp.factory_cargo_ready
      ORDER BY sp.id DESC
      LIMIT 15`,
    [q]
  );
  return res.json({ ok: true, plans: rows });
}

// ── GET /plan-factories?plan_id=<_id> ── 弹窗分厂行：哪些厂、各管几柜
async function handlePlanFactories(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planRef = String((req.query && req.query.plan_id) || "");
  if (!planRef) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const { rows: pr } = await pool.query(
    `SELECT id, container_type, container_qty, raw FROM shipping_plans WHERE _id = $1 OR id::text = $1`, [planRef]);
  if (!pr.length) return res.status(404).json({ ok: false, error: "找不到计划" });
  const plan = pr[0];
  const raw = plan.raw || {};
  const fs = raw.factory_submits || {};
  const map = new Map();
  const put = (label, patch = {}) => {
    if (!label) return;
    const cur = map.get(label) || { label, seqs: [], qty: null, note: null };
    map.set(label, { ...cur, ...patch,
      seqs: (cur.seqs && cur.seqs.length) ? cur.seqs : (patch.seqs || []),
      qty: cur.qty || patch.qty || null, note: cur.note || patch.note || null });
  };
  // 1) 录单/人工写的分厂分配（最权威）
  for (const f of (Array.isArray(raw.factories_alloc) ? raw.factories_alloc : []))
    put(f.label, { seqs: f.seqs || [], qty: f.qty || (f.seqs || []).length || null, note: f.note });
  // 2) 已发的分柜链接 scope
  const { rows: ml } = await pool.query(
    `SELECT DISTINCT meta->'factory_scope' AS scope FROM magic_links
      WHERE recipient_role='factory_booking' AND (meta->>'shipment_id')::int = $1
        AND meta->'factory_scope' IS NOT NULL AND revoked_at IS NULL`, [plan.id]);
  for (const r of ml) { const s = r.scope || {}; put(s.label, { seqs: s.seqs || [] }); }
  // 3) 计划阶段记录的工厂名（无柜分配）
  for (const name of (Array.isArray(raw.factories) ? raw.factories : [])) put(name, {});
  // 4) 已提交的厂标
  for (const label of Object.keys(fs)) put(label, {});
  let factories = [...map.values()].map(f => ({ ...f,
    qty: f.qty || (f.seqs || []).length || null, submitted: !!fs[f.label] }));
  if (!factories.length) factories = await derivePlanFactories(pool, plan.id);
  return res.json({ ok: true, container_type: plan.container_type,
    container_qty: plan.container_qty, factories });
}

export { handleGetSailings, handlePostSailing, handleGetPlan, handlePatchPlan, handleDeleteSailing, handlePlansList, handlePlanFactories };
