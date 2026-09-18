import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";
import { docIssueDate, issueDocNo, normalizeDocSeed } from "./portcharge-close-loop.js";
import { buildCustomerBillSnapshot, fingerprintSnapshot, getCustomerBillFxRate } from "./customer-bill-snapshot.js";

const WRITE_ROLES = new Set(["admin", "finance", "internal_ops"]);
const TYPES = new Set(["fob_invoice", "fob_portcharge", "exw_invoice"]);

function clean(v, max = 500) { return String(v == null ? "" : v).trim().slice(0, max); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function actor(req) { const u = req.user || {}; return clean(u.email || u.username || u.name || u.role || "unknown", 120); }
function role(req) { return clean(req.user?.role, 40).toLowerCase(); }
function requireWrite(req, res) {
  if (!WRITE_ROLES.has(role(req))) { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
  return true;
}
function requireAdmin(req, res) {
  if (role(req) !== "admin") { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
  return true;
}
function docPrefix(type) { return type === "fob_portcharge" ? "PC" : type === "exw_invoice" ? "EXW" : "OF"; }

async function loadPlan(db, bl) {
  const r = await db.query(
    `SELECT id, _id, bl_no, contract_no, vessel, voyage, pol, pod, etd, created_at, so_date, raw
       FROM shipping_plans WHERE bl_no=$1 OR _id=$1 OR id::text=$1 ORDER BY id DESC LIMIT 1`,
    [clean(bl, 120)]
  );
  return r.rows[0] || null;
}

async function loadLines(db, { bl, type, payer, onlyFree = false, ids = null }) {
  const args = [clean(bl, 120)];
  const where = [`(bl_no=$1 OR link_plan_id=(SELECT id::text FROM shipping_plans WHERE bl_no=$1 ORDER BY id DESC LIMIT 1))`, `COALESCE(rebill_status,'') NOT IN ('voided','absorbed')`];
  if (type === "fob_invoice") where.push(`UPPER(COALESCE(currency,''))='USD'`);
  if (type === "fob_portcharge") where.push(`UPPER(COALESCE(currency,''))<>'USD'`);
  if (clean(payer, 80)) { args.push(clean(payer, 80)); where.push(`payer_company_code=$${args.length}`); }
  if (onlyFree) where.push(`customer_bill_id IS NULL`);
  if (Array.isArray(ids)) { args.push(ids); where.push(`id=ANY($${args.length}::uuid[])`); }
  const r = await db.query(
    `SELECT id, bl_no, cost_category, amount, sale_amount, currency, qty, unit_price, charge_basis,
            payer_company_code, customer_bill_id, ar_paid_amount, raw
       FROM freight_supplier_bills WHERE ${where.join(" AND ")} ORDER BY sort_order NULLS LAST, id`,
    args
  );
  return r.rows;
}

async function event(db, billId, kind, actorKind, by, note, payload = {}) {
  await db.query(
    `INSERT INTO customer_bill_events(bill_id,event,actor_kind,actor,note,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [billId, kind, actorKind, by, note || null, JSON.stringify(payload)]
  );
}

async function revokeMagicLink(db, id) {
  if (id) await db.query(`UPDATE magic_links SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL`, [id]);
}

async function issueCustomerDocNo(db, { type, seq, issueDate, seed, bl, totals, by, snapshot }) {
  const mainNo = await issueDocNo(db, {
    docDate: issueDate, noDate: false, noSeq: true, prefix: docPrefix(type), seed, blNo: bl,
    docType: type, totalUsd: totals.USD, totalCny: totals.CNY, generatedBy: by, snapshot,
  });
  if (!seq) return mainNo;
  const docNo = `${mainNo}-A${seq}`;
  try {
    await db.query(
      `INSERT INTO doc_issue_log(doc_no,bl_no,doc_type,total_usd,total_cny,generated_by,snapshot)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [docNo, bl || null, type, totals.USD, totals.CNY, by, JSON.stringify(snapshot)]
    );
  } catch (e) {
    if (e?.code !== "23505") throw e;
  }
  return docNo;
}

async function audit(db, line, sale, req, reason) {
  await db.query(
    `INSERT INTO finance_audit_log(table_name,row_id,field,old_value,new_value,actor,source,reason)
     VALUES('freight_supplier_bills',$1,'sale_amount',$2,$3,$4,'customer-bill',$5)`,
    [String(line.id), line.sale_amount == null ? null : String(line.sale_amount), String(sale), actor(req), clean(reason, 500) || null]
  );
}

export async function handleList(req, res, db) {
  if (!requireWrite(req, res)) return;
  const bl = clean(req.query.bl || req.query.bl_no, 120);
  const type = clean(req.query.type || "fob_invoice", 40);
  if (!bl || !TYPES.has(type)) return res.status(400).json({ ok: false, error: "bad_request" });
  const bills = await db.query(
    `SELECT cb.*, COALESCE((SELECT json_agg(e ORDER BY e.created_at) FROM customer_bill_events e WHERE e.bill_id=cb.id),'[]'::json) AS events
       FROM customer_bills cb WHERE bl_no=$1 AND doc_type=$2 ORDER BY seq,id`, [bl, type]
  );
  const lines = await loadLines(db, { bl, type });
  const auditRows = await db.query(
    `SELECT * FROM finance_audit_log WHERE table_name='freight_supplier_bills'
      AND field='sale_amount' AND row_id=ANY($1::text[]) ORDER BY id DESC LIMIT 200`,
    [lines.map(x => String(x.id))]
  );
  const outLines = lines.map(x => {
    const floor = num(x.amount), sale = num(x.sale_amount);
    return { ...x, floor, sale, markup: floor == null || sale == null ? null : sale - floor, locked: !!x.customer_bill_id };
  });
  res.json({ ok: true, bills: bills.rows, unassigned_lines: outLines.filter(x => !x.customer_bill_id), lines: outLines, price_history: auditRows.rows });
}

export async function handleLinePrice(req, res, db) {
  if (!requireWrite(req, res)) return;
  const id = clean(req.body?.line_id, 80);
  const sale = num(req.body?.sale_amount);
  if (!id || sale == null) return res.status(400).json({ ok: false, error: "bad_request" });
  const r = await db.query(`SELECT * FROM freight_supplier_bills WHERE id=$1::uuid LIMIT 1`, [id]);
  const line = r.rows[0];
  if (!line) return res.status(404).json({ ok: false, error: "not_found" });
  const floor = num(line.amount);
  if (floor == null) return res.status(400).json({ ok: false, error: "missing_floor" });
  if (sale < floor) return res.status(400).json({ ok: false, error: "below_floor", floor });
  if (line.customer_bill_id) {
    const b = await db.query(`SELECT status FROM customer_bills WHERE id=$1`, [line.customer_bill_id]);
    if (b.rows[0]?.status === "confirmed") return res.status(409).json({ ok: false, error: "locked" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE freight_supplier_bills SET sale_amount=$1, updated_at=NOW() WHERE id=$2::uuid`, [sale, id]);
    await audit(client, line, sale, req, req.body?.reason);
    if (line.customer_bill_id) {
      const old = await client.query(`SELECT magic_link_id FROM customer_bills WHERE id=$1 AND status='sent'`, [line.customer_bill_id]);
      await client.query(`UPDATE customer_bills SET status='draft', magic_link_id=NULL, sent_at=NULL, updated_at=NOW() WHERE id=$1 AND status='sent'`, [line.customer_bill_id]);
      await revokeMagicLink(client, old.rows[0]?.magic_link_id);
      await event(client, line.customer_bill_id, "price_changed", "staff", actor(req), clean(req.body?.reason, 500), { line_id: id, sale_amount: sale });
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function handleSend(req, res, db) {
  if (!requireWrite(req, res)) return;
  const bl = clean(req.body?.bl || req.body?.bl_no, 120), type = clean(req.body?.type, 40), payer = clean(req.body?.payer_company_code, 80);
  if (!bl || !payer || !TYPES.has(type)) return res.status(400).json({ ok: false, error: "bad_request" });
  const plan = await loadPlan(db, bl);
  const draft = await db.query(
    `SELECT * FROM customer_bills WHERE bl_no=$1 AND payer_company_code=$2 AND doc_type=$3 AND status='draft' ORDER BY id DESC LIMIT 1`,
    [bl, payer, type]
  );
  const lines = draft.rows[0]
    ? await loadLines(db, { bl, type, payer, ids: draft.rows[0].line_ids || [] })
    : await loadLines(db, { bl, type, payer, onlyFree: true });
  if (!lines.length) return res.status(400).json({ ok: false, error: "no_lines" });
  const missing = lines.filter(x => num(x.amount) == null).map(x => x.id);
  if (missing.length) return res.status(400).json({ ok: false, error: "missing_floor", line_ids: missing });
  const below = lines.filter(x => num(x.sale_amount) == null || num(x.sale_amount) < num(x.amount)).map(x => ({ line_id: x.id, floor: num(x.amount), sale: num(x.sale_amount) }));
  if (below.length) return res.status(400).json({ ok: false, error: "below_floor", lines: below });
  const issueDate = docIssueDate(plan || {});
  const fx = await getCustomerBillFxRate(db, issueDate);
  if (fx == null) return res.status(409).json({ ok: false, error: "missing_fx_rate" });
  const seed = normalizeDocSeed(bl, plan?.contract_no);
  if (!seed) return res.status(409).json({ ok: false, error: "missing_doc_seed" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const seqRes = draft.rows[0] ? { rows: [{ seq: draft.rows[0].seq }] } : await client.query(`SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM customer_bills WHERE bl_no=$1 AND payer_company_code=$2 AND doc_type=$3 AND status<>'void'`, [bl, payer, type]);
    const seq = Number(seqRes.rows[0].seq);
    const billBase = { doc_type: type, bl_no: bl, payer_company_code: payer, issue_date: issueDate, fx_rate: fx };
    const snap0 = buildCustomerBillSnapshot({ bill: billBase, plan, lines });
    const docNo = await issueCustomerDocNo(client, { type, seq, issueDate, seed, bl, totals: snap0.totals, by: actor(req), snapshot: snap0 });
    const snapshot = { ...snap0, doc_no: docNo };
    const fp = fingerprintSnapshot(snapshot);
    const raw = genRaw(), hash = rawToHash(raw);
    if (draft.rows[0]?.magic_link_id) await revokeMagicLink(client, draft.rows[0].magic_link_id);
    const ml = await client.query(
      `INSERT INTO magic_links(token_hash,recipient_role,meta,expires_at,access_log,created_at,created_by)
       VALUES($1,'customer_bill',$2,NOW()+INTERVAL '7 days','[]'::jsonb,NOW(),$3) RETURNING id`,
      [hash, JSON.stringify({ bill_id: null, bl_no: bl, doc_type: type, payer_company_code: payer, shipment_id: plan?.id || null }), actor(req)]
    );
    const bill = draft.rows[0] ? await client.query(
      `UPDATE customer_bills
          SET plan_id=$2, status='sent', doc_no=$3, issue_date=$4, fx_rate=$5, total_usd=$6, total_cny=$7,
              line_ids=$8::uuid[], snapshot=$9::jsonb, fingerprint=$10, sent_at=NOW(), sent_by=$11, magic_link_id=$12, updated_at=NOW()
        WHERE id=$1 AND status='draft' RETURNING id`,
      [draft.rows[0].id, plan?.id || null, docNo, issueDate, fx, snapshot.totals.USD, snapshot.totals.CNY, lines.map(x => x.id), JSON.stringify(snapshot), fp, actor(req), ml.rows[0].id]
    ) : await client.query(
      `INSERT INTO customer_bills(plan_id,bl_no,payer_company_code,doc_type,seq,status,doc_no,issue_date,fx_rate,total_usd,total_cny,line_ids,snapshot,fingerprint,sent_at,sent_by,magic_link_id)
       VALUES($1,$2,$3,$4,$5,'sent',$6,$7,$8,$9,$10,$11::uuid[],$12::jsonb,$13,NOW(),$14,$15) RETURNING id`,
      [plan?.id || null, bl, payer, type, seq, docNo, issueDate, fx, snapshot.totals.USD, snapshot.totals.CNY, lines.map(x => x.id), JSON.stringify(snapshot), fp, actor(req), ml.rows[0].id]
    );
    await client.query(`UPDATE magic_links SET meta=jsonb_set(meta,'{bill_id}',$2::jsonb,true) WHERE id=$1`, [ml.rows[0].id, JSON.stringify(bill.rows[0].id)]);
    await client.query(`UPDATE freight_supplier_bills SET customer_bill_id=$1 WHERE id=ANY($2::uuid[])`, [bill.rows[0].id, lines.map(x => x.id)]);
    await event(client, bill.rows[0].id, "sent", "staff", actor(req), null, { line_ids: lines.map(x => x.id) });
    await client.query("COMMIT");
    res.json({ ok: true, bill_id: bill.rows[0].id, url: `${APP_BASE}/kp?c=${raw}`, snapshot });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function handleVoid(req, res, db) {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.body?.bill_id);
  if (!id) return res.status(400).json({ ok: false, error: "bad_request" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const bill = await client.query(`SELECT magic_link_id FROM customer_bills WHERE id=$1 AND status<>'void'`, [id]);
    if (!bill.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "not_found" }); }
    const blocked = await client.query(
      `SELECT
         COALESCE(SUM(COALESCE(b.ar_paid_amount,0)),0)::numeric AS paid,
         COALESCE(SUM(COALESCE(b.invoiced_amount,0)),0)::numeric AS row_invoiced,
         COUNT(*) FILTER (WHERE b.rebill_finance_slip_id IS NOT NULL)::int AS rebill_slips,
         EXISTS (SELECT 1 FROM finance_invoice_bill_links l JOIN freight_supplier_bills fb ON fb.id::text=l.bill_id::text WHERE fb.customer_bill_id=$1) AS invoiced,
         EXISTS (SELECT 1 FROM freight_bill_items i JOIN freight_bills h ON h.id=i.bill_id JOIN freight_supplier_bills fb ON fb.id=i.fee_id WHERE fb.customer_bill_id=$1 AND COALESCE(h.invoiced_amount,0)>0) AS bill_invoiced
       FROM freight_supplier_bills b WHERE b.customer_bill_id=$1`,
      [id]
    );
    if (Number(blocked.rows[0].paid) > 0 || Number(blocked.rows[0].row_invoiced) > 0 || Number(blocked.rows[0].rebill_slips) > 0 || blocked.rows[0].invoiced || blocked.rows[0].bill_invoiced) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "paid_or_invoiced" });
    }
    await client.query(`UPDATE customer_bills SET status='void', voided_at=NOW(), voided_by=$2, void_reason=$3, updated_at=NOW() WHERE id=$1`, [id, actor(req), clean(req.body?.reason, 500) || "void"]);
    await revokeMagicLink(client, bill.rows[0].magic_link_id);
    await client.query(`UPDATE freight_supplier_bills SET customer_bill_id=NULL WHERE customer_bill_id=$1`, [id]);
    await event(client, id, "voided", "staff", actor(req), clean(req.body?.reason, 500));
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function handleLegacy(req, res, db) {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {}, bl = clean(b.bl || b.bl_no, 120), type = clean(b.type, 40), payer = clean(b.payer_company_code, 80);
  if (!bl || !payer || !TYPES.has(type) || !b.doc_no || !b.issue_date || !Array.isArray(b.line_ids)) return res.status(400).json({ ok: false, error: "bad_request" });
  const plan = await loadPlan(db, bl), lines = await loadLines(db, { bl, type, ids: b.line_ids });
  const wanted = new Set(b.line_ids.map(x => clean(x, 80)));
  const found = new Set(lines.map(x => clean(x.id, 80)));
  const missing = [...wanted].filter(x => !found.has(x));
  if (missing.length) return res.status(400).json({ ok: false, error: "line_not_found_or_scope", line_ids: missing });
  const badAmount = lines.filter(x => num(x.amount) == null).map(x => x.id);
  if (badAmount.length) return res.status(400).json({ ok: false, error: "missing_floor", line_ids: badAmount });
  const below = lines.filter(x => num(x.sale_amount) == null || num(x.sale_amount) < num(x.amount)).map(x => ({ line_id: x.id, floor: num(x.amount), sale: num(x.sale_amount) }));
  if (below.length) return res.status(400).json({ ok: false, error: "below_floor", lines: below });
  const bound = lines.filter(x => x.customer_bill_id).map(x => x.id);
  if (bound.length) {
    const linked = await db.query(
      `SELECT fb.id, fb.customer_bill_id, cb.status
         FROM freight_supplier_bills fb
         LEFT JOIN customer_bills cb ON cb.id=fb.customer_bill_id
        WHERE fb.id=ANY($1::uuid[]) AND fb.customer_bill_id IS NOT NULL
          AND COALESCE(cb.status,'') <> 'void'`,
      [bound]
    );
    if (linked.rows.length) return res.status(400).json({ ok: false, error: "line_bound_to_active_bill", lines: linked.rows });
  }
  const snapshot = buildCustomerBillSnapshot({ bill: { doc_type: type, doc_no: b.doc_no, issue_date: b.issue_date, fx_rate: b.fx_rate, bl_no: bl, payer_company_code: payer }, plan, lines });
  snapshot.totals = { USD: num(b.total_usd) || 0, CNY: num(b.total_cny) || 0 };
  const fp = fingerprintSnapshot(snapshot);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO customer_bills(plan_id,bl_no,payer_company_code,doc_type,seq,status,doc_no,issue_date,fx_rate,total_usd,total_cny,line_ids,snapshot,fingerprint,legacy,confirmed_at,confirmed_by_name)
       VALUES($1,$2,$3,$4,COALESCE((SELECT MAX(seq)+1 FROM customer_bills WHERE bl_no=$2 AND payer_company_code=$3 AND doc_type=$4 AND status<>'void'),0),'confirmed',$5,$6,$7,$8,$9,$10::uuid[],$11::jsonb,$12,true,NOW(),$13) RETURNING id`,
      [plan?.id || null, bl, payer, type, b.doc_no, b.issue_date, b.fx_rate, b.total_usd, b.total_cny, b.line_ids, JSON.stringify(snapshot), fp, actor(req)]
    );
    await client.query(`UPDATE freight_supplier_bills SET customer_bill_id=$1 WHERE id=ANY($2::uuid[])`, [r.rows[0].id, b.line_ids]);
    await event(client, r.rows[0].id, "legacy_registered", "staff", actor(req), clean(b.reason, 500));
    await client.query("COMMIT");
    res.json({ ok: true, bill_id: r.rows[0].id, snapshot });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
