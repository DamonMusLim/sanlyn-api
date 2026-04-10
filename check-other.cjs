const {Client}=require('pg');
const client=new Client({
  host:'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:'sanlyn_db',
  user:'sanlyn_admin',password:'SanlynRDS2026!',ssl:false
});
client.connect().then(async()=>{
  const r=await client.query(
    "SELECT sku, product_name, product_name_cn, brand, cat1, cat2, cat3 FROM products WHERE cat2='其他宠物用品' ORDER BY product_name LIMIT 120"
  );
  console.log('共'+r.rows.length+'条:');
  r.rows.forEach(p=>console.log(`  ${p.sku} | ${p.product_name||p.product_name_cn} | ${p.brand}`));
  await client.end();
}).catch(e=>console.error(e.message));
