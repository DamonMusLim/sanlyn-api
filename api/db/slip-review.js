// Bank slip review: human confirmation gate before writing bank_slip_links.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { reconcile } from "./freight-recon.js";
import { auditBankSlipConfirmation } from "./bank-slip-audit.js";

const MAX_BODY = 512 * 1024;

function num2(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return parseFloat(n.toFixed(2));
}

function str(v, max = 500) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

async function bodyJson(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  return readBody(req);
}

function candidateIndex(candidates) {
  const map = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (c?.shipment_no) map.set(String(c.shipment_no).toUpperCase(), c);
  }
  return map;
}

function actorFromUser(user) {
  return user?.username || user?.email || user?.account || user?.uid || user?.id || user?.sub || "unknown";
}

function buildNote(allocation, candidate) {
  const parts = [];
  if (allocation.shipment_no) parts.push(`FI-${String(allocation.shipment_no).toUpperCase()}`);
  if (allocation.note) parts.push(String(allocation.note).trim());
  if (candidate?.customer) parts.push(`customer=${candidate.customer}`);
  return parts.join(" | ").slice(0, 500) || null;
}

async function getSlip(pool, slipId) {
  const r = await pool.query(
    `SELECT id, beneficiary_name, sender_name, amount, currency, payment_date,
            remark_details, beneficiary_reference, bank_reference_no, status,
            audit_status, audit_risk_level,
            raw, raw->'match_candidates' AS candidates, created_at
       FROM bank_slips
      WHERE id=$1`,
    [slipId]
  );
  return r.rows[0] || null;
}

function selectionSource(allocation, candidate) {
  const src = str(allocation.selection_source, 40);
  if (src === "ocr_candidate" || src === "manual_input") return src;
  return candidate ? "ocr_candidate" : "manual_input";
}

async function runReconcile(pool) {
  try {
    const results = await reconcile(pool, false);
    return {
      matched: results.filter(r => r.status === "matched").length,
      exceptions: results.filter(r => r.status === "exception").length
    };
  } catch (e) {
    console.warn("[slip-review] reconcile error (non-fatal):", e.message);
    return { error: e.message };
  }
}

async function writeAuditResult(pool, slipId, actor, audit) {
  const auditStatus = audit.risk_level === "high" ? "blocked" : (audit.risk_level === "medium" ? "warning" : "passed");
  const nextStatus = audit.risk_level === "high" ? "pending_review" : "confirmed";
  await pool.query(
    `INSERT INTO bank_slip_audits (slip_id, risk_level, findings)
     VALUES ($1,$2,$3::jsonb)`,
    [slipId, audit.risk_level, JSON.stringify(audit.findings)]
  );
  await pool.query(
    `UPDATE bank_slips
        SET status=$2,
            audit_status=$3,
            audit_risk_level=$4,
            confirmed_by=$5,
            confirmed_at=COALESCE(confirmed_at, now())
      WHERE id=$1`,
    [slipId, nextStatus, auditStatus, audit.risk_level, actor]
  );
  return nextStatus;
}

async function confirmSlip(pool, body, user) {
  const slipId = body.slip_id;
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  if (!slipId) return { status: 400, json: { ok: false, error: "slip_id required" } };
  if (!allocations.length) return { status: 400, json: { ok: false, error: "allocations required" } };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slip = await getSlip(client, slipId);
    if (!slip) {
      await client.query("ROLLBACK");
      return { status: 404, json: { ok: false, error: "not found" } };
    }
    if (slip.status !== "pending_review") {
      await client.query("ROLLBACK");
      return { status: 409, json: { ok: false, error: `slip status is ${slip.status}` } };
    }
    if (slip.audit_risk_level === "high" && slip.audit_status === "blocked") {
      await client.query("ROLLBACK");
      return { status: 409, json: { ok: false, error: "high risk slip already awaits audit-review" } };
    }

    const candidates = candidateIndex(slip.raw?.match_candidates);
    let inserted = 0;
    for (const a of allocations) {
      const shipmentNo = str(a.shipment_no, 80);
      const candidate = shipmentNo ? candidates.get(shipmentNo.toUpperCase()) : null;
      const contractNo = str(a.contract_no, 120) || str(candidate?.contract_nos?.[0], 120);
      const orderNo = str(a.order_no, 120) || str(candidate?.order_nos?.[0], 120);
      const blNo = str(a.bl_no, 120) || str(candidate?.bl_no, 120);
      const note = buildNote(a, candidate);
      const source = selectionSource(a, candidate);
      if (!contractNo && !orderNo && !blNo && !note) continue;
      await client.query(
        `INSERT INTO bank_slip_links
           (slip_id, contract_no, order_no, bl_no, shipment_no, amount_alloc, alloc_currency, note, selection_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          slipId,
          contractNo,
          orderNo,
          blNo,
          shipmentNo,
          num2(a.amount_alloc),
          str(slip.currency, 3)?.toUpperCase() || null,
          note,
          source
        ]
      );
      inserted += 1;
    }
    if (!inserted) {
      await client.query("ROLLBACK");
      return { status: 400, json: { ok: false, error: "no valid allocations" } };
    }

    if (str(body.corrected_beneficiary_name, 240)) {
      await client.query(
        `UPDATE bank_slips
            SET beneficiary_name=$2,
                raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('confirmed_corrected_beneficiary_name', $2::text)
          WHERE id=$1`,
        [slipId, str(body.corrected_beneficiary_name, 240)]
      );
    }
    await client.query("UPDATE bank_slips SET status='confirmed' WHERE id=$1", [slipId]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  const actor = actorFromUser(user);
  const audit = await auditBankSlipConfirmation(pool, slipId);
  const nextStatus = await writeAuditResult(pool, slipId, actor, audit);
  if (audit.risk_level === "high") {
    return {
      status: 200,
      json: {
        ok: true,
        slip_id: slipId,
        status: nextStatus,
        audit_risk_level: audit.risk_level,
        findings: audit.findings,
        needs_review: true
      }
    };
  }

  const recon = await runReconcile(pool);
  return {
    status: 200,
    json: { ok: true, slip_id: slipId, status: "confirmed", audit_risk_level: audit.risk_level, findings: audit.findings, recon }
  };
}

async function auditReview(pool, body, user) {
  const slipId = body.slip_id;
  const note = str(body.review_note, 1000);
  if (!slipId) return { status: 400, json: { ok: false, error: "slip_id required" } };
  if (!note) return { status: 400, json: { ok: false, error: "review_note required" } };

  const r = await pool.query(
    `SELECT id, status, audit_risk_level FROM bank_slips WHERE id=$1`,
    [slipId]
  );
  const slip = r.rows[0];
  if (!slip) return { status: 404, json: { ok: false, error: "not found" } };
  if (slip.audit_risk_level !== "high" || slip.status !== "pending_review") {
    return { status: 409, json: { ok: false, error: `slip status is ${slip.status}, risk is ${slip.audit_risk_level || "none"}` } };
  }

  await pool.query(
    `UPDATE bank_slips
        SET status='confirmed',
            reviewed_by=$2,
            reviewed_at=now(),
            review_note=$3,
            audit_status='approved_override'
      WHERE id=$1`,
    [slipId, actorFromUser(user), note]
  );
  const recon = await runReconcile(pool);
  return { status: 200, json: { ok: true, slip_id: slipId, status: "confirmed", audit_status: "approved_override", recon } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const action = req.query?.action || "";

  try {
    if (req.method === "GET" && action === "pending") {
      const r = await pool.query(
        `SELECT id, beneficiary_name, sender_name, amount, currency, payment_date,
                remark_details, raw->'match_candidates' AS candidates,
                audit_status, audit_risk_level,
                COALESCE((
                  SELECT a.findings FROM bank_slip_audits a
                   WHERE a.slip_id = bank_slips.id
                   ORDER BY a.audit_run_at DESC
                   LIMIT 1
                ), '[]'::jsonb) AS findings,
                created_at
           FROM bank_slips
          WHERE status='pending_review'
          ORDER BY created_at DESC
          LIMIT 50`
      );
      return res.json({ ok: true, rows: r.rows });
    }

    if (req.method === "GET" && action === "one") {
      const slip = await getSlip(pool, req.query?.id);
      if (!slip) return res.status(404).json({ ok: false, error: "not found" });
      return res.json({ ok: true, slip });
    }

    if (req.method === "POST" && action === "confirm") {
      const result = await confirmSlip(pool, await bodyJson(req), req.user);
      return res.status(result.status).json(result.json);
    }

    if (req.method === "POST" && action === "audit-review") {
      const result = await auditReview(pool, await bodyJson(req), req.user);
      return res.status(result.status).json(result.json);
    }

    if (req.method === "POST" && action === "reject") {
      const body = await bodyJson(req);
      if (!body.slip_id) return res.status(400).json({ ok: false, error: "slip_id required" });
      await pool.query(
        `UPDATE bank_slips
            SET status='rejected',
                raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('review_reject_reason', $2::text)
          WHERE id=$1`,
        [body.slip_id, str(body.reason, 500)]
      );
      return res.json({ ok: true, slip_id: body.slip_id, status: "rejected" });
    }

    return res.status(405).json({ ok: false, error: "unsupported action" });
  } catch (e) {
    if (String(e.message).includes("bad json")) return res.status(400).json({ ok: false, error: "bad json" });
    if (String(e.message).includes("too large")) return res.status(413).json({ ok: false, error: "body too large" });
    console.error("[slip-review]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
