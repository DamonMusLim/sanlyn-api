// ═══════════════════════════════════════════════════════════════
// forwarder-booking-submit.js
// POST /api/db/forwarder-booking-submit
//   No JWT — authenticated via magic link token.
//
// Body (JSON):
//   { token, forwarder_booking_no, vessel, voyage, bl_draft? }
//   bl_draft: { filename, size, data_b64 }  (optional BL draft upload)
//
// Actions:
//   1. Validate token → magic_links row (role must be "forwarder")
//   2. Look up shipping_plan via meta.contract_no or meta.shipment_id
//   3. PATCH shipping_plans:
//        forwarder_booking_no, vessel, voyage,
//        flow_status = "booked", booking_sent_at = NOW()
//      + vault merge: { forwarder_draft_bl: {...} } if bl_draft provided
//   4. Append access_log entry + mark used_at = COALESCE(used_at, NOW())
//   5. Send WeCom admin notification
//
// Returns: { ok, shipment_id, flow_status }
// ═══════════════════════════════════════════════════════════════
import crypto                    from "crypto";
import { getPool, setCors }       from "../db.js";

const WECOM_URL = process.env.WECOM_WEBHOOK_URL;

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function sendWecom(markdown) {
  if (!WECOM_URL) return { skipped: true };
  try {
    const r = await fetch(WECOM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
    });
    const d = await r.json();
    return d.errcode === 0 ? { ok: true } : { ok: false, ...d };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end("POST only");

  const b = req.body || {};
  const raw = b.token;
  if (!raw || raw.length < 16) {
    return res.status(400).json({ error: "token required" });
  }
  if (!b.forwarder_booking_no && !b.vessel) {
    return res.status(400).json({ error: "forwarder_booking_no or vessel required" });
  }

  const pool = getPool();
  const hash = rawToHash(raw);

  // ── 1. Validate magic link ──────────────────────────────────
  const { rows: linkRows } = await pool.query(
    `SELECT id, recipient_role, meta, expires_at, used_at
       FROM magic_links
      WHERE token_hash = $1
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );

  if (!linkRows.length) {
    return res.status(401).json({ error: "invalid_or_expired_link" });
  }
  const link = linkRows[0];
  if (link.recipient_role !== "forwarder") {
    return res.status(403).json({ error: "not_a_forwarder_link" });
  }
  const meta = (typeof link.meta === "string" ? JSON.parse(link.meta) : link.meta) || {};

  // ── 2. Lookup shipping plan ─────────────────────────────────
  let sp = null;
  if (meta.contract_no || meta.shipment_id) {
    const key = meta.contract_no || meta.shipment_id;
    const r = await pool.query(
      `SELECT id, _id, contract_no, vessel, voyage, bl_no, pol, pod, flow_status,
              shipper, raw->>'consignee' AS consignee, forwarder_cn
         FROM shipping_plans
        WHERE (contract_no = $1 OR _id = $1 OR id::text = $1
               OR order_contract_nos ILIKE $2)
        ORDER BY created_at DESC LIMIT 1`,
      [key, `%${key}%`]
    );
    sp = r.rows[0] || null;
  }

  if (!sp) {
    return res.status(404).json({ error: "shipping_plan_not_found" });
  }

  // ── 3. Build PATCH ──────────────────────────────────────────
  const sets  = [];
  const vals  = [];

  function add(col, val) {
    if (val !== undefined && val !== null && val !== "") {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    }
  }

  add("forwarder_booking_no", b.forwarder_booking_no?.trim() || null);
  add("vessel",   b.vessel?.trim()  || null);
  add("voyage",   b.voyage?.trim()  || null);
  add("flow_status",   "booked");

  const bookingSentAt = new Date().toISOString();
  add("booking_sent_at", bookingSentAt);
  let vaultMerge = { booking_sent_at: bookingSentAt };
  if (b.bl_draft && b.bl_draft.filename) {
    const bl = {
      filename:    b.bl_draft.filename,
      size:        b.bl_draft.size || 0,
      uploaded_at: bookingSentAt,
      // data_b64 only stored if small (< 4MB after base64 padding)
      data_b64: (b.bl_draft.data_b64 && b.bl_draft.data_b64.length < 5_500_000)
        ? b.bl_draft.data_b64
        : null,
    };
    vaultMerge.forwarder_draft_bl = bl;
  }

  if (!sets.length && !vaultMerge) {
    return res.status(400).json({ error: "nothing to update" });
  }

  if (vaultMerge) {
    sets.push(`vault = COALESCE(vault, '{}'::jsonb) || $${vals.length + 1}::jsonb`);
    vals.push(JSON.stringify(vaultMerge));
  }

  vals.push(sp.id);
  const sql = `UPDATE shipping_plans SET ${sets.join(", ")}, updated_at = NOW()
                WHERE id = $${vals.length} RETURNING id, _id, contract_no,
                  forwarder_booking_no, vessel, voyage, flow_status, booking_sent_at`;

  let saved;
  try {
    const r = await pool.query(sql, vals);
    saved = r.rows[0];
  } catch (err) {
    console.error("[forwarder-booking-submit] patch error:", err);
    return res.status(500).json({ error: "db_update_failed: " + err.message });
  }

  // ── 4. Mark link accessed + log IP ─────────────────────────
  const ip    = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const ua    = req.headers["user-agent"] || "";
  const entry = JSON.stringify({ accessed_at: new Date().toISOString(), ip, ua, action: "booking_submitted" });
  try {
    await pool.query(
      `UPDATE magic_links
          SET used_at    = COALESCE(used_at, NOW()),
              access_log = COALESCE(access_log, '[]'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [`[${entry}]`, link.id]
    );
  } catch (_) { /* non-fatal */ }

  // ── 5. WeCom admin notification ─────────────────────────────
  const ref = saved.contract_no || saved._id || String(saved.id);
  const bkn = saved.forwarder_booking_no || "—";
  const ves = [saved.vessel, saved.voyage].filter(Boolean).join(" / ") || "—";
  const fw  = sp.forwarder_cn || meta.recipient_phone || "货代";
  const blNote = b.bl_draft?.filename ? `\n> **草单**: ${b.bl_draft.filename}` : "";

  const md = `## 📦 货代已提交订舱确认

> **合同号**: ${ref}
> **订舱号**: ${bkn}
> **船名航次**: ${ves}
> **货代**: ${fw}
> **时间**: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}${blNote}

[在 Sanlyn OS 查看](https://api.sanlyn.cn)`;

  let notified;
  try {
    notified = await sendWecom(md);
  } catch (e) {
    notified = { ok: false, error: e.message };
  }

  return res.status(200).json({
    ok:          true,
    shipment_id: saved._id || saved.id,
    contract_no: saved.contract_no,
    forwarder_booking_no: saved.forwarder_booking_no,
    vessel:      saved.vessel,
    voyage:      saved.voyage,
    flow_status: saved.flow_status,
    notified,
  });
}
