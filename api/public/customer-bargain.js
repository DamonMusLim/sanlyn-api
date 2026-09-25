import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { verifyToken } from "../auth.js";
import { writeRfqNotification } from "../db/lib/rfq-pricing.js";
import { resolvePort } from "../db/port-resolver.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function cleanText(v, max = 120) {
  return String(v || "").trim().slice(0, max);
}

function parseUsd(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function parseDeliveryDeadline(v) {
  if (v === "" || v == null) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return NaN;
  const today = new Date().toISOString().slice(0, 10);
  return s >= today ? s : NaN;
}

function parseContainerQty(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

function authHeaderToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

async function resolveCustomer(pool, req, code) {
  const rawCode = cleanText(code, 80);
  if (rawCode && rawCode !== "public") {
    const { rows } = await pool.query(
      `SELECT meta FROM magic_links
        WHERE token_hash=$1 AND recipient_role='customer_quote'
          AND expires_at > NOW() AND revoked_at IS NULL
        LIMIT 1`,
      [rawToHash(rawCode)]
    );
    if (rows.length) {
      const meta = typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta || "{}") : (rows[0].meta || {});
      const id = parseInt(meta.customer_company_id, 10);
      if (id) return { customer_company_id: id, auth_scope: "customer_quote_link" };
    }
  } else if (rawCode === "public") {
    return { customer_company_id: null, auth_scope: "public" };
  }

  const user = verifyToken(authHeaderToken(req));
  const id = parseInt(user?.company_id ?? user?.companyId, 10);
  if (Number.isFinite(id) && id > 0) return { customer_company_id: id, auth_scope: "customer_jwt" };
  if (!rawCode) return { customer_company_id: null, auth_scope: "public" };
  const fwd = await pool.query(
    `SELECT company_id FROM forwarder_portal_tokens
      WHERE code = $1 AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [rawCode]
  );
  if (fwd.rows.length) {
    return { customer_company_id: null, auth_scope: "forwarder_portal", forwarder_company_id: fwd.rows[0].company_id || null };
  }
  return null;
}

function targetPatch(gp20, hq40) {
  const patch = {};
  if (gp20 !== null) patch["20GP"] = gp20;
  if (hq40 !== null) patch["40HQ"] = hq40;
  return patch;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const pool = getPool();
  const b = req.body || {};
  const polIn = cleanText(b.pol);
  const podIn = cleanText(b.pod);
  const carrier = cleanText(b.carrier);
  if (!polIn || !podIn || !carrier) return res.status(400).json({ ok: false, error: "pol_pod_carrier_required" });

  const targetGp20 = parseUsd(b.target_gp20);
  const targetHq40 = parseUsd(b.target_hq40);
  if (Number.isNaN(targetGp20) || Number.isNaN(targetHq40)) {
    return res.status(400).json({ ok: false, error: "target_must_be_positive" });
  }
  if (targetGp20 === null && targetHq40 === null) {
    return res.status(400).json({ ok: false, error: "target_required" });
  }

  const deliveryDeadline = parseDeliveryDeadline(b.delivery_deadline);
  if (Number.isNaN(deliveryDeadline)) {
    return res.status(400).json({ ok: false, error: "deadline_invalid" });
  }
  const containerQty = parseContainerQty(b.container_qty);
  if (Number.isNaN(containerQty)) {
    return res.status(400).json({ ok: false, error: "qty_invalid" });
  }

  const cust = await resolveCustomer(pool, req, b.code);
  if (!cust) return res.status(401).json({ ok: false, error: "invalid_code" });

  const [pol, pod] = await Promise.all([resolvePort(pool, polIn), resolvePort(pool, podIn)]);
  if (pol.status !== "resolved") return res.status(400).json({ ok: false, error: "pol_" + pol.status, side: "pol", candidates: pol.candidates || [] });
  if (pod.status !== "resolved") return res.status(400).json({ ok: false, error: "pod_" + pod.status, side: "pod", candidates: pod.candidates || [] });

  const targets = targetPatch(targetGp20, targetHq40);
  const ctnrType = targetGp20 !== null && targetHq40 !== null ? "MIXED" : (targetGp20 !== null ? "20GP" : "40HQ");
  const primaryTarget = targetHq40 ?? targetGp20;
  const meta = {
    source: "customer_bargain",
    carrier,
    targets,
    note: cleanText(b.note, 500) || null,
    delivery_deadline: deliveryDeadline,
    container_qty: containerQty,
    kind: (deliveryDeadline || containerQty) ? "reservation" : "bargain",
    submitted_at: new Date().toISOString(),
    auth_scope: cust.auth_scope,
    forwarder_company_id: cust.forwarder_company_id || null,
  };

  const { rows } = await pool.query(
    `INSERT INTO freight_rfqs
       (pol, pod, pol_port_id, pod_port_id, ctnr_type, status, route,
        customer_company_id, created_by, service_type, client_target_usd, request_meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$7,'customer_bargain','ocean',$8,$9::jsonb,NOW())
     RETURNING id`,
    [pol.canonical_name, pod.canonical_name, pol.port_id, pod.port_id, ctnrType,
     `${pol.canonical_name}→${pod.canonical_name}`, cust.customer_company_id,
     primaryTarget, JSON.stringify(meta)]
  );

  const targetText = Object.entries(targets).map(([k, v]) => `${k} USD ${v}`).join(" / ");
  await writeRfqNotification(pool, rows[0].id, "客户议价目标价",
    `${pol.canonical_name}→${pod.canonical_name} ${carrier} ${targetText}`,
    { customer_company_id: cust.customer_company_id, source: "customer_bargain", targets });

  return res.json({ ok: true, rfq_id: rows[0].id, status: "requested" });
}
