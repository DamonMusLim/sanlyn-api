require('dotenv').config();
const {Client}=require('pg');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});
client.connect().then(async()=>{
  const cols=await client.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='finance_payments' ORDER BY ordinal_position");
  console.log('finance_payments字段:');
  cols.rows.forEach(r=>console.log(`  ${r.column_name}: ${r.data_type}`));
  const cnt=await client.query("SELECT COUNT(*) FROM finance_payments");
  console.log('\n现有记录:',cnt.rows[0].count);
  await client.end();
}).catch(e=>console.error('表不存在或错误:',e.message));
