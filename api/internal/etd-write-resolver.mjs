#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function dateOnly(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function hashSql(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');
}

function cleanCandidate(input) {
  const c = input?.candidate || {};
  return {
    task_id: String(c.task_id || ''),
    order_id: c.order_id == null ? '' : String(c.order_id),
    order_no: String(c.order_no || '').trim().toUpperCase(),
    etd: dateOnly(c.etd),
    source_plan_id: c.source_plan_id == null ? '' : String(c.source_plan_id),
    evidence: c.evidence && typeof c.evidence === 'object' ? c.evidence : {},
  };
}

function fail(status, reason, extra = {}) {
  return { applied: false, verified: false, status, reason, ...extra };
}

async function fillEtdFromPlan(input) {
  if (input?.action !== 'fill_etd_from_plan') return fail('permission_denied', 'unsupported action');
  const c = cleanCandidate(input);
  if (!c.task_id || (!c.order_id && !c.order_no) || !c.etd || !c.source_plan_id) {
    return fail('blocked_bad_input', 'missing task_id/order_id-or-order_no/etd/source_plan_id', { candidate: c });
  }

  const writeDsn = process.env.SANLYN_RESOLVER_PG_DSN;
  const readDsn = process.env.SANLYN_READONLY_PG_DSN;
  if (!writeDsn) return fail('blocked_config', 'missing SANLYN_RESOLVER_PG_DSN');
  if (!readDsn) return fail('blocked_config', 'missing SANLYN_READONLY_PG_DSN');
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch (e) {
    return fail('blocked_dependency', 'missing pg package: ' + e.message);
  }

  const verifySql = 'SELECT id::text, COALESCE(etd::text, \'\') AS etd FROM public.orders WHERE id::text = $1';
  const verifySqlHash = hashSql(verifySql);
  const actor = process.env.AI_RESOLVER_ACTOR || 'task-resolver';
  const sourceModel = process.env.AI_RESOLVER_SOURCE_MODEL || 'codex-m2a';
  const rollback = { table: 'orders', pk: c.order_id || c.order_no, column: 'etd', old_value: null };

  const w = new Client({ connectionString: writeDsn, statement_timeout: 15000, query_timeout: 20000 });
  let auditId = null;
  let oldValue = null;
  let newValue = null;
  let applied = false;
  await w.connect();
  try {
    await w.query('BEGIN');
    await w.query("SET LOCAL lock_timeout = '5s'");

    const orderSql = c.order_id
      ? 'SELECT id::text, COALESCE(order_no, \'\') AS order_no, COALESCE(etd::text, \'\') AS old_etd FROM public.orders WHERE id::text = $1 FOR UPDATE'
      : 'SELECT id::text, COALESCE(order_no, \'\') AS order_no, COALESCE(etd::text, \'\') AS old_etd FROM public.orders WHERE UPPER(COALESCE(order_no, \'\')) = $1 FOR UPDATE';
    const orderArg = c.order_id || c.order_no;
    const orderRows = (await w.query(orderSql, [orderArg])).rows;
    if (orderRows.length !== 1) {
      await w.query('ROLLBACK');
      return fail('blocked_order_not_unique', `orders match count=${orderRows.length}`);
    }
    const order = orderRows[0];
    if (dateOnly(order.old_etd)) {
      await w.query('ROLLBACK');
      return fail('already_filled', `orders.etd already ${dateOnly(order.old_etd)}`, { old: dateOnly(order.old_etd) });
    }
    oldValue = order.old_etd || null;
    rollback.old_value = oldValue;

    const planRows = (await w.query(`
      SELECT id::text, etd::text AS etd, COALESCE(eta::text, '') AS eta
      FROM public.shipping_plans
      WHERE id::text = $1
        AND $2 = ANY(order_nos)
        AND etd IS NOT NULL
    `, [c.source_plan_id, order.order_no || c.order_no])).rows;
    if (planRows.length !== 1) {
      await w.query('ROLLBACK');
      return fail('source_ambiguous', `shipping_plans match count=${planRows.length}`);
    }
    const plan = planRows[0];
    if (dateOnly(plan.etd) !== c.etd) {
      await w.query('ROLLBACK');
      return fail('source_mismatch', `candidate etd ${c.etd} != plan.etd ${dateOnly(plan.etd)}`);
    }
    if (dateOnly(plan.eta) && dateOnly(plan.eta) === c.etd) {
      await w.query('ROLLBACK');
      return fail('source_is_eta', 'plan ETA equals candidate ETD; manual review required');
    }

    const audit = await w.query(`
      INSERT INTO public.ai_business_write_audit
        (task_id, action, actor, source_model, target_table, target_pk, target_column,
         old_value, new_value, source_evidence, verify_sql_hash, rollback_payload)
      VALUES ($1,'fill_etd_from_plan',$2,$3,'orders',$4,'etd',$5,$6,$7,$8,$9)
      RETURNING id
    `, [c.task_id, actor, sourceModel, order.id, oldValue, c.etd, JSON.stringify(c.evidence), verifySqlHash, JSON.stringify(rollback)]);
    auditId = audit.rows[0].id;

    await w.query('UPDATE public.orders SET etd = $1 WHERE id::text = $2 AND etd IS NULL', [c.etd, order.id]);
    const back = (await w.query(verifySql, [order.id])).rows[0];
    newValue = dateOnly(back?.etd);
    if (newValue !== c.etd) {
      await w.query('ROLLBACK');
      return fail('readback_mismatch', `same-tx readback ${newValue || '-'} != ${c.etd}`, { audit_id: auditId, old: oldValue });
    }
    await w.query('COMMIT');
    applied = true;

    const r = new Client({ connectionString: readDsn, statement_timeout: 15000, query_timeout: 20000 });
    await r.connect();
    let verified = false;
    try {
      const rb = (await r.query(verifySql, [order.id])).rows[0];
      verified = dateOnly(rb?.etd) === c.etd;
    } finally {
      await r.end();
    }
    if (verified) await w.query('UPDATE public.ai_business_write_audit SET verified = true WHERE id = $1', [auditId]);
    return { applied, verified, status: verified ? 'done' : 'blocked_verify_failed', old: oldValue, new: newValue, audit_id: auditId, verify_sql_hash: verifySqlHash };
  } catch (e) {
    try { await w.query('ROLLBACK'); } catch {}
    const code = e?.code || '';
    const status = code === '42501' ? 'permission_denied' : code === '55P03' ? 'lock_timeout' : 'blocked_exception';
    return { applied, verified: false, status, reason: e.message, old: oldValue, new: newValue, audit_id: auditId };
  } finally {
    await w.end();
  }
}

const input = JSON.parse((await readStdin()) || '{}');
console.log(JSON.stringify(await fillEtdFromPlan(input)));
