import { rawToHash } from "./collab-shared.js";
import { resolvePayerCompany } from "./portcharge-close-loop.js";

function clean(v, max = 500) { return String(v == null ? "" : v).trim().slice(0, max); }
function jsonObj(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) || {}; } catch (_) { return {}; } }

async function resolveToken(db, token) {
  const r = await db.query(
    `SELECT id, recipient_role, meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role IN ('customer_bill','customer_booking')
        AND expires_at>NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(clean(token, 200))]
  );
  if (!r.rows.length) return null;
  return { ...r.rows[0], meta: jsonObj(r.rows[0].meta) };
}

async function scopedBills(db, auth, billId = null) {
  const args = [];
  const where = [`status IN ('sent','confirmed')`];
  if (billId) { args.push(Number(billId)); where.push(`id=$${args.length}`); }
  if (auth.recipient_role === "customer_bill") {
    args.push(Number(auth.meta.bill_id)); where.push(`id=$${args.length}`);
  } else {
    const planId = Number(auth.meta.shipment_id || auth.meta.plan_id || auth.meta.shipping_plan_id);
    if (!planId) return [];
    const plan = await db.query(
      `SELECT id, customer, customer_en, customer_cn, customer_company_id, raw
         FROM shipping_plans WHERE id=$1 LIMIT 1`,
      [planId]
    );
    const payer = plan.rows[0] ? await resolvePayerCompany(db, plan.rows[0]) : null;
    if (!clean(payer?.code, 80)) return [];
    args.push(planId); where.push(`plan_id=$${args.length}`);
    args.push(clean(payer.code, 80)); where.push(`payer_company_code=$${args.length}`);
  }
  const r = await db.query(`SELECT * FROM customer_bills WHERE ${where.join(" AND ")} ORDER BY seq,id`, args);
  return r.rows;
}

async function event(db, billId, kind, note, payload = {}) {
  await db.query(
    `INSERT INTO customer_bill_events(bill_id,event,actor_kind,actor,note,payload)
     VALUES($1,$2,'customer','customer',$3,$4::jsonb)`,
    [billId, kind, note || null, JSON.stringify(payload)]
  );
}

export async function handlePublicGet(req, res, db) {
  const auth = await resolveToken(db, req.query?.token);
  if (!auth) return res.status(403).json({ ok: false, error: "invalid_token" });
  const bills = await scopedBills(db, auth);
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
  for (const b of bills) {
    const seen = await db.query(
      `SELECT id FROM customer_bill_events
        WHERE bill_id=$1 AND event='viewed' AND actor_kind='customer'
          AND created_at > NOW()-INTERVAL '10 minutes' LIMIT 1`,
      [b.id]
    );
    if (!seen.rows.length) await event(db, b.id, "viewed", null, { ip });
  }
  res.json({ ok: true, bills: bills.map(b => ({
    id: b.id,
    status: b.status,
    confirmed_at: b.confirmed_at,
    confirmed_by_name: b.confirmed_by_name,
    snapshot: jsonObj(b.snapshot)
  })) });
}

export async function handleConfirm(req, res, db) {
  const auth = await resolveToken(db, req.body?.token);
  if (!auth) return res.status(403).json({ ok: false, error: "invalid_token" });
  const billId = Number(req.body?.bill_id);
  const bills = await scopedBills(db, auth, billId);
  const b = bills[0];
  if (!b) return res.status(404).json({ ok: false, error: "not_found" });
  if (b.status === "confirmed") return res.status(409).json({ ok: false, error: "already_final" });
  if (b.status !== "sent") return res.status(409).json({ ok: false, error: "not_finalizable" });
  const ip = clean(req.headers["x-forwarded-for"] || req.socket?.remoteAddress, 120);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      `UPDATE customer_bills
          SET status='confirmed', confirmed_at=NOW(), confirmed_by_name=$2, confirmed_ip=$3, updated_at=NOW()
        WHERE id=$1 AND status='sent' RETURNING line_ids`,
      [b.id, clean(req.body?.name, 120) || "customer", ip]
    );
    if (!u.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ ok: false, error: "already_final" }); }
    await client.query(`UPDATE freight_supplier_bills SET customer_bill_id=$1 WHERE id=ANY($2::uuid[])`, [b.id, u.rows[0].line_ids || []]);
    await event(client, b.id, "confirmed", null, { name: clean(req.body?.name, 120), ip });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function handleComment(req, res, db) {
  const auth = await resolveToken(db, req.body?.token);
  if (!auth) return res.status(403).json({ ok: false, error: "invalid_token" });
  const text = clean(req.body?.text, 1000);
  if (!text) return res.status(400).json({ ok: false, error: "empty_comment" });
  const bills = await scopedBills(db, auth, Number(req.body?.bill_id));
  if (!bills.length) return res.status(404).json({ ok: false, error: "not_found" });
  await event(db, bills[0].id, "commented", text);
  res.json({ ok: true });
}
