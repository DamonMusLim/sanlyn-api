// ═══════════════════════════════════════════════════════════════
// customer-magic-link.js
//
// POST /api/db/customer-magic-link/generate
//   body: { sheet_id?, sheet_table?, recipient_role, recipient_phone?,
//           recipient_email?, ttl_hours?, contract_no?, shipment_id? }
//   Auth: requireAuth (admin only — issues links on behalf of customers)
//   → { token (raw, one-time), url, expires_at }
//
// GET /api/db/customer-magic-link/validate?token=RAW
//   No auth — public token validation
//   → { valid, role, sheet_data?, tracking?, expires_at }
//
// POST /api/db/customer-magic-link/use
//   body: { token }
//   No auth — marks token as used, logs IP/UA
//   → { ok }
//
// Table: magic_links (see migrate-magic-links.js for DDL)
// Security: raw token → SHA-256 hash stored; raw returned once only
// ═══════════════════════════════════════════════════════════════
import crypto                    from "crypto";
import { getPool, setCors }       from "../db.js";
import { requireAuth }            from "../auth.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

const APP_BASE   = process.env.MAGIC_LINK_BASE_URL || "https://app.sanlyn.cn";
const MAX_TTL    = 720; // 30 days hard cap
const DEFAULT_TTL = 72; // 3 days default

const ALLOWED_ROLES = new Set(["driver", "forwarder", "customs", "customer_downstream"]);

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function genRaw(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── Route dispatch via path suffix ──────────────────────────
  // req.path = full path e.g. /api/db/customer-magic-link/generate
  // Extract the last segment as the action name.
  const _fullPath = (req.path || req.url || "").replace(/\?.*/, "");
  const pathSuffix = _fullPath.split("/").filter(Boolean).pop() || "";

  // ── POST generate ────────────────────────────────────────────
  if (req.method === "POST" && pathSuffix === "generate") {
    // Admin auth required to issue links
    const role = roleFromAuth ? roleFromAuth(req) : null;
    if (!requireAuth(req, res)) return;

    const b = req.body || {};
    const recipientRole = b.recipient_role;
    if (!recipientRole || !ALLOWED_ROLES.has(recipientRole)) {
      return res.status(400).json({ error: "recipient_role must be one of: " + [...ALLOWED_ROLES].join(", ") });
    }

    const ttl = Math.min(parseInt(b.ttl_hours) || DEFAULT_TTL, MAX_TTL);
    const raw  = genRaw();
    const hash = rawToHash(raw);

    const meta = {
      sheet_id:        b.sheet_id        || null,
      sheet_table:     b.sheet_table     || null,
      contract_no:     b.contract_no     || null,
      shipment_id:     b.shipment_id     || null,
      recipient_phone: b.recipient_phone || null,
      recipient_email: b.recipient_email || null,
    };

    await pool.query(
      `INSERT INTO magic_links
         (token_hash, recipient_role, meta, expires_at, access_log, created_at)
       VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval, '[]'::jsonb, NOW())`,
      [hash, recipientRole, JSON.stringify(meta), String(ttl)]
    );

    // Role-based URL routing
    const rolePathPrefix = {
      forwarder:           "forwarder",
      customs:             "customs-broker",
      driver:              "driver",
      customer_downstream: "",   // /m/{token}
    };
    const prefix = rolePathPrefix[recipientRole];
    const url = prefix
      ? `${APP_BASE}/m/${prefix}/${raw}`
      : `${APP_BASE}/m/${raw}`;
    return res.status(200).json({
      token:      raw,
      url,
      expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString(),
      role:       recipientRole,
    });
  }

  // ── GET validate ─────────────────────────────────────────────
  if (req.method === "GET" && pathSuffix === "validate") {
    const raw = req.query?.token;
    if (!raw || raw.length < 16) {
      return res.status(400).json({ error: "token required" });
    }

    const hash = rawToHash(raw);
    const { rows } = await pool.query(
      `SELECT id, recipient_role, meta, expires_at, used_at, revoked_at, access_log
         FROM magic_links
        WHERE token_hash = $1
          AND expires_at > NOW()
          AND revoked_at IS NULL
        LIMIT 1`,
      [hash]
    );

    if (!rows.length) {
      return res.status(200).json({ valid: false, reason: "invalid_or_expired" });
    }

    const link = rows[0];
    const meta = (typeof link.meta === "string" ? JSON.parse(link.meta) : link.meta) || {};

    // For forwarder role: fetch booking sheet data (safe fields — no factory, no prices)
    let forwarderSheetData = null;
    if (link.recipient_role === "forwarder" && (meta.contract_no || meta.shipment_id)) {
      try {
        const key = meta.contract_no || meta.shipment_id;
        const fs = await pool.query(
          `SELECT id, _id, contract_no, bl_no, pol, pod, etd, eta, cutoff_date,
                  container_type, shipper,
                  raw->>'consignee' AS consignee,
                  cargo_description, product_notes,
                  gross_weight_kg, total_cartons, total_cbm, release_type,
                  forwarder_cn, flow_status, forwarder_booking_no, vessel, voyage
             FROM shipping_plans
            WHERE (contract_no = $1 OR _id = $1 OR id::text = $1
                   OR order_contract_nos ILIKE $2)
            ORDER BY created_at DESC LIMIT 1`,
          [key, `%${key}%`]
        );
        if (fs.rows.length) {
          const sp = fs.rows[0];
          forwarderSheetData = {
            id:                  sp.id,
            _id:                 sp._id,
            contract_no:         sp.contract_no,
            bl_no:               sp.bl_no,
            pol:                 sp.pol,
            pod:                 sp.pod,
            etd:                 sp.etd,
            eta:                 sp.eta,
            cutoff_date:         sp.cutoff_date,
            container_type:      sp.container_type,
            shipper:             sp.shipper,
            consignee:           sp.consignee,
            cargo_description:   sp.cargo_description,
            product_notes:       sp.product_notes,
            gross_weight_kg:     sp.gross_weight_kg,
            total_cartons:       sp.total_cartons,
            total_cbm:           sp.total_cbm,
            release_type:        sp.release_type,
            forwarder_cn:        sp.forwarder_cn,
            flow_status:         sp.flow_status,
            // Already-submitted booking data (for pre-filling if re-opened)
            forwarder_booking_no: sp.forwarder_booking_no,
            vessel:              sp.vessel,
            voyage:              sp.voyage,
            // Explicitly NOT included: factory, customs_cn, trucking_cn, any price fields
          };
        }
      } catch (e) {
        console.warn("[customer-magic-link] forwarder sheet fetch failed:", e.message);
      }
    }

    // For customer_downstream: fetch tracking data
    let trackingData = null;
    if (link.recipient_role === "customer_downstream" && (meta.contract_no || meta.shipment_id)) {
      try {
        const port = process.env.PORT || process.env.API_PORT || 9000;
        const qs   = meta.contract_no
          ? `contract_no=${encodeURIComponent(meta.contract_no)}`
          : `shipment_id=${encodeURIComponent(meta.shipment_id)}`;
        // Use internal service token (no auth header forwarding for magic links)
        const authHeader = "x-internal-magic-link";
        // Fetch internally — we pass a fake internal token; tracking endpoint
        // needs requireAuth bypass. Use direct DB query instead.
        const tRes = await pool.query(
          `SELECT _id, bl_no, vessel, voyage, pol, pod, etd, eta, atd, ata,
                  flow_status, current_status, current_status_cn, contract_no
             FROM shipping_plans
            WHERE (contract_no = $1 OR order_contract_nos ILIKE $2 OR _id = $1)
            ORDER BY created_at DESC LIMIT 1`,
          [meta.contract_no || meta.shipment_id, `%${meta.contract_no || ""}%`]
        );
        if (tRes.rows.length) {
          const sp = tRes.rows[0];
          // Build minimal safe tracking payload (no prices, no internal data)
          trackingData = {
            bl_no:          sp.bl_no,
            vessel:         sp.vessel,
            voyage:         sp.voyage,
            pol:            sp.pol,
            pod:            sp.pod,
            etd:            sp.etd,
            eta:            sp.eta,
            atd:            sp.atd,
            ata:            sp.ata,
            current_status: sp.current_status,
            current_status_cn: sp.current_status_cn,
            flow_status:    sp.flow_status,
          };
        }
      } catch (e) {
        console.warn("[customer-magic-link] tracking fetch failed:", e.message);
      }
    }

    return res.status(200).json({
      valid:      true,
      id:         link.id,
      role:       link.recipient_role,
      expires_at: link.expires_at,
      used:       !!link.used_at,
      meta: {
        contract_no: meta.contract_no,
        shipment_id: meta.shipment_id,
        // Never expose phone/email in validate response
      },
      tracking:      trackingData,
      booking_sheet: forwarderSheetData,
    });
  }

  // ── POST use ─────────────────────────────────────────────────
  if (req.method === "POST" && pathSuffix === "use") {
    const b   = req.body || {};
    const raw = b.token;
    if (!raw || raw.length < 16) {
      return res.status(400).json({ error: "token required" });
    }

    const hash = rawToHash(raw);
    const ip   = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const ua   = req.headers["user-agent"] || "";
    const entry = JSON.stringify({ accessed_at: new Date().toISOString(), ip, ua });

    const { rowCount } = await pool.query(
      `UPDATE magic_links
          SET used_at    = COALESCE(used_at, NOW()),
              access_log = COALESCE(access_log, '[]'::jsonb) || $1::jsonb
        WHERE token_hash = $2
          AND expires_at > NOW()
          AND revoked_at IS NULL`,
      [`[${entry}]`, hash]
    );

    if (!rowCount) {
      return res.status(401).json({ error: "invalid_or_expired" });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: "Not found. Use /generate, /validate, or /use" });
}
