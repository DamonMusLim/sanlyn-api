import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { actor, bad, requireFinance } from "./bill-center-auth.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function token(req) {
  return req.query.token || req.body?.token || "";
}

function publicLine(row, meta) {
  const isPayable = meta.direction === "payable";
  const base = {
    id: row.id,
    bl_no: row.bl_no,
    container_no: row.container_no,
    cost_category: row.cost_category,
    currency: row.currency,
    qty: row.qty,
    charge_basis: row.charge_basis,
    confirmed_at: row.confirmed_at,
    collab_pending: row.collab_pending,
  };
  if (isPayable) {
    base.amount = row.amount;
    base.status = row.ap_status;
    base.paid_amount = row.ap_paid_amount;
  } else {
    base.sale_amount = row.sale_amount;
    base.status = row.ar_status;
    base.paid_amount = row.ar_paid_amount;
  }
  return base;
}

async function validateToken(pool, raw) {
  const hash = rawToHash(raw);
  const r = await pool.query(
    `SELECT token_hash, meta
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'bill_collab'
        AND expires_at > NOW()
        AND revoked_at IS NULL
        AND meta->>'bill_scope' = 'v1'
        AND NULLIF(meta->>'bl_no', '') IS NOT NULL
        AND NULLIF(meta->>'payer_company_code', '') IS NOT NULL
      LIMIT 1`,
    [hash]
  );
  if (!r.rows.length) return null;
  return { hash, meta: r.rows[0].meta || {} };
}

async function scopedRows(client, meta, ids) {
  const isPayable = meta.direction === "payable";
  const params = [meta.bl_no, meta.payer_company_code];
  const conds = [`b.bl_no = $1`, `b.payer_company_code = $2`, isPayable ? `COALESCE(b.amount, 0) > 0` : `COALESCE(b.sale_amount, 0) > 0`];
  if (meta.supplier_company_code) {
    params.push(meta.supplier_company_code);
    conds.push(`b.supplier_company_code = $${params.length}`);
  }
  if (Array.isArray(meta.allowed_categories) && meta.allowed_categories.length) {
    params.push(meta.allowed_categories);
    conds.push(`b.cost_category = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(ids) && ids.length) {
    params.push(ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0));
    conds.push(`b.id = ANY($${params.length}::int[])`);
  }
  return client.query(
    `SELECT b.id, b.bl_no, b.container_no, b.cost_category, b.currency, b.qty, b.unit_price,
            b.amount, b.ap_status, b.ap_paid_amount, b.sale_amount, b.charge_basis, b.ar_status, b.ar_paid_amount, b.confirmed_at,
            b.raw->'collab_pending' AS collab_pending
       FROM active_freight_supplier_bills b
      WHERE ${conds.join(" AND ")}
      ORDER BY b.id`,
    params
  );
}

export async function validateCollab(req, res) {
  setCors(req, res, "GET, OPTIONS");
  const pool = getPool();
  const v = await validateToken(pool, token(req));
  if (!v) return bad(res, 401, "invalid_token", "invalid or expired token");
  const rows = await scopedRows(pool, v.meta);
  await pool.query(
    `UPDATE magic_links SET access_log = COALESCE(access_log, '[]'::jsonb) || $1::jsonb WHERE token_hash = $2`,
    [JSON.stringify([{ at: new Date().toISOString(), action: "validate" }]), v.hash]
  );
  return res.status(200).json({
    success: true,
    meta: {
      direction: v.meta.direction,
      bl_no: v.meta.bl_no,
      allowed_categories: v.meta.allowed_categories || [],
      allowed_actions: v.meta.allowed_actions || [],
      display_profile: v.meta.display_profile || "customer",
    },
    data: rows.rows.map((r) => publicLine(r, v.meta)),
  });
}

export async function submitCollab(req, res) {
  setCors(req, res, "POST, OPTIONS");
  const pool = getPool();
  const v = await validateToken(pool, token(req));
  if (!v) return bad(res, 401, "invalid_token", "invalid or expired token");
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const invoice = req.body?.invoice || null;
  if (!lines.length && !invoice) return bad(res, 400, "empty_submission", "lines or invoice required");
  const ids = lines.map((l) => Number(l.id)).filter((n) => Number.isInteger(n) && n > 0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scoped = await scopedRows(client, v.meta, ids.length ? ids : undefined);
    const allowed = new Set(scoped.rows.map((r) => Number(r.id)));
    for (const line of lines.length ? lines : scoped.rows) {
      const id = Number(line.id);
      if (!allowed.has(id)) continue;
      const pending = {
        submitted_at: new Date().toISOString(),
        submitted_by: "bill_collab",
        token_hash: v.hash,
        lines: [line],
        invoice,
        status: "pending_finance_review",
      };
      await client.query(
        `UPDATE freight_supplier_bills
            SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{collab_pending}', $1::jsonb, true),
                updated_at = NOW()
          WHERE id = $2`,
        [JSON.stringify(pending), id]
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, accepted_ids: Array.from(allowed) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function reviewCollab(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (!requireFinance(req, res)) return;
  const id = Number(req.body?.id);
  const decision = req.body?.decision;
  if (!Number.isInteger(id) || id <= 0) return bad(res, 400, "bad_id", "id required");
  if (decision !== "accept" && decision !== "reject") return bad(res, 400, "bad_decision", "decision must be accept or reject");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      // Intentional raw-table read: collaboration review locks the exact bill row by id.
      `SELECT id, raw->'collab_pending' AS pending FROM freight_supplier_bills WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return bad(res, 404, "not_found", "bill row not found");
    }
    const pending = cur.rows[0].pending || {};
    pending.status = decision === "accept" ? "accepted" : "rejected";
    pending.reviewed_at = new Date().toISOString();
    pending.reviewed_by = actor(req);
    const line = Array.isArray(pending.lines) ? pending.lines[0] || {} : {};
    if (decision === "accept") {
      await client.query(
        `UPDATE freight_supplier_bills
            SET amount = COALESCE($1, amount),
                sale_amount = COALESCE($2, sale_amount),
                qty = COALESCE($3, qty),
                unit_price = COALESCE($4, unit_price),
                charge_basis = COALESCE($5, charge_basis),
                raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{collab_pending}', $6::jsonb, true),
                confirmed_at = NOW(),
                confirmed_by = $7,
                updated_at = NOW()
          WHERE id = $8`,
        [numOrNull(line.amount), numOrNull(line.sale_amount), numOrNull(line.qty), numOrNull(line.unit_price), line.charge_basis || null, JSON.stringify(pending), actor(req), id]
      );
    } else {
      await client.query(
        `UPDATE freight_supplier_bills
            SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{collab_pending}', $1::jsonb, true),
                updated_at = NOW()
          WHERE id = $2`,
        [JSON.stringify(pending), id]
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, id, status: pending.status });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
