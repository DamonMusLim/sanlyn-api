require('dotenv').config();
const {Client}=require('pg');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});
client.connect().then(async()=>{
  // Update id=1 to correct full name + info from invoice
  await client.query(`
    UPDATE factories SET
      name='烟台中宠食品股份有限公司',
      tax_no='913700007337235643',
      bank_name='中行烟台莱山支行',
      bank_account='235107318878'
    WHERE id=1
  `);
  console.log('✅ id=1 更名+填入税号/银行');

  // Delete duplicate id=2
  await client.query("DELETE FROM factories WHERE id=2");
  console.log('✅ 删除重复的 id=2');

  // Verify
  const f=await client.query("SELECT id,name,tax_no,bank_name,bank_account FROM factories WHERE name LIKE '%中宠%'");
  console.log('\n中宠工厂最终状态:');
  f.rows.forEach(r=>console.log(`  [${r.id}] ${r.name}\n   税号: ${r.tax_no}\n   银行: ${r.bank_name} | 账号: ${r.bank_account}`));
  await client.end();
}).catch(e=>console.error(e.message));
