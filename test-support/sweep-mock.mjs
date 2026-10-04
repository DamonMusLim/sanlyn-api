// Stateful mock PG for transaction behavior; does not claim to validate PostgreSQL itself.
import assert from 'node:assert/strict';
export function mockDB(proposals = [], tasks = []) {
  const db = { proposals: structuredClone(proposals), tasks: structuredClone(tasks), events: [], calls: [], failEvent: false,
    changedTargetEvents: 0 };
  let backup;
  const query = async (sql, p=[]) => {
    db.calls.push({sql,p});
    if(sql==='begin') backup=structuredClone({proposals:db.proposals,tasks:db.tasks,events:db.events});
    if(sql==='rollback' && backup) Object.assign(db,backup);
    if(sql.startsWith('select id, status from public.tasks where id=$1')) return {rows:db.tasks.filter(x=>x.id===p[0])};
    if(sql.includes('select * from public.task_weekly_sweep where id=')) return {rows:db.proposals.filter(x=>x.id===p[0])};
    if(sql.includes('select id, state from public.task_weekly_sweep')) return {rows:db.proposals.filter(x=>p[0].includes(x.id))};
    if(sql.includes('select id,state,recommendation,decided_at')) return {rows:db.proposals.filter(x=>x.batch_id===p[0])};
    if(sql.includes('select t.id, t.title, t.domain')) return {rows:db.tasks.filter(x=>!p.length||p[0].includes(x.id))};
    if(sql.includes('count(*)::int as changed')) return {rows:[{changed:db.changedTargetEvents}]};
    if(sql.includes('set state=case when')) {
      for(const x of db.proposals.filter(x=>p[0].includes(x.id))) {
        x.state=p[1]==='no'?'rejected':x.recommendation==='continue'?'applied':'approved';
        x.batch_id=p[2];x.approved_by='damon';x.decided_at=new Date().toISOString();
      }
    }
    if(sql.includes("set state='proposed', approved_by=null")) {
      db.proposals.filter(x=>x.batch_id===p[0]).forEach(x=>{x.state='proposed';x.approved_by=null;});
    }
    if(sql.includes("set state='stale' where id=$1")) db.proposals.find(x=>x.id===p[0]).state='stale';
    if(sql.includes("set state='applied', applied_at")) db.proposals.find(x=>x.id===p[0]).state='applied';
    if(sql.startsWith("update public.tasks set status='cancelled'")) db.tasks.find(x=>x.id===p[0]).status='cancelled';
    if(sql.includes('insert into public.task_events')) {
      if(db.failEvent) throw new Error('mock event insert failed');
      db.events.push({sql,p});
    }
    if(sql.includes("where state='proposed' and recommendation <> 'continue' order by")) return {rows:db.proposals.filter(x=>x.state==='proposed'&&x.recommendation!=='continue')};
    if(sql.includes('from public.task_weekly_sweep where decided_at >')) return {rows:[]};
    if(sql.includes('insert into public.task_weekly_sweep')) {
      assert.match(sql,/on conflict \(id\) do nothing/);
      if(db.proposals.some(x=>x.id===p[0])) return {rows:[]};
      db.proposals.push({id:p[0],task_id:p[2],state:'proposed'});return {rows:[{id:p[0]}]};
    }
    return {rows:[]};
  };
  return Object.assign(db,{query,connect:async()=>({query,release(){}})});
}
export function response() {
  return {code:200,body:null,status(s){this.code=s;return this;},json(v){this.body=v;return this;}};
}
