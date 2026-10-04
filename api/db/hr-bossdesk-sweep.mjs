// Reuses bossdesk groups/items and boss-only authorization; no new page or task reassignment.
import { randomBytes } from 'node:crypto';
const prefix = 'weekly-sweep:';
const label = p => p.recommendation === 'merge' ? `合并到 ${p.target_id}`
  : p.recommendation === 'cancel' ? '作废' : '继续';

export async function sweepGroups(pool) {
  const rows = (await pool.query(`select * from public.task_weekly_sweep
    where state='proposed' and recommendation <> 'continue' order by sweep_week desc, domain, recommendation, task_id`)).rows;
  const groups = new Map();
  for (const p of rows) {
    const base = `${p.sweep_week}:${p.domain ?? ''}:${p.recommendation}`;
    let bucket = 0;
    while ((groups.get(`${base}:${bucket}`)?.rows.length || 0) >= 50) bucket++;
    const key = `${base}:${bucket}`;
    if (!groups.has(key)) groups.set(key, {
      key: prefix + key, kind: 'weekly_sweep', name: `每周清库 · ${p.domain ?? ''} · ${{merge:'合并',cancel:'作废',continue:'继续'}[p.recommendation]}`,
      img: null, ok: null, why: '逐项建议；勾选同意后才执行，5分钟内可撤回', caution: '', notes: [],
      foot: 'v2026.10.04-2 · 生成时间 ' + new Date(p.created_at).toISOString(), rows: []
    });
    groups.get(key).rows.push({ task_id: p.id, kind: 'weekly_sweep', code: p.task_id,
      spec: `${p.task_id} ${p.title ?? ''}；${p.reason}`, now: p.snapshot.status, sug: label(p), stock: '—',
      title: p.title ?? '', suggestion: label(p), reason: p.reason ?? '',
      exp: p.last_event_at ? new Date(p.last_event_at).toISOString() : '',
      last_event_at: p.last_event_at, last_real_activity_at: p.last_event_at, act: true });
  }
  return [...groups.values()];
}

export async function sweepDone(pool) {
  const rows = (await pool.query(`select batch_id, min(decided_at) as decided_at,
    array_agg(title order by id) as titles, array_agg(state order by id) as states, min(decision_note) as note
    from public.task_weekly_sweep where decided_at > now() - interval '24 hours' and batch_id is not null
    group by batch_id order by min(decided_at) desc limit 30`)).rows;
  return rows.map(r => ({ batch_id: r.batch_id,
    at: new Date(new Date(r.decided_at).getTime() + 8*3600000).toISOString().slice(11,16),
    action: '每周清库', titles: r.titles.join('；'), note: r.note || '',
    status: r.states.includes('approved') ? '待执行' : r.states.includes('stale') ? '任务变化，需重审'
      : r.states.includes('proposed') ? '已撤回' : r.states.every(s => s === 'rejected') ? '不同意' : '已处理',
    can_undo: Date.now() - new Date(r.decided_at).getTime() <= 300000
      && r.states.every(s => ['approved','rejected','applied'].includes(s)) }));
}

export async function decideSweep(b, res, pool) {
  if (!['yes','no'].includes(b.decision)) return res.status(400).json({ success: false, error: 'decision 只能是 yes/no' });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50
      || b.items.some(x => typeof x?.task_id !== 'string' || !x.task_id.startsWith(prefix)))
    return res.status(400).json({ success: false, error: '每批只选清库项，最多50项' });
  const ids = [...new Set(b.items.map(x => x.task_id))];
  const c = await pool.connect(), batch = prefix + randomBytes(12).toString('hex');
  try {
    await c.query('begin');
    const rows = (await c.query(`select id, state from public.task_weekly_sweep
      where id=any($1::text[]) order by id for update`, [ids])).rows;
    if (rows.length !== ids.length || rows.some(p => p.state !== 'proposed')) {
      await c.query('rollback');
      return res.status(409).json({ success: false, error: '所选提案已变化，请刷新' });
    }
    await c.query(`update public.task_weekly_sweep
      set state=case when $2='no' then 'rejected' when recommendation='continue' then 'applied' else 'approved' end,
        batch_id=$3, approved_by='damon', decided_at=now(), decision_note=$4,
        applied_at=case when $2='yes' and recommendation='continue' then now() else null end
      where id=any($1::text[])`, [ids,b.decision,batch,String(b.note || '').slice(0,200)]);
    await c.query('commit');
    return res.status(200).json({ success: true, batch_id: batch, count: ids.length });
  } catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

export async function undoSweep(b, res, pool) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const rows = (await c.query(`select id,state,recommendation,decided_at from public.task_weekly_sweep
      where batch_id=$1 order by id for update`, [b.batch_id])).rows;
    if (!rows.length || rows.some(p => Date.now()-new Date(p.decided_at).getTime() > 300000
      || !['approved','rejected','applied'].includes(p.state)
      || (p.state === 'applied' && p.recommendation !== 'continue'))) {
      await c.query('rollback');
      return res.status(409).json({ success: false, error: '已执行或超过5分钟，不能撤回审批' });
    }
    await c.query("update public.task_weekly_sweep set state='proposed', approved_by=null, applied_at=null where batch_id=$1", [b.batch_id]);
    await c.query('commit');
    return res.status(200).json({ success: true });
  } catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

export async function trySweepAction(action, b, res, pool) {
  if (action === 'boss_undo' && String(b.batch_id || '').startsWith(prefix)) {
    await undoSweep(b,res,pool); return true;
  }
  const selected = (Array.isArray(b.items) ? b.items.map(x => x?.task_id) : [])
    .concat(Array.isArray(b.task_ids) ? b.task_ids : []);
  if (!selected.some(x => String(x).startsWith(prefix))) return false;
  if (action !== 'boss_decide_batch') {
    res.status(400).json({ success: false, error: '清库提案请用同意/不同意，不支持转派或补话' }); return true;
  }
  await decideSweep(b,res,pool); return true;
}
