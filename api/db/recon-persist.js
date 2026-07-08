import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { loadConfig } from "./recon/recon-config-loader.js";
import { runReadonly } from "./recon/recon-engine.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const TEMPLATES = new Set(["ar_customer", "ap_forwarder"]);
const EXCEPTION_STATUSES = new Set(["partial_uploaded", "over_issued"]);

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function actor(req) {
  return String(req.user?.username || req.user?.email || req.user?.uid || req.user?.id || "unknown");
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseMonth(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12 ? s : null;
}

function addMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function keyOf(row, key) {
  const v = row?.[key];
  return v === null || v === undefined ? "" : String(v);
}

function lineParty(templateKey, row) {
  if (templateKey === "ar_customer") {
    const customer = row.customer || null;
    return { role: "customer", code: customer, name: customer };
  }
  const supplier = row.party_code || row.supplier_company_code || row.supplier_name || null;
  const payer = row.payer_company_code || null;
  return { role: "forwarder", code: [supplier, payer].filter(Boolean).join("|") || null, name: row.supplier_name || supplier };
}

function summarize(rows) {
  const out = { expected_total: 0, actual_total: 0, diff_total: 0, line_count: rows.length, matched_count: 0, exception_count: 0 };
  const currencies = new Set();
  for (const row of rows) {
    out.expected_total = money(out.expected_total + (money(row.expected_amount) || 0)) || 0;
    out.actual_total = money(out.actual_total + (money(row.actual_amount) || 0)) || 0;
    out.diff_total = money(out.diff_total + (money(row.diff_amount) || 0)) || 0;
    if (row.status === "matched") out.matched_count += 1;
    if (row.status && row.status !== "matched") out.exception_count += 1;
    if (row.currency) currencies.add(row.currency);
  }
  out.currency = currencies.size === 1 ? [...currencies][0] : (currencies.size > 1 ? "MIXED" : null);
  return out;
}

function groupRows(templateKey, rows, period) {
  const groups = new Map();
  for (const row of rows) {
    const p = lineParty(templateKey, row.expected);
    const sheetKey = `${templateKey}:${p.code || p.name || "unknown"}:${period}`;
    if (!groups.has(sheetKey)) groups.set(sheetKey, { sheetKey, party: p, rows: [] });
    groups.get(sheetKey).rows.push(row);
  }
  return [...groups.values()];
}

async function loadRunRows(pool, config, range) {
  const out = await runReadonly(pool, config, range);
  const matchKey = config.match_keys[0];
  const [expectedRows, actualRows] = await Promise.all([
    pool.query(config.expected.sql, [range.start, range.end]).then(r => r.rows),
    pool.query(config.actual.sql, []).then(r => r.rows),
  ]);
  const actualMap = new Map();
  for (const row of actualRows) {
    const key = keyOf(row, matchKey);
    if (!key) continue;
    const cur = actualMap.get(key) || [];
    cur.push(row);
    actualMap.set(key, cur);
  }
  const rows = expectedRows.map((expected, i) => {
    const computed = out.rows[i] || {};
    const key = keyOf(expected, matchKey);
    return {
      line_key: key,
      match_key: { [matchKey]: key },
      expected,
      actual_rows: actualMap.get(key) || [],
      expected_amount: money(computed.expected_amount),
      actual_amount: money(computed.uploaded_amount) || 0,
      diff_amount: money(computed.diff_amount),
      status: computed.status,
      currency: expected.currency || null,
      field_values: { ...expected, ...computed, [matchKey]: key },
    };
  });
  return { summary: out.summary, rows };
}

async function upsertTemplate(db, config) {
  const r = await db.query(
    `INSERT INTO recon_templates (id, template_key, name, version, status, config)
     VALUES (gen_random_uuid(), $1, $2, 1, 'active', $3::jsonb)
     ON CONFLICT (template_key) DO UPDATE
        SET name=EXCLUDED.name, config=EXCLUDED.config, status='active'
     RETURNING id`,
    [config.template_key, config.name || config.template_key, JSON.stringify(config)]
  );
  return r.rows[0].id;
}

async function findOrCreateSheet(db, templateId, templateKey, period, group, sum, user) {
  const old = await db.query(`SELECT * FROM recon_sheets WHERE sheet_key=$1 LIMIT 1`, [group.sheetKey]);
  if (old.rows[0]?.locked_at) return { sheet: old.rows[0], locked: true };
  if (old.rows[0]) {
    const r = await db.query(
      `UPDATE recon_sheets SET template_id=$2, period=$3, party_role=$4, party_code=$5, party_name=$6,
       currency=$7, tolerance_amount=1, expected_total=$8, actual_total=$9, diff_total=$10,
       line_count=$11, matched_count=$12, exception_count=$13, updated_by=$14, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [old.rows[0].id, templateId, period, group.party.role, group.party.code, group.party.name, sum.currency,
        sum.expected_total, sum.actual_total, sum.diff_total, sum.line_count, sum.matched_count, sum.exception_count, user]
    );
    return { sheet: r.rows[0], locked: false };
  }
  const r = await db.query(
    `INSERT INTO recon_sheets
     (id, template_id, template_key, sheet_key, period, party_role, party_code, party_name, status, currency,
      tolerance_amount, expected_total, actual_total, allocated_total, diff_total, line_count, matched_count,
      exception_count, visibility_snapshot, meta, created_by, updated_by)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'generated',$8,1,$9,$10,0,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$17)
     RETURNING *`,
    [templateId, templateKey, group.sheetKey, period, group.party.role, group.party.code, group.party.name, sum.currency,
      sum.expected_total, sum.actual_total, sum.diff_total, sum.line_count, sum.matched_count, sum.exception_count,
      JSON.stringify({}), JSON.stringify({}), user]
  );
  return { sheet: r.rows[0], locked: false };
}

async function upsertLine(db, sheetId, templateKey, row) {
  const old = await db.query(`SELECT * FROM recon_lines WHERE sheet_id=$1 AND line_key=$2 LIMIT 1`, [sheetId, row.line_key]);
  if (old.rows[0]?.locked_at) return old.rows[0];
  const actualRef = row.actual_rows.map(r => r.invoice_no || r.invoice_id).filter(Boolean).join(",");
  const status = old.rows[0]?.expected_confirmed_at ? old.rows[0].status : row.status;
  if (old.rows[0]) {
    const r = await db.query(
      `UPDATE recon_lines SET sheet_id=$2, match_key=$3::jsonb, party_code=$4, expected_source_type='expected_sql',
       expected_source_ref=$5, actual_source_type='invoice', actual_source_ref=$6, expected_amount=$7,
       actual_amount=$8, currency=$9, tolerance_amount=1, diff_amount=$10, status=$11,
       field_values=$12::jsonb, source_payload=$13::jsonb, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [old.rows[0].id, sheetId, JSON.stringify(row.match_key), row.expected.party_code || row.expected.customer || null,
        row.line_key, actualRef || null, row.expected_amount, row.actual_amount, row.currency, row.diff_amount, status,
        JSON.stringify(row.field_values), JSON.stringify({ expected: row.expected, actual: row.actual_rows })]
    );
    return r.rows[0];
  }
  const r = await db.query(
    `INSERT INTO recon_lines
     (id, sheet_id, template_key, line_key, match_key, party_code, expected_source_type, expected_source_ref,
      actual_source_type, actual_source_ref, expected_amount, actual_amount, allocated_amount, currency,
      tolerance_amount, diff_amount, status, field_values, source_payload)
     VALUES (gen_random_uuid(),$1,$2,$3,$4::jsonb,$5,'expected_sql',$6,'invoice',$7,$8,$9,0,$10,1,$11,$12,$13::jsonb,$14::jsonb)
     RETURNING *`,
    [sheetId, templateKey, row.line_key, JSON.stringify(row.match_key), row.expected.party_code || row.expected.customer || null,
      row.line_key, actualRef || null, row.expected_amount, row.actual_amount, row.currency, row.diff_amount, status,
      JSON.stringify(row.field_values), JSON.stringify({ expected: row.expected, actual: row.actual_rows })]
  );
  return r.rows[0];
}

async function writeException(db, templateKey, row) {
  if (!EXCEPTION_STATUSES.has(row.status) || Math.abs(money(row.diff_amount) || 0) <= 1) return;
  const old = await db.query(
    `SELECT id FROM finance_recon_exceptions WHERE source_type=$1 AND source_id=$2 AND status='open' LIMIT 1`,
    [templateKey, row.line_key]
  );
  const args = [row.expected_amount, row.actual_amount, row.diff_amount, row.currency, JSON.stringify(row.field_values)];
  if (old.rows[0]) {
    await db.query(
      `UPDATE finance_recon_exceptions SET expected_amount=$1, actual_amount=$2, diff_amount=$3,
       currency=$4, raw=$5::jsonb WHERE id=$6`,
      [...args, old.rows[0].id]
    );
    return;
  }
  await db.query(
    `INSERT INTO finance_recon_exceptions
     (source_type, source_id, expected_amount, actual_amount, diff_amount, currency, exception_type, suggestion, status, raw)
     VALUES ($1,$2,$3,$4,$5,$6,'recon_diff','待财务确认差额','open',$7::jsonb)`,
    [templateKey, row.line_key, ...args]
  );
}

async function event(db, req, data) {
  await db.query(
    `INSERT INTO recon_events
     (template_key, sheet_id, line_id, event_type, old_status, new_status, amount, currency, reason, payload, created_by, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
    [data.template_key, data.sheet_id || null, data.line_id || null, data.event_type, data.old_status || null,
      data.new_status || null, data.amount ?? null, data.currency || null, data.reason || null,
      JSON.stringify(data.payload || {}), actor(req), req.user?.role || null]
  );
}

async function handleGenerate(req, res) {
  const templateKey = String(req.body?.template_key || "").trim();
  const period = parseMonth(req.body?.period);
  if (!TEMPLATES.has(templateKey)) return json(res, 400, { error: "unsupported template_key" });
  if (!period) return json(res, 400, { error: "period must be YYYY-MM" });
  const config = loadConfig(templateKey);
  const range = { start: `${period}-01`, end: addMonth(period) };
  const pool = getPool();
  const run = await loadRunRows(pool, config, range);
  const groups = groupRows(templateKey, run.rows, period);
  const preview = { summary: run.summary, sheets: groups.length, sample_rows: run.rows.slice(0, 5) };
  if (req.body?.dry_run) return res.json({ success: true, dry_run: true, ...preview });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const templateId = await upsertTemplate(db, config);
    let lineCount = 0;
    let skippedSheets = 0;
    for (const group of groups) {
      const sum = summarize(group.rows);
      const { sheet, locked } = await findOrCreateSheet(db, templateId, templateKey, period, group, sum, actor(req));
      if (locked) { skippedSheets += 1; continue; }
      for (const row of group.rows) {
        await upsertLine(db, sheet.id, templateKey, row);
        await writeException(db, templateKey, row);
        lineCount += 1;
      }
      await event(db, req, { template_key: templateKey, sheet_id: sheet.id, event_type: "generate", payload: run.summary });
    }
    await db.query("COMMIT");
    return res.json({ success: true, period, template_key: templateKey, sheets: groups.length, skippedSheets, lineCount, summary: run.summary });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function handleSheets(req, res) {
  const args = [];
  const where = [];
  if (req.query?.template_key) { args.push(String(req.query.template_key)); where.push(`template_key=$${args.length}`); }
  if (req.query?.period) { args.push(String(req.query.period)); where.push(`period=$${args.length}`); }
  const sql = `SELECT * FROM recon_sheets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 200`;
  const r = await getPool().query(sql, args);
  return res.json({ success: true, rows: r.rows });
}

async function handleSheet(req, res) {
  const id = req.query?.id || req.body?.id;
  if (!id) return json(res, 400, { error: "id required" });
  const [sheet, lines] = await Promise.all([
    getPool().query(`SELECT * FROM recon_sheets WHERE id=$1`, [id]),
    getPool().query(`SELECT * FROM recon_lines WHERE sheet_id=$1 ORDER BY created_at, line_key`, [id]),
  ]);
  if (!sheet.rows[0]) return json(res, 404, { error: "sheet not found" });
  return res.json({ success: true, sheet: sheet.rows[0], lines: lines.rows });
}

async function handleConfirm(req, res) {
  const id = req.query?.id || req.body?.id;
  if (!id) return json(res, 400, { error: "id required" });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const old = await db.query(`SELECT * FROM recon_lines WHERE id=$1 FOR UPDATE`, [id]);
    if (!old.rows[0]) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "line not found" });
    }
    const r = await db.query(
      `UPDATE recon_lines SET expected_confirmed_at=now(), expected_confirmed_by=$2, confirmed_by_role=$3 WHERE id=$1 RETURNING *`,
      [id, actor(req), req.user?.role || null]
    );
    await event(db, req, { template_key: r.rows[0].template_key, sheet_id: r.rows[0].sheet_id, line_id: id,
      event_type: "confirm", old_status: old.rows[0].status, new_status: r.rows[0].status, reason: req.body?.note || null });
    await db.query("COMMIT");
    return res.json({ success: true, line: r.rows[0] });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function handleSettleSuggest(req, res) {
  const id = req.query?.id || req.body?.id;
  if (!id) return json(res, 400, { error: "id required" });
  const line = await getPool().query(`SELECT * FROM recon_lines WHERE id=$1`, [id]);
  const row = line.rows[0];
  if (!row) return json(res, 404, { error: "line not found" });
  if (row.template_key !== "ar_customer") return json(res, 400, { error: "settle only supports ar_customer" });
  const fv = row.field_values || {};
  const r = await getPool().query(
    `SELECT id, COALESCE(this_amount, amount) AS amount, COALESCE(paid_date, payment_date) AS paid_date,
            currency, contract_no, order_no, customer, company_code,
            (COALESCE(this_amount, amount) - $3::numeric) AS diff_amount
       FROM finance_payments
      WHERE COALESCE(direction,'') NOT IN ('out','refund')
        AND (($1 <> '' AND contract_no=$1) OR ($2 <> '' AND order_no=$2))
      ORDER BY COALESCE(paid_date, payment_date) DESC NULLS LAST, id DESC
      LIMIT 20`,
    [fv.contract_no || "", fv.order_no || "", money(row.expected_amount) || 0]
  );
  return res.json({ success: true, line: row, candidates: r.rows });
}

async function handleSettleConfirm(req, res) {
  const { payment_id: paymentId, amount_applied: amountApplied } = req.body || {};
  const lineId = req.query?.id || req.body?.id;
  const applied = money(amountApplied);
  if (!lineId || !paymentId || !applied || applied <= 0) return json(res, 400, { error: "id, payment_id, positive amount_applied required" });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const line = await db.query(`SELECT * FROM recon_lines WHERE id=$1 FOR UPDATE`, [lineId]);
    const row = line.rows[0];
    if (!row) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "line not found" });
    }
    if (row.template_key !== "ar_customer") {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "settle only supports ar_customer" });
    }
    const payment = await db.query(`SELECT id, COALESCE(this_amount, amount) AS amount, currency FROM finance_payments WHERE id=$1`, [paymentId]);
    const p = payment.rows[0];
    if (!p) {
      await db.query("ROLLBACK");
      return json(res, 404, { error: "payment not found" });
    }
    if (String(p.currency || "") !== String(row.currency || "")) {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "currency mismatch" });
    }
    const used = await db.query(
      `SELECT COALESCE(SUM(amount_applied),0) AS used FROM finance_settlement_links WHERE payment_id=$1 AND status='applied'`,
      [paymentId]
    );
    const remain = money((money(p.amount) || 0) - (money(used.rows[0]?.used) || 0)) || 0;
    if (applied > remain + 0.0001) {
      await db.query("ROLLBACK");
      return json(res, 400, { error: "amount_applied exceeds unallocated payment balance", remain });
    }
    const contractNo = row.field_values?.contract_no || row.line_key;
    await db.query(
      `INSERT INTO finance_settlement_links
       (payment_id, target_type, target_id, amount_applied, currency, status, source, created_by)
       VALUES ($1,'ar',$2,$3,$4,'applied','recon-p1',$5)`,
      [paymentId, contractNo, applied, row.currency, actor(req)]
    );
    const updated = await db.query(
      `UPDATE recon_lines SET allocated_amount=COALESCE(allocated_amount,0)+$2 WHERE id=$1 RETURNING *`,
      [lineId, applied]
    );
    await event(db, req, { template_key: row.template_key, sheet_id: row.sheet_id, line_id: lineId,
      event_type: "settle", amount: applied, currency: row.currency, payload: { payment_id: paymentId } });
    await db.query("COMMIT");
    return res.json({ success: true, line: updated.rows[0] });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

function actionFrom(req) {
  const q = String(req.query?.action || "").trim();
  if (q) return q;
  const path = String(req.url || "").split("?")[0].replace(/^\/api\/db\/recon-persist\/?/, "");
  return path.replace(/^\/+/, "") || "";
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (!requireAuth(req, res)) return;
    if (!FINANCE_ROLES.has(req.user?.role)) return json(res, 403, { error: "Forbidden", message: "仅财务/管理员可操作" });
    const action = actionFrom(req);
    if (req.method === "POST" && action === "generate") return handleGenerate(req, res);
    if (req.method === "GET" && action === "sheets") return handleSheets(req, res);
    if (req.method === "GET" && action === "sheet") return handleSheet(req, res);
    if (req.method === "POST" && action === "confirm") return handleConfirm(req, res);
    if (req.method === "POST" && action === "settle-suggest") return handleSettleSuggest(req, res);
    if (req.method === "POST" && action === "settle-confirm") return handleSettleConfirm(req, res);
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[recon-persist]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
