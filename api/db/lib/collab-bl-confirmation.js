import { rawToHash } from "./collab-shared.js";
import { freezePlanCustomerDocs } from "./collab-customer-doc-freeze.js";

const FINAL = new Set(["customer_confirmed", "submitted", "submitted_to_carrier", "auto_submitted"]);
const CLEARANCE_BY_COUNTRY = {
  bangladesh: ["TT ISSUING BANK", "TT REFERENCE NO.", "TT DATE", "IRC NO.", "IMPORTER TIN", "IMPORTER BIN"],
  bd: ["TT ISSUING BANK", "TT REFERENCE NO.", "TT DATE", "IRC NO.", "IMPORTER TIN", "IMPORTER BIN"],
};
let companyPreferenceReady = false;

function rawObj(v) {
  if (!v) return {};
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (_) { return {}; }
  }
  return v;
}

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function addHours(v, h) {
  return v ? new Date(new Date(v).getTime() + h * 3600000) : null;
}

function clean(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function boolOrNull(v) {
  return typeof v === "boolean" ? v : null;
}

// 从中英混排里取英文段（客户页是全英文）。取不到就原样返回，⛔ 不自己翻译。
function enPart(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t) return "";
  const m = t.match(/[A-Za-z][A-Za-z0-9 ,.'()\/-]{2,}/);
  return m ? m[0].trim() : t;
}

function first(...xs) {
  return xs.find(x => clean(x)) || "";
}

function countryKey(row) {
  const raw = rawObj(row.raw);
  const orders = Array.isArray(row.orders) ? row.orders : [];
  return clean(first(raw.consignee_country, raw.destination_country, orders[0]?.country, row.pod), 80).toLowerCase();
}

function clearanceFields(row, gate) {
  const fields = CLEARANCE_BY_COUNTRY[countryKey(row)] || [];
  const vals = rawObj(gate.clearance_docs || rawObj(row.raw).customer_clearance_docs);
  return fields.map(label => ({ label, value: clean(vals[label] || vals[label.toLowerCase().replace(/\s+/g, "_")]) }));
}

function hsLines(row, gate) {
  const override = Array.isArray(gate.hs_lines) ? gate.hs_lines : null;
  if (override) return override.map((x, i) => ({ sku: clean(x.sku || `Line ${i + 1}`, 80), code: clean(x.code, 40) }));
  const seen = new Set();
  const out = [];
  for (const o of Array.isArray(row.orders) ? row.orders : []) {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const sku = clean(it.sku || it.barcode || it.description || "Line", 80);
      const code = clean(it.hs_code, 40);
      const key = sku + "\n" + code;
      if (!seen.has(key)) { out.push({ sku, code }); seen.add(key); }
    }
  }
  return out;
}

function goodsLines(row) {
  const map = new Map();
  for (const o of Array.isArray(row.orders) ? row.orders : []) {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const name = clean(it.description || it.product_name || "Goods", 160);
      const cur = map.get(name) || { description: name, cartons: 0, gross_weight_kg: 0, cbm: 0 };
      cur.cartons += Number(it.ctns || 0);
      cur.gross_weight_kg += Number(it.gw_kgs || 0);
      cur.cbm += Number(it.cbm || 0);
      map.set(name, cur);
    }
  }
  return [...map.values()].map(x => ({
    description: x.description,
    cartons: x.cartons || null,
    gross_weight_kg: x.gross_weight_kg ? Math.round(x.gross_weight_kg * 10) / 10 : null,
    cbm: x.cbm ? Math.round(x.cbm * 1000) / 1000 : null,
  }));
}

function snapshot(row) {
  const raw = rawObj(row.raw);
  const gate = rawObj(raw.bl_confirmation);
  const deadline = addHours(row.si_cutoff_date, -5);
  return {
    version: clean(gate.version || gate.draft_version || "1", 30),
    status: clean(gate.status || "awaiting_customer_confirmation", 60),
    deadline_at: iso(deadline),
    deadline_tz: "GMT+8",
    // 发货人真源顺序：闸门快照 → raw → 计划列 → seller_profiles(is_default)。
    // 实测 sp.issuing_company 是空的，客户页发货人栏会开天窗。
    // ⛔ 取不到就留空并由调用方 fail-closed，绝不回落成任何默认公司名。
    shipper: clean(first(gate.shipper, raw.shipper, row.issuing_company, row.seller_name_en), 1000),
    consignee: clean(first(gate.consignee, raw.consignee, row.customer_en, row.customer), 1000),
    notify: clean(first(gate.notify, raw.notify_party, raw.notify), 1000),
    // MAP_INDEX_TRAP_FIXED 2026-08-08：原写法 .map(clean) 会把下标当 maxLen，
    // clean(vessel,0)→"" / clean(voyage,1)→"2"，线上实测就印出了 "2"。
    vessel_voyage: [row.vessel, row.voyage].map(v => clean(v)).filter(Boolean).join(" / "),
    pol: clean(row.pol, 80),
    // 客户页是全英文：pod 库里存的是中英混排(如「巴生港西港 Port Klang Westport」)，
    // 取其中的英文段；没有英文段就原样给(总比空好)，⛔ 不自己翻译。
    pod: clean(enPart(row.pod), 80),
    etd: iso(row.etd),
    eta: iso(row.eta),
    goods: goodsLines(row),
    containers: (Array.isArray(row.containers) ? row.containers : []).map(x => ({
      container_no: clean(x.container_no, 40),
      seal_no: clean(x.seal_no, 40),
      type: clean(x.container_type, 40),
    })),
    factory_confirmed: gate.factory_confirmed === true,
    factory_confirmed_at: iso(gate.factory_confirmed_at),
    customer_confirmed: gate.status === "customer_confirmed",
    customer_action_at: iso(gate.customer_action_at),
    hs_show_on_bl: gate.hs_show_on_bl !== undefined ? gate.hs_show_on_bl !== false : row.bl_hs_show_default !== false,
    hs_lines: hsLines(row, gate),
    clearance_fields: clearanceFields(row, gate),
  };
}

async function validateCustomer(pool, token) {
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role='customer_booking'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(token)]
  );
  if (!rows.length) return null;
  const meta = rawObj(rows[0].meta);
  return parseInt(meta.shipment_id, 10) || null;
}

async function loadPlan(pool, planId) {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.customer, sp.customer_en, sp.issuing_company, sp.raw,
            COALESCE(cc.bl_hs_show_default, cn.bl_hs_show_default) AS bl_hs_show_default,
            (SELECT name_en FROM seller_profiles WHERE is_default = TRUE LIMIT 1) AS seller_name_en,
            sp.vessel, sp.voyage, sp.pol, sp.pod, sp.etd, sp.eta, sp.si_cutoff_date,
            COALESCE((SELECT json_agg(json_build_object(
              'container_no', cb.container_no, 'seal_no', cb.seal_no, 'container_type', cb.container_type))
              FROM container_bookings cb WHERE cb.shipping_plan_id=sp.id), '[]'::json) AS containers,
            COALESCE((SELECT json_agg(json_build_object('order_no', o.order_no, 'country', o.country, 'items',
              COALESCE((SELECT json_agg(json_build_object(
                'sku', oli.sku, 'barcode', oli.barcode, 'description', COALESCE(NULLIF(BTRIM(oli.product_name),''), NULLIF(BTRIM(oli.declaration_name),'')),
                'product_name', oli.product_name, 'hs_code', oli.hs_code, 'ctns', oli.qty_ctn,
                'gw_kgs', ROUND((COALESCE(oli.gw_ctn,0)*COALESCE(oli.qty_ctn,0))::numeric,1),
                'cbm', ROUND((COALESCE(oli.cbm_ctn,0)*COALESCE(oli.qty_ctn,0))::numeric,3)))
                FROM order_line_items oli WHERE oli.order_id=o.id), '[]'::json)))
              FROM orders o WHERE o.shipping_plan_id=sp.id), '[]'::json) AS orders
       FROM shipping_plans sp
       LEFT JOIN companies cc ON cc.id = sp.customer_company_id
       LEFT JOIN LATERAL (
         SELECT c.bl_hs_show_default
           FROM orders o JOIN companies c ON c.id = o.customer_company_id OR (o.customer <> '' AND (c.name_en = o.customer OR c.name_cn = o.customer))
          WHERE o.shipping_plan_id = sp.id
          ORDER BY o.id LIMIT 1
       ) cn ON TRUE
       WHERE sp.id=$1 LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

async function ensureCompanyPreference(pool) {
  if (companyPreferenceReady) return;
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS bl_hs_show_default boolean`);
  companyPreferenceReady = true;
}

async function initGatePreference(pool, row) {
  const raw = rawObj(row.raw);
  const gate = rawObj(raw.bl_confirmation);
  if (gate.hs_show_on_bl !== undefined || row.bl_hs_show_default === null || row.bl_hs_show_default === undefined) return row;
  const next = { ...gate, hs_show_on_bl: row.bl_hs_show_default !== false };
  await pool.query(
    `UPDATE shipping_plans
        SET raw=jsonb_set(COALESCE(raw,'{}'::jsonb), '{bl_confirmation}', $2::jsonb, true),
            updated_at=NOW()
      WHERE id=$1`,
    [row.id, JSON.stringify(next)]
  );
  row.raw = { ...raw, bl_confirmation: next };
  return row;
}

async function saveCompanyPreference(pool, planId, hsShow) {
  const pref = boolOrNull(hsShow);
  if (pref === null) return;
  await ensureCompanyPreference(pool);
  await pool.query(
    `WITH matched AS (
       SELECT DISTINCT c2.id FROM orders o JOIN companies c2 ON c2.name_en=o.customer OR c2.name_cn=o.customer WHERE o.shipping_plan_id=$1
     ), target AS (
       SELECT COALESCE(
         (SELECT sp.customer_company_id FROM shipping_plans sp WHERE sp.id=$1),
         (SELECT o.customer_company_id FROM orders o WHERE o.shipping_plan_id=$1 AND o.customer_company_id IS NOT NULL ORDER BY o.id LIMIT 1),
         (SELECT CASE WHEN COUNT(*)=1 THEN MAX(id) END FROM matched)
       ) AS id
     )
     UPDATE companies c SET bl_hs_show_default=$2 FROM target WHERE c.id=target.id`,
    [planId, pref]
  );
}

async function ensureEvents(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS bl_confirmation_events (
    id BIGSERIAL PRIMARY KEY, shipping_plan_id INTEGER NOT NULL, shipment_no TEXT, bl_no TEXT,
    order_nos TEXT[], version TEXT NOT NULL, action_type TEXT NOT NULL, trigger_type TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), customer_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    message TEXT, customer_send_enabled BOOLEAN NOT NULL DEFAULT FALSE, customer_send_result JSONB,
    task_id VARCHAR(32), event_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function handleBlConfirmation(req, res, pool) {
  const token = (req.method === "GET" ? req.query?.token : req.body?.token) || "";
  if (!token) return res.status(400).json({ ok: false, error: "token_required" });
  const planId = await validateCustomer(pool, token);
  if (!planId) return res.status(403).json({ ok: false, error: "invalid_token" });
  await ensureCompanyPreference(pool);
  let row = await loadPlan(pool, planId);
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  row = await initGatePreference(pool, row);
  const snap = snapshot(row);
  if (req.method === "GET") return res.json({ ok: true, draft: snap });

  const action = clean(req.body?.action, 40);
  if (!["confirm", "request_changes"].includes(action))
    return res.status(400).json({ ok: false, error: "invalid_action" });
  if (FINAL.has(snap.status)) return res.status(409).json({ ok: false, error: "already_final" });

  await ensureEvents(pool);
  const raw = rawObj(row.raw);
  const changes = (req.body?.changes && typeof req.body.changes === "object") ? req.body.changes : {};
  const next = {
    ...rawObj(raw.bl_confirmation),
    status: action === "confirm" ? "customer_confirmed" : "revision_requested",
    customer_action_at: new Date().toISOString(),
    customer_snapshot: snap,
    changes: action === "request_changes" ? changes : null,
  };
  if (Array.isArray(changes.hs_lines)) next.hs_lines = changes.hs_lines.map((x, i) => ({ sku: clean(x?.sku || `Line ${i + 1}`, 80), code: clean(x?.code, 40) })).filter(x => x.sku || x.code);
  if (typeof changes.hs_show_on_bl === "boolean") next.hs_show_on_bl = changes.hs_show_on_bl;
  if (changes.clearance_docs && typeof changes.clearance_docs === "object" && !Array.isArray(changes.clearance_docs)) next.clearance_docs = changes.clearance_docs;
  if (action === "request_changes") next.timer_paused = true;
  await pool.query(
    `UPDATE shipping_plans
        SET raw=jsonb_set(COALESCE(raw,'{}'::jsonb), '{bl_confirmation}', $2::jsonb, true),
            updated_at=NOW()
      WHERE id=$1`,
    [planId, JSON.stringify(next)]
  );
  await pool.query(
    `INSERT INTO bl_confirmation_events
       (shipping_plan_id, version, action_type, trigger_type, customer_snapshot, message, event_key)
     VALUES ($1,$2,$3,'customer_page',$4::jsonb,$5,$6)
     ON CONFLICT (event_key) DO NOTHING`,
    [planId, snap.version, action === "confirm" ? "customer_confirm" : "revision_request",
     JSON.stringify({ ...snap, changes: next.changes }), action, `${planId}:${action}:customer_page:${snap.version}`]
  );
  if (action === "confirm") {
    await saveCompanyPreference(pool, planId, next.hs_show_on_bl);
    try {
      const frozen = await freezePlanCustomerDocs(pool, planId, {
        generatedBy: "customer_booking",
        trigger: "bl_confirmed",
      });
      console.log("[doc-freeze] bl_confirmed plan", planId, JSON.stringify(frozen.docs));
    } catch (e) { console.error("[doc-freeze] fail", e && e.message); }
    // 客户确认提单后 → OCEANBABY(ob@) 自动把单据(托书/排载单)发到对方业务邮箱。
    // 不阻塞确认响应(fire-and-forget)；真发受 DOC_MAIL_LIVE 门控(默认 dry-run 只记日志)。
    import("./collab-doc-mailer.js")
      .then(m => m.sendPlanDocs(pool, planId, { trigger: "bl_confirmed" }))
      .then(r => console.log("[doc-mailer] bl_confirmed plan", planId, JSON.stringify(r && (r.sends || r.reason || (r.dryrun ? "dryrun" : r.error)))))
      .catch(e => console.error("[doc-mailer] fail", e && e.message));
  }
  return res.json({ ok: true, draft: { ...snap, status: next.status, hs_lines: next.hs_lines || snap.hs_lines, hs_show_on_bl: next.hs_show_on_bl !== false, customer_confirmed: next.status === "customer_confirmed" } });
}

export { handleBlConfirmation };
