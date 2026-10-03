import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSweep, undoSweep, sweepGroups } from './hr-bossdesk-sweep.mjs';
import { tryBossdeskAction } from './hr-bossdesk.mjs';
import { mockDB, response } from '../../test-support/sweep-mock.mjs';
const p=(id, recommendation='cancel')=>({id:'weekly-sweep:'+id,task_id:id,state:'proposed',recommendation,
  domain:'trade',sweep_week:'2026-10-05',title:'核对'+id,reason:'超过90天无事件',snapshot:{status:'open'},
  created_at:'2026-10-05T01:00:00Z',last_event_at:null});
test('non-boss cannot approve and causes no queries',async()=> {
  const db=mockDB([p('A')]),res=response();
  await tryBossdeskAction({action:'boss_decide_batch',b:{decision:'yes',items:[{task_id:p('A').id}]},res,pool:db,me:{id:999}});
  assert.equal(res.code,403);assert.equal(db.calls.length,0);
});
test('boss selects several proposals; only proposals approved, no task mutation',async()=> {
  const db=mockDB([p('A'),p('B'),p('C')]),res=response();
  await tryBossdeskAction({action:'boss_decide_batch',b:{decision:'yes',items:[{task_id:p('A').id},{task_id:p('B').id}]},res,pool:db,me:{id:35}});
  assert.equal(res.code,200);assert.equal(res.body.count,2);
  assert.deepEqual(db.proposals.map(p=>p.state),['approved','approved','proposed']);
  assert.ok(!db.calls.some(q=>/update tasks|update public.tasks|insert into public.task_events/.test(q.sql)));
});
test('no rejects and continue agrees without cancelling anything',async()=> {
  const db=mockDB([p('A'),p('B','continue')]);
  await decideSweep({decision:'no',items:[{task_id:p('A').id}]},response(),db);
  await decideSweep({decision:'yes',items:[{task_id:p('B').id}]},response(),db);
  assert.deepEqual(db.proposals.map(p=>p.state),['rejected','applied']);
});
test('mixed selection, missing proposal, invalid decision fail without partial approval',async()=> {
  for(const b of [
    {decision:'yes',items:[{task_id:p('A').id},{task_id:'normal-task'}]},
    {decision:'yes',items:[{task_id:p('A').id},{task_id:p('MISSING').id}]},
    {decision:'garbage',items:[{task_id:p('A').id}]}
  ]) {const db=mockDB([p('A')]),res=response();await decideSweep(b,res,db);
    assert.ok(res.code>=400);assert.equal(db.proposals[0].state,'proposed');}
});
test('undo inside five minutes revokes approval; execution afterwards cannot use it',async()=> {
  const db=mockDB([p('A')]),res=response();
  await decideSweep({decision:'yes',items:[{task_id:p('A').id}]},res,db);
  const undo=response();await undoSweep({batch_id:res.body.batch_id},undo,db);
  assert.equal(undo.code,200);assert.equal(db.proposals[0].state,'proposed');assert.equal(db.proposals[0].approved_by,null);
});
test('undo refuses after window or actual destructive execution',async()=> {
  for(const extra of [{decided_at:new Date(Date.now()-400000).toISOString(),state:'approved'},
    {decided_at:new Date().toISOString(),state:'applied'}]) {
    const db=mockDB([{...p('A'),batch_id:'weekly-sweep:B',...extra}]),res=response();
    await undoSweep({batch_id:'weekly-sweep:B'},res,db);assert.equal(res.code,409);
  }
});
test('group cards max 50; every visible row includes its reason and true task ID',async()=> {
  const db=mockDB(Array.from({length:51},(_,i)=>p(String(i))));const groups=await sweepGroups(db);
  assert.equal(groups.length,2);assert.deepEqual(groups.map(g=>g.rows.length),[50,1]);
  assert.equal(groups[0].kind,'weekly_sweep');
  for(const g of groups)for(const r of g.rows){assert.ok(r.spec.includes(r.reason));assert.ok(r.spec.includes(r.code));}
  assert.match(groups[0].foot,/v2026\.10\.04-2.*生成时间/);
});
