// api/partner-portal.js — Unified partner portal (Phase 1 + Codex fixes)
// Token-authenticated public endpoint. Routes:
//   GET  /api/p/:token                            → party + cards dashboard
//   GET  /api/p/:token/shipments/:planId          → projected collab sheet
//   POST /api/p/:token/quote                      → submit/update freight quote
//
// AUTH: token in URL path == external_tokens.token (UUID, not revoked, not expired)
// VISIBILITY: server-side projection whitelist — never spread base into all parties.

import { getPool, setCors } from "./db.js";
import { handleCollab, loadCard, projectCard } from "./partner-portal-collab.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 32 * 1024;       // 32KB per POST — partner forms are tiny
const MAX_NOTES_LEN = 2000;
const MAX_TEXT_LEN  = 200;        // vessel, voyage etc.

// ── Read body with size cap (DoS protection) ──
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) {
      const err = new Error("payload_too_large");
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { const err = new Error("invalid_json"); err.code = "INVALID_JSON"; throw err; }
}

// ── Generic 401 — do NOT reveal whether token was revoked vs expired vs not_found ──
function unauthorized(res) {
  res.writeHead(401, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── Authenticate token → party context (never leaks status detail) ──
async function authToken(pool, token, req) {
  if (!UUID_RE.test(token)) return null;

  const { rows } = await pool.query(`
    SELECT t.token, t.party_type, t.company_id, t.contact_name,
           t.expires_at, t.revoked_at, c.name_cn, c.name_en, c.code,
           t.role, t.card_id
    FROM external_tokens t
    JOIN companies c ON c.id = t.company_id
    WHERE t.token = $1
  `, [token]);
  if (!rows.length) return null;
  const tok = rows[0];
  if (tok.revoked_at) return null;
  if (tok.expires_at && new Date(tok.expires_at) < new Date()) return null;

  // Audit log (fire and forget but log failures to stderr)
  pool.query(`
    INSERT INTO external_token_access_log (token, path, method, ip, user_agent)
    VALUES ($1, $2, $3, $4, $5)
  `, [token, (req.url || "").slice(0, 500), req.method || "",
      req.ip || req.connection?.remoteAddress || "",
      (req.headers?.["user-agent"] || "").slice(0, 500)])
    .catch(e => console.error("[partner-portal] audit log failed:", e.message));

  // Throttled last_used update
  pool.query(`
    UPDATE external_tokens SET last_used_at = NOW(), last_used_ip = $2
    WHERE token = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')
  `, [token, req.ip || req.connection?.remoteAddress || ""])
    .catch(e => console.error("[partner-portal] last_used update failed:", e.message));

  return tok;
}

// ── Forwarder dashboard cards ──
async function forwarderCards(pool, companyId) {
  const { rows: items } = await pool.query(`
    SELECT i.id AS item_id, i.rfq_id, i.usd_rate, i.submitted_at,
           r.pol, r.pod, r.ctnr_type, r.etd, r.status AS rfq_status, r.awarded_item_id, r.order_id,
           o.order_no, o.contract_no
    FROM freight_rfq_items i
    JOIN freight_rfqs r ON r.id = i.rfq_id
    LEFT JOIN orders o ON o.id = r.order_id
    WHERE i.forwarder_company_id = $1
    ORDER BY r.etd ASC NULLS LAST
    LIMIT 200
  `, [companyId]);

  return items.map(row => {
    let state, label;
    if (row.awarded_item_id === row.item_id) { state = "awarded"; label = "🟢 已中标"; }
    else if (row.awarded_item_id && row.awarded_item_id !== row.item_id) { state = "not_selected"; label = "⚪ 未入选"; }
    else if (row.submitted_at) { state = "submitted"; label = "🟡 已报价等待"; }
    else { state = "pending"; label = "🔵 待报价"; }
    return {
      kind: "freight_quote",
      item_id: row.item_id,
      rfq_id: row.rfq_id,
      order_id: row.order_id,
      route: `${row.pol || "—"} → ${row.pod || "—"}`,
      pol: row.pol, pod: row.pod,
      ctnr_type: row.ctnr_type,
      etd: row.etd,
      state, label,
      my_rate_usd: row.usd_rate,
      contract_no: row.contract_no,
      order_no: row.order_no,
    };
  });
}

// ── Factory dashboard cards (scoped by factory_code) ──
async function factoryCards(pool, companyCode) {
  if (!companyCode) return [];
  const { rows } = await pool.query(`
    SELECT lcs.id, lcs.order_no, lcs.contract_no, lcs.status, lcs.due_at,
           lcs.shipping_plan_id, lcs.products, lcs.loading, lcs.photos,
           lcs.factory_visible_note, lcs.trade_terms, lcs.submitted_at,
           sp.vessel, sp.voyage, sp.etd, sp.pol, sp.pod
    FROM loading_collab_sheets lcs
    LEFT JOIN shipping_plans sp ON sp.id = lcs.shipping_plan_id
    WHERE lcs.factory_code = $1
    ORDER BY lcs.due_at ASC NULLS LAST
    LIMIT 200
  `, [companyCode]);
  return rows.map(r => {
    const hasContainer = r.loading?.container_no;
    const hasSeal = r.loading?.seal_no;
    const photoCount = Array.isArray(r.photos) ? r.photos.length : 0;
    let label = "🔵 待填写";
    if (r.status === "submitted" || r.status === "under_review") label = "🟢 已提交";
    else if (r.status === "approved" || r.status === "completed") label = "✅ 已完成";
    else if (r.status === "needs_revision") label = "🔴 需修改";
    else if (hasContainer && hasSeal) label = "🟡 填写中";
    return {
      kind: "factory_loading",
      sheet_id: r.id,
      order_no: r.order_no,
      plan_id: r.shipping_plan_id,
      contract_no: r.contract_no,
      status: r.status,
      submitted_at: r.submitted_at,
      due_at: r.due_at,
      label,
      vessel: r.vessel, voyage: r.voyage,
      etd: r.etd,
      route: r.pol && r.pod ? `${r.pol} → ${r.pod}` : null,
      trade_terms: r.trade_terms,
      factory_visible_note: r.factory_visible_note,
      products: Array.isArray(r.products) ? r.products.map(p => ({
        name: p?.name || null, sku: p?.sku || null, qty: p?.qty || null, unit: p?.unit || null,
      })) : [],
      loading_summary: {
        container_no: r.loading?.container_no || null,
        seal_no: r.loading?.seal_no || null,
        photo_count: photoCount,
      },
    };
  });
}

// ── Customer dashboard cards ──
async function customerCards(pool, companyCode) {
  if (!companyCode) return [];
  const { rows } = await pool.query(`
    SELECT sp.id, sp.contract_no, sp.vessel, sp.voyage, sp.etd, sp.pol, sp.pod, sp.shipping_status
    FROM shipping_plans sp
    JOIN orders o ON o.contract_no = sp.contract_no
    WHERE o.customer_code = $1
    ORDER BY sp.etd DESC NULLS LAST
    LIMIT 50
  `, [companyCode]);
  return rows.map(r => ({
    kind: "customer_shipment",
    plan_id: r.id,
    contract_no: r.contract_no,
    vessel: r.vessel, voyage: r.voyage, etd: r.etd,
    route: r.pol && r.pod ? `${r.pol} → ${r.pod}` : null,
    label: r.shipping_status || "在途中",
  }));
}

// ── EXPLICIT projection — each party gets its own object built from scratch ──
// No spread of `base` into all parties (Codex finding #1).
function projectForwarderView(plan, sheet) {
  return {
    contract_no: plan.contract_no,
    pol: plan.pol, pod: plan.pod,
    container_type: plan.container_type,
    vessel: plan.vessel, voyage: plan.voyage,
    etd: plan.etd, eta: plan.eta,
    so_no: plan.so_no,
    booking_no: plan.booking_no,
    stages: {
      booking: {
        vessel: plan.vessel, voyage: plan.voyage, etd: plan.etd,
        status: plan.booking_sent_at ? "confirmed" : "pending",
      },
      so: {
        so_no: plan.so_no, booking_no: plan.booking_no,
        status: plan.so_no ? "confirmed" : "awaiting",
      },
      loading:  null,
      trucking: null,
      customs:  null,
    },
  };
}

function projectFactoryView(plan, sheet) {
  // Whitelist sheet JSON children: only loading/photos/products with explicit sub-fields.
  const safeLoading = sheet?.loading ? {
    container_no: sheet.loading.container_no || null,
    seal_no:      sheet.loading.seal_no || null,
    gross_weight_kg: sheet.loading.gross_weight_kg || null,
    total_cartons:   sheet.loading.total_cartons || null,
    total_cbm:       sheet.loading.total_cbm || null,
    loaded_at:       sheet.loading.loaded_at || null,
  } : null;
  // Photos: array of URLs only, drop any embedded notes/metadata
  const safePhotos = Array.isArray(sheet?.photos)
    ? sheet.photos.slice(0, 50).map(p => typeof p === "string" ? p : (p?.url || null)).filter(Boolean)
    : [];
  // Products: name/qty only, never margin/cost/customer_price
  const safeProducts = Array.isArray(sheet?.products)
    ? sheet.products.slice(0, 100).map(p => ({
        name: p?.name || p?.product_name || null,
        sku:  p?.sku || null,
        qty:  p?.qty || p?.quantity || null,
        unit: p?.unit || null,
      }))
    : [];
  return {
    contract_no: plan.contract_no,
    pol: plan.pol, pod: plan.pod,
    container_type: plan.container_type,
    vessel: plan.vessel, voyage: plan.voyage,
    etd: plan.etd,
    stages: {
      booking: { vessel: plan.vessel, voyage: plan.voyage, etd: plan.etd },
      so:      { so_no: plan.so_no, container_type: plan.container_type },
      loading: sheet ? {
        status:  sheet.status,
        due_at:  sheet.due_at,
        loading: safeLoading,
        photos:  safePhotos,
        products: safeProducts,
        factory_visible_note: sheet.factory_visible_note || null,
      } : null,
      trucking: null,
      customs:  null,
    },
  };
}

function projectCustomerView(plan, sheet) {
  const safePhotos = Array.isArray(sheet?.photos)
    ? sheet.photos.slice(0, 50).map(p => typeof p === "string" ? p : (p?.url || null)).filter(Boolean)
    : [];
  return {
    contract_no: plan.contract_no,
    pol: plan.pol, pod: plan.pod,
    container_type: plan.container_type,
    vessel: plan.vessel, voyage: plan.voyage,
    etd: plan.etd, eta: plan.eta,
    forwarder: plan.forwarder_partner || plan.forwarder_cn,
    bl_no: plan.bl_no || plan.hbl_no || plan.mbl_no,
    stages: {
      booking: { vessel: plan.vessel, voyage: plan.voyage, etd: plan.etd, eta: plan.eta, forwarder: plan.forwarder_partner || plan.forwarder_cn },
      so:      { so_no: plan.so_no, container_no: plan.container_no, seal_no: plan.seal_no },
      loading: safePhotos.length ? { photos: safePhotos, container_no: plan.container_no, seal_no: plan.seal_no } : null,
      trucking: null,
      customs:  { bl_no: plan.bl_no || plan.hbl_no || plan.mbl_no, status: plan.customs_cn || null },
    },
  };
}

// ── Validate quote input ──
function validateQuoteInput(body) {
  const errors = [];
  const { item_id, vessel, voyage, etd, usd_rate, transit_days, notes } = body || {};
  if (!item_id || !UUID_RE.test(item_id)) errors.push("item_id required (uuid)");
  if (usd_rate != null) {
    const n = Number(usd_rate);
    if (!isFinite(n) || n < 0 || n > 100000) errors.push("usd_rate invalid (0–100000)");
  }
  if (transit_days != null) {
    const n = Number(transit_days);
    if (!isFinite(n) || n < 0 || n > 365) errors.push("transit_days invalid (0–365)");
  }
  if (vessel && (typeof vessel !== "string" || vessel.length > MAX_TEXT_LEN)) errors.push("vessel too long");
  if (voyage && (typeof voyage !== "string" || voyage.length > MAX_TEXT_LEN)) errors.push("voyage too long");
  if (etd && (typeof etd !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(etd))) errors.push("etd invalid format (YYYY-MM-DD)");
  if (notes && (typeof notes !== "string" || notes.length > MAX_NOTES_LEN)) errors.push("notes too long");
  return errors;
}

// ── Main handler with top-level try/catch ──
export default async function handler(req, res) {
  try {
    setCors(req, res, "GET, POST, OPTIONS");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.method === "OPTIONS") return res.end();

    const pool = getPool();
    const url = req.url || "";
    const m = url.match(/^\/api\/p\/([0-9a-f-]{36})(\/(\S*?))?(\?.*)?$/i);
    if (!m) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }
    const token = m[1];
    const subpath = m[3] || "";

    const party = await authToken(pool, token, req);
    if (!party) return unauthorized(res);

    // ── GET dashboard ──
    if (req.method === "GET" && subpath === "") {
      if (party.role && party.card_id) {
        const card = await loadCard(pool, party.card_id);
        if (!card) { res.writeHead(404); return res.end(JSON.stringify({ error: "card_not_found" })); }
        const { randomUUID } = await import("crypto");
        const tid = "collab-card-" + card.id;
        await pool.query(
          "INSERT INTO collaboration_threads(id,task_id,owner_object_type,owner_object_id,owner_object_label,status,created_by) VALUES($1,$1,'collab_card',$2,$3,'open','system') ON CONFLICT(id) DO NOTHING",
          [tid, String(card.id), card.contract_no || ("Card #" + card.id)]
        ).catch(()=>{});
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          success: true, role: party.role,
          card: projectCard(card, party.role),
          thread_id: tid,
          party: { name_cn: party.name_cn, name_en: party.name_en, contact_name: party.contact_name },
        }));
      }
      let cards = [];
      if (party.party_type === "forwarder") cards = await forwarderCards(pool, party.company_id);
      else if (party.party_type === "factory") cards = await factoryCards(pool, party.code);
      else if (party.party_type === "customer") cards = await customerCards(pool, party.code);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        success: true,
        party: {
          type: party.party_type,
          company_name: party.name_cn || party.name_en,
          company_code: party.code,
          contact_name: party.contact_name,
        },
        cards,
      }));
    }

    // ── GET shipment detail ──
    const shipMatch = subpath.match(/^shipments\/(\d+)$/);
    if (req.method === "GET" && shipMatch) {
      const planId = parseInt(shipMatch[1], 10);
      if (!planId || planId > 2147483647) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "invalid plan id" }));
      }
      const { rows: planRows } = await pool.query("SELECT * FROM shipping_plans WHERE id = $1", [planId]);
      if (!planRows.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }
      const plan = planRows[0];

      // Authorization — must scope by party identity (not just contract)
      let authorized = false;
      let sheet = null;

      if (party.party_type === "forwarder") {
        // Forwarder authorized only if they are AWARDED on an RFQ tied to this plan,
        // OR if they have a pending RFQ item under the same contract (so they can see
        // booking status before award). Tied to forwarder_company_id, not contract alone.
        const { rows } = await pool.query(`
          SELECT 1
          FROM freight_rfq_items i
          JOIN freight_rfqs r ON r.id = i.rfq_id
          JOIN orders o ON o.id = r.order_id
          WHERE i.forwarder_company_id = $1
            AND o.contract_no = $2
            AND (r.awarded_item_id IS NULL OR r.awarded_item_id = i.id)
          LIMIT 1
        `, [party.company_id, plan.contract_no]);
        authorized = rows.length > 0;
      } else if (party.party_type === "factory") {
        // Factory must own a collab sheet on this plan AND with their factory_code.
        const { rows } = await pool.query(`
          SELECT * FROM loading_collab_sheets
          WHERE shipping_plan_id = $1 AND factory_code = $2
          LIMIT 1
        `, [planId, party.code]);
        if (rows.length) { authorized = true; sheet = rows[0]; }
      } else if (party.party_type === "customer") {
        const { rows } = await pool.query(`
          SELECT 1 FROM orders WHERE contract_no = $1 AND customer_code = $2 LIMIT 1
        `, [plan.contract_no, party.code]);
        authorized = rows.length > 0;
      }

      if (!authorized) { res.writeHead(403); return res.end(JSON.stringify({ error: "forbidden" })); }

      let projected;
      if (party.party_type === "forwarder") projected = projectForwarderView(plan, sheet);
      else if (party.party_type === "factory") projected = projectFactoryView(plan, sheet);
      else projected = projectCustomerView(plan, sheet);

      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, party_type: party.party_type, plan_id: planId, data: projected }));
    }

    // ── POST quote (forwarder only) ──
    if (req.method === "POST" && subpath === "quote") {
      if (party.party_type !== "forwarder") {
        res.writeHead(403); return res.end(JSON.stringify({ error: "forwarder only" }));
      }
      const body = await readJsonBody(req);
      const errors = validateQuoteInput(body);
      if (errors.length) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "validation_failed", details: errors }));
      }
      const { item_id, vessel, voyage, etd, usd_rate, transit_days, notes } = body;

      // Confirm item belongs to this forwarder (FK check)
      const { rows: check } = await pool.query(
        "SELECT id, forwarder_company_id, rfq_id FROM freight_rfq_items WHERE id = $1",
        [item_id]
      );
      if (!check.length || check[0].forwarder_company_id !== party.company_id) {
        res.writeHead(403); return res.end(JSON.stringify({ error: "forbidden" }));
      }
      // Don't accept quotes for awarded RFQs (locked)
      const { rows: rfqRows } = await pool.query(
        "SELECT awarded_item_id FROM freight_rfqs WHERE id = $1", [check[0].rfq_id]
      );
      if (rfqRows[0]?.awarded_item_id && rfqRows[0].awarded_item_id !== item_id) {
        res.writeHead(409); return res.end(JSON.stringify({ error: "rfq_already_awarded" }));
      }

      await pool.query(`
        UPDATE freight_rfq_items
        SET vessel=$1, voyage=$2, etd=$3, usd_rate=$4, transit_days=$5, notes=$6,
            submitted_at = COALESCE(submitted_at, NOW())
        WHERE id = $7
      `, [vessel || null, voyage || null, etd || null,
          usd_rate != null ? Number(usd_rate) : null,
          transit_days != null ? Number(transit_days) : null,
          notes || null, item_id]);

      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true }));
    }

    // ── GET sheet detail (factory only) ──
    const sheetGetMatch = subpath.match(/^sheets\/(\d+)$/);
    if (req.method === "GET" && sheetGetMatch) {
      if (party.party_type !== "factory") {
        res.writeHead(403); return res.end(JSON.stringify({ error: "factory only" }));
      }
      const sheetId = parseInt(sheetGetMatch[1], 10);
      if (!sheetId || sheetId > 2147483647) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "invalid sheet id" }));
      }
      const { rows: sr } = await pool.query(`
        SELECT lcs.*, sp.vessel, sp.voyage, sp.etd, sp.pol, sp.pod,
               sp.container_type, sp.so_no
        FROM loading_collab_sheets lcs
        LEFT JOIN shipping_plans sp ON sp.id = lcs.shipping_plan_id
        WHERE lcs.id = $1 AND lcs.factory_code = $2
      `, [sheetId, party.code]);
      if (!sr.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }
      const s = sr[0];
      const safePhotos = Array.isArray(s.photos)
        ? s.photos.slice(0, 100).map(p => typeof p === "string" ? p : (p?.url || null)).filter(Boolean)
        : [];
      const safeProducts = Array.isArray(s.products)
        ? s.products.slice(0, 100).map(p => ({ name: p?.name||null, sku: p?.sku||null, qty: p?.qty||null, unit: p?.unit||null }))
        : [];
      // Compute field lock states
      const now = Date.now();
      const subMs = s.submitted_at ? new Date(s.submitted_at).getTime() : null;
      const elapsedMin = subMs ? (now - subMs) / 60000 : null;
      const isSubmitted = !!s.submitted_at;
      const fieldLocks = {
        container_no: isSubmitted && (elapsedMin === null || elapsedMin > 10),
        seal_no:      isSubmitted && (elapsedMin === null || elapsedMin > 10),
        gross_weight_kg: isSubmitted && (elapsedMin === null || elapsedMin > 30),
        total_cartons:   isSubmitted && (elapsedMin === null || elapsedMin > 30),
        total_cbm:       isSubmitted && (elapsedMin === null || elapsedMin > 30),
        loaded_at:       isSubmitted && (elapsedMin === null || elapsedMin > 30),
        photos: false, // always supplementable
      };
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        success: true,
        sheet: {
          id: s.id,
          order_no: s.order_no,
          contract_no: s.contract_no,
          status: s.status,
          due_at: s.due_at,
          submitted_at: s.submitted_at,
          trade_terms: s.trade_terms,
          factory_visible_note: s.factory_visible_note,
          products: safeProducts,
          loading: {
            container_no: s.loading?.container_no || null,
            seal_no:      s.loading?.seal_no || null,
            gross_weight_kg: s.loading?.gross_weight_kg || null,
            total_cartons:   s.loading?.total_cartons || null,
            total_cbm:       s.loading?.total_cbm || null,
            loaded_at:       s.loading?.loaded_at || null,
          },
          photos: safePhotos,
          field_locks: fieldLocks,
          plan: {
            vessel: s.vessel, voyage: s.voyage, etd: s.etd,
            pol: s.pol, pod: s.pod,
            container_type: s.container_type,
            route: s.pol && s.pod ? `${s.pol} → ${s.pod}` : null,
          },
        },
      }));
    }

    // ── PATCH sheet loading (factory only, field-level locking) ──
    const sheetPatchMatch = subpath.match(/^sheets\/(\d+)\/loading$/);
    if (req.method === "PATCH" && sheetPatchMatch) {
      if (party.party_type !== "factory") {
        res.writeHead(403); return res.end(JSON.stringify({ error: "factory only" }));
      }
      const sheetId = parseInt(sheetPatchMatch[1], 10);
      if (!sheetId || sheetId > 2147483647) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "invalid sheet id" }));
      }
      const body = req.body || await readJsonBody(req);
      const { rows: sr } = await pool.query(
        "SELECT id, loading, status, submitted_at, factory_code FROM loading_collab_sheets WHERE id = $1 AND factory_code = $2",
        [sheetId, party.code]
      );
      if (!sr.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }
      const s = sr[0];
      const now = Date.now();
      const subMs = s.submitted_at ? new Date(s.submitted_at).getTime() : null;
      const elapsedMin = subMs ? (now - subMs) / 60000 : null;
      const isSubmitted = !!s.submitted_at;

      // Build updated loading object, respecting locks
      const current = s.loading || {};
      const updated = { ...current };
      const locked = [];

      function trySet(field, val, graceMin) {
        const fieldLocked = isSubmitted && (elapsedMin === null || elapsedMin > graceMin);
        if (fieldLocked) { locked.push(field); return; }
        if (val !== undefined) updated[field] = val || null;
      }

      trySet("container_no",    body.container_no,    10);
      trySet("seal_no",         body.seal_no,         10);
      trySet("gross_weight_kg", body.gross_weight_kg, 30);
      trySet("total_cartons",   body.total_cartons,   30);
      trySet("total_cbm",       body.total_cbm,       30);
      trySet("loaded_at",       body.loaded_at,       30);

      if (locked.length) {
        res.writeHead(409); return res.end(JSON.stringify({ error: "field_locked", fields: locked }));
      }

      // If submitting (body.submit === true) and not yet submitted
      const doSubmit = body.submit === true && !isSubmitted;
      if (doSubmit) {
        await pool.query(
          "UPDATE loading_collab_sheets SET loading = $1::jsonb, status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $2",
          [JSON.stringify(updated), sheetId]
        );
      } else {
        const newStatus = s.status === "assigned" ? "in_progress" : s.status;
        await pool.query(
          "UPDATE loading_collab_sheets SET loading = $1::jsonb, status = $2, updated_at = NOW() WHERE id = $3",
          [JSON.stringify(updated), newStatus, sheetId]
        );
      }

      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, submitted: doSubmit }));
    }


    // ── POST upload photo (factory only, base64 → disk → URL) ──
    const sheetUploadMatch = subpath.match(/^sheets\/(\d+)\/upload$/);
    if (req.method === "POST" && sheetUploadMatch) {
      if (party.party_type !== "factory") {
        res.writeHead(403); return res.end(JSON.stringify({ error: "factory only" }));
      }
      const sheetId = parseInt(sheetUploadMatch[1], 10);
      if (!sheetId || sheetId > 2147483647) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "invalid sheet id" }));
      }
      const body = req.body || await readJsonBody(req);
      const { data: b64, ext: rawExt } = body || {};
      if (!b64 || typeof b64 !== "string") {
        res.writeHead(400); return res.end(JSON.stringify({ error: "data required (base64)" }));
      }
      const ext = (rawExt || "jpg").replace(/[^a-z]/g, "").slice(0,4) || "jpg";
      if (b64.length > 8 * 1024 * 1024) { // 8MB base64 ≈ 6MB file
        res.writeHead(413); return res.end(JSON.stringify({ error: "file too large" }));
      }
      // Verify factory owns this sheet
      const { rows: sr } = await pool.query(
        "SELECT id, photos FROM loading_collab_sheets WHERE id = $1 AND factory_code = $2",
        [sheetId, party.code]
      );
      if (!sr.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }

      // Decode and save
      const { randomUUID } = await import("crypto");
      const { writeFile, mkdir } = await import("fs/promises");
      const uploadDir = "/opt/sanlyn-web/uploads";
      await mkdir(uploadDir, { recursive: true });
      const filename = randomUUID() + "." + ext;
      const filepath = uploadDir + "/" + filename;
      const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
      await writeFile(filepath, buf);

      const url = "https://damon.sanlyn.cn/uploads/" + filename;

      // Append to photos
      const currentPhotos = Array.isArray(sr[0].photos) ? sr[0].photos : [];
      const newPhotos = [...currentPhotos, url].slice(0, 100);
      await pool.query(
        "UPDATE loading_collab_sheets SET photos = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(newPhotos), sheetId]
      );

      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, url, photo_count: newPhotos.length }));
    }

    // ── POST photos (factory only, always supplementable) ──
    const sheetPhotosMatch = subpath.match(/^sheets\/(\d+)\/photos$/);
    if (req.method === "POST" && sheetPhotosMatch) {
      if (party.party_type !== "factory") {
        res.writeHead(403); return res.end(JSON.stringify({ error: "factory only" }));
      }
      const sheetId = parseInt(sheetPhotosMatch[1], 10);
      if (!sheetId || sheetId > 2147483647) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "invalid sheet id" }));
      }
      const body = req.body || await readJsonBody(req);
      const urls = Array.isArray(body.urls) ? body.urls.filter(u => typeof u === "string" && u.length < 500) : [];
      if (!urls.length) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "urls required" }));
      }
      if (urls.length > 20) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "max 20 photos per request" }));
      }
      const { rows: sr } = await pool.query(
        "SELECT id, photos FROM loading_collab_sheets WHERE id = $1 AND factory_code = $2",
        [sheetId, party.code]
      );
      if (!sr.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" })); }
      const currentPhotos = Array.isArray(sr[0].photos) ? sr[0].photos : [];
      const newPhotos = [...currentPhotos, ...urls].slice(0, 100);
      await pool.query(
        "UPDATE loading_collab_sheets SET photos = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(newPhotos), sheetId]
      );
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, photo_count: newPhotos.length }));
    }

    // Collab routes
    if (party.role && party.card_id) {
      const handled = await handleCollab(pool, party, subpath, req, res);
      if (handled !== null) return;
    }

    res.writeHead(405);
    return res.end(JSON.stringify({ error: "method not allowed" }));
  } catch (err) {
    console.error("[partner-portal]", err);
    if (res.headersSent) return;
    if (err.code === "PAYLOAD_TOO_LARGE") {
      res.writeHead(413); return res.end(JSON.stringify({ error: "payload_too_large" }));
    }
    if (err.code === "INVALID_JSON") {
      res.writeHead(400); return res.end(JSON.stringify({ error: "invalid_json" }));
    }
    res.writeHead(500); return res.end(JSON.stringify({ error: "internal_error" }));
  }
}
