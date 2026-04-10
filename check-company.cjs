const {Client}=require('pg');
const client=new Client({
  host:'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:'sanlyn_db',
  user:'sanlyn_admin',password:'SanlynRDS2026!',ssl:false
});
client.connect().then(async()=>{
  // Check all tables
  const tables=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  console.log('所有表:', tables.rows.map(r=>r.tablename).join(', '));

  // Check if there's a companies or suppliers table
  for(const t of ['companies','suppliers','vendor','vendors','factory_info']){
    try{
      const r=await client.query('SELECT * FROM '+t+' LIMIT 2');
      console.log('\n表 '+t+' 字段:', Object.keys(r.rows[0]||{}));
    }catch(e){}
  }

  // Check factories raw column if any
  const f=await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='factories'");
  console.log('\nfactories表所有字段:', f.rows.map(r=>r.column_name).join(', '));

  // Check customers table for factory-like entries
  try{
    const c=await client.query("SELECT * FROM customers WHERE name LIKE '%中宠%' OR name LIKE '%泰迪%' OR name LIKE '%宠银%' LIMIT 5");
    console.log('\ncustomers中的工厂:', c.rows.length,'条');
    c.rows.forEach(r=>console.log(JSON.stringify(r)));
  }catch(e){console.log('customers:',e.message);}

  await client.end();
}).catch(e=>console.error(e.message));
