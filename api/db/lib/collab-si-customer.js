import { rawToHash } from "./collab-shared.js";

const TOKEN_ROLES = ["customer_booking", "shipper_booking"];
const EDITABLE_FIELDS = ["consignee", "notify", "marks", "description", "hs", "vessel_voyage", "pol", "pod"];
const REVIEW_FIELDS = new Set(["vessel_voyage", "pol", "pod"]);

function text(value) {
  return value == null ? "" : String(value);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 3) {
  const m = 10 ** digits;
  return Math.round(num(value) * m) / m;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value) || {}; } catch (e) { return {}; }
  }
  return typeof value === "object" ? value : {};
}

async function resolveToken(req, res, pool) {
  const token = text(req.query?.token || req.body?.token).trim();
  if (!token || token.length < 10) {
    res.status(400).json({ ok: false, error: "token required" });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT recipient_role, meta
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = ANY($2::text[])
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [rawToHash(token), TOKEN_ROLES]
  );
  if (!rows.length) {
    res.status(401).json({ ok: false, error: "invalid token" });
    return null;
  }
  const meta = parseJson(rows[0].meta);
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) {
    res.status(400).json({ ok: false, error: "token missing shipment_id" });
    return null;
  }
  return { role: rows[0].recipient_role, planId };
}

function latestDraft(raw) {
  const drafts = Array.isArray(raw?.si_customer_drafts) ? raw.si_customer_drafts : [];
  if (!drafts.length) return null;
  const src = drafts[drafts.length - 1] || {};
  const cleaned = cleanDraftBody({ fields: src.fields || {}, note: src.note || "" });
  const out = { ts: text(src.ts), fields: cleaned.fields, note: cleaned.note };
  if (src.edited && typeof src.edited === "object") {
    out.edited = {};
    for (const key of EDITABLE_FIELDS) {
      if (REVIEW_FIELDS.has(key) && src.edited[key] === true) out.edited[key] = true;
    }
  }
  return out;
}

function cleanDraftBody(body) {
  const src = body && typeof body.fields === "object" ? body.fields : (body || {});
  const fields = {};
  const edited = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in src)) continue;
    const value = src[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      fields[key] = text(value.value).slice(0, 4000);
      if (REVIEW_FIELDS.has(key) && value.edited === true) edited[key] = true;
    } else {
      fields[key] = text(value).slice(0, 4000);
    }
  }
  return {
    fields,
    edited,
    note: text(body?.note).slice(0, 1000),
  };
}

const SI_SQL = `
  SELECT
    sp.bl_no,
    sp.vessel,
    sp.voyage,
    sp.pol AS plan_pol,
    sp.pod AS plan_pod,
    sp.raw AS plan_raw,
    sp.issuing_company,
    ic.name_en AS issuing_company_en,
    sp.customer AS plan_customer,
    sp.customer_en,
    cb.id AS cb_id,
    cb.container_no,
    cb.seal_no,
    cb.container_type,
    cb.declaration_cargo_name AS cb_goods_desc,
    COALESCE(cb.cargo_weight_kg, 0)::numeric AS cb_cargo_weight_kg,
    COALESCE(cb.tare_weight_kg, cb.tare_kg, 0)::numeric AS tare_kg,
    o.id AS order_id,
    o.customer,
    o.customer_address,
    o.country,
    o.pol AS order_pol,
    o.raw AS order_raw,
    COALESCE(o.total_cbm, 0)::numeric AS order_cbm,
    li.id AS li_id,
    li.hs_code AS li_hs_code,
    li.product_name AS li_product_name,
    li.declaration_name AS li_declaration_name,
    li.declaration_name_en AS li_declaration_name_en,
    COALESCE(li.qty_ctn, 0)::numeric AS qty_ctn,
    COALESCE(li.gw_ctn, 0)::numeric AS li_gw_ctn,
    COALESCE(li.cbm_ctn, 0)::numeric AS li_cbm_ctn,
    p.hs_code AS product_hs_code,
    p.declaration_name AS product_declaration_name,
    p.declaration_name_en AS product_declaration_name_en,
    p.bl_description,
    COALESCE(p.gross_weight, 0)::numeric AS product_gw_ctn,
    COALESCE(p.cbm, 0)::numeric AS product_cbm
  FROM shipping_plans sp
  LEFT JOIN companies ic ON ic.name_cn = sp.issuing_company
  LEFT JOIN container_bookings cb ON cb.shipping_plan_id = sp.id
  LEFT JOIN LATERAL (
    WITH candidates AS (
      SELECT o0.*,
        CASE
          WHEN cb.id IS NOT NULL AND o0.order_no = cb.contract_no THEN 1
          WHEN cb.id IS NOT NULL AND o0.contract_no = cb.contract_no THEN 2
          ELSE 3
        END AS match_rank,
        COUNT(*) FILTER (WHERE cb.id IS NOT NULL AND o0.contract_no = cb.contract_no) OVER () AS same_contract_count
      FROM orders o0
      WHERE COALESCE(o0.status, '') <> 'cancelled'
        AND (o0.shipping_plan_id = sp.id
          OR o0.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
          OR o0.contract_no = ANY(COALESCE(sp.contract_nos, ARRAY[]::text[])))
        AND (cb.id IS NULL OR o0.order_no = cb.contract_no OR o0.contract_no = cb.contract_no)
    )
    SELECT * FROM candidates
    WHERE match_rank IN (1,3) OR (match_rank = 2 AND same_contract_count = 1)
    ORDER BY match_rank, id
    LIMIT 1
  ) o ON true
  LEFT JOIN order_line_items li ON li.order_id = o.id
  LEFT JOIN products p ON p.id = li.product_id
  WHERE sp.id = $1
  ORDER BY cb.id NULLS LAST, o.id, li.id
`;

function shapeSi(rows) {
  const first = rows[0];
  const raw = parseJson(first.plan_raw);
  const containersById = new Map();
  const productNames = new Set();
  const hsCodes = new Set();
  let fallbackPieces = 0;
  let fallbackGross = 0;
  let fallbackCbm = 0;

  for (const row of rows) {
    const cbKey = row.cb_id || "pending";
    if (!containersById.has(cbKey)) {
      containersById.set(cbKey, {
        container_no: text(row.container_no),
        seal_no: text(row.seal_no),
        container_type: text(row.container_type),
        pieces: 0,
        gross_weight: 0,
        cbm: 0,
        tare: num(row.tare_kg),
        _fallbackGross: num(row.cb_cargo_weight_kg),
        _goods: new Set(),
      });
    }
    if (!row.li_id) continue;
    const qty = num(row.qty_ctn);
    const gw = qty * (num(row.li_gw_ctn) || num(row.product_gw_ctn));
    const cbm = qty * (num(row.li_cbm_ctn) || num(row.product_cbm));
    const name = text(row.li_declaration_name_en || row.product_declaration_name_en) || "⚠ EN NAME MISSING";
    const hs = text(row.li_hs_code || row.product_hs_code);
    const container = containersById.get(cbKey);
    container.pieces += qty;
    container.gross_weight += gw;
    container.cbm += cbm;
    if (name) {
      productNames.add(name);
      container._goods.add(name);
    }
    if (hs) hsCodes.add(hs);
    fallbackPieces += qty;
    fallbackGross += gw;
    fallbackCbm += cbm;
  }

  const containers = Array.from(containersById.values()).map((c) => {
    const gross = c.gross_weight > 0 ? c.gross_weight : c._fallbackGross;
    return {
      container_no: c.container_no,
      seal_no: c.seal_no,
      container_type: c.container_type,
      pieces: round(c.pieces, 0),
      gross_weight: round(gross, 3),
      cbm: round(c.cbm, 3),
      vgm: round(gross + c.tare, 3),
      tare: round(c.tare, 3),
    };
  });

  const totals = containers.reduce((acc, c) => ({
    pieces: acc.pieces + num(c.pieces),
    gross_weight: acc.gross_weight + num(c.gross_weight),
    cbm: acc.cbm + num(c.cbm),
    vgm: acc.vgm + num(c.vgm),
  }), { pieces: 0, gross_weight: 0, cbm: 0, vgm: 0 });

  if (!containers.length) {
    totals.pieces = fallbackPieces;
    totals.gross_weight = fallbackGross;
    totals.cbm = fallbackCbm || num(first.order_cbm);
  }

  const vesselVoyage = [first.vessel, first.voyage].filter(Boolean).join(" ");
  const customerBlock = [first.customer || first.customer_en || first.plan_customer, first.customer_address].filter(Boolean).join("\n");
  return {
    ok: true,
    plan: {
      bl_no: text(first.bl_no),
    },
    fields: {
      shipper: text(first.issuing_company_en || first.issuing_company),
      consignee: customerBlock,
      notify: customerBlock,
      vessel_voyage: vesselVoyage,
      pol: text(first.plan_pol || first.order_pol),
      pod: text(first.plan_pod || first.country),
      marks: text(parseJson(first.order_raw).shipping_marks || parseJson(first.order_raw).marks || "NO SHIPPING MARK"),
      description: Array.from(productNames).join(" / "),
      hs: Array.from(hsCodes).join(" / "),
    },
    containers,
    totals: {
      pieces: round(totals.pieces, 0),
      gross_weight: round(totals.gross_weight, 3),
      cbm: round(totals.cbm, 3),
      vgm: round(totals.vgm, 3),
    },
    draft: latestDraft(raw),
  };
}

export async function handleSiData(req, res, pool) {
  const scope = await resolveToken(req, res, pool);
  if (!scope) return;
  const { rows } = await pool.query(SI_SQL, [scope.planId]);
  if (!rows.length) return res.status(404).json({ ok: false, error: "shipping plan not found" });
  return res.json(shapeSi(rows));
}

export async function handleSiDraft(req, res, pool) {
  const scope = await resolveToken(req, res, pool);
  if (!scope) return;
  const cleaned = cleanDraftBody(req.body || {});
  const savedAt = new Date().toISOString();
  const entry = { ts: savedAt, fields: cleaned.fields, note: cleaned.note };
  if (Object.keys(cleaned.edited).length) entry.edited = cleaned.edited;
  await pool.query(
    `UPDATE shipping_plans
        SET raw = jsonb_set(
          COALESCE(raw, '{}'::jsonb),
          '{si_customer_drafts}',
          COALESCE(raw->'si_customer_drafts', '[]'::jsonb) || $2::jsonb,
          true
        )
      WHERE id = $1`,
    [scope.planId, JSON.stringify([entry])]
  );
  return res.json({ ok: true, saved_at: savedAt });
}
