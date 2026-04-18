require('dotenv').config();
const {Client}=require('pg');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});
client.connect().then(async()=>{
  // Add missing columns
  const cols=[
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS tax_no VARCHAR(64) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS bank_name VARCHAR(128) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS bank_account VARCHAR(64) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS contact_name VARCHAR(64) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS contact_tel VARCHAR(32) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS contact_email VARCHAR(128) DEFAULT ''",
  ];
  for(const sql of cols){
    try{await client.query(sql);console.log('✅',sql.split('ADD COLUMN IF NOT EXISTS')[1].split(' ')[1]);}
    catch(e){console.log('⏩',e.message);}
  }
  console.log('\n字段已就绪，现有工厂:');
  const r=await client.query("SELECT id,name,address,tax_no,bank_name,bank_account FROM factories ORDER BY id");
  r.rows.forEach(f=>console.log(`  [${f.id}] ${f.name} | 地址:${f.address||'(空)'} | 税号:${f.tax_no||'(空)'}`));
  await client.end();
}).catch(e=>console.error(e.message));
