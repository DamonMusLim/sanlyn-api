require('dotenv').config();
const {Client}=require('pg');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});
client.connect().then(async()=>{
  // Check factories table
  try{
    const r=await client.query("SELECT * FROM factories LIMIT 5");
    console.log('factories表字段:', Object.keys(r.rows[0]||{}));
    console.log('共',r.rowCount,'条\n');
    r.rows.forEach(f=>console.log(JSON.stringify(f)));
  }catch(e){console.log('factories表:',e.message);}

  // Check what factory fields exist in a real PO order raw
  const o=await client.query(
    "SELECT raw FROM orders WHERE raw::text LIKE '%烟台中宠%' LIMIT 1"
  );
  if(o.rows.length){
    const raw=typeof o.rows[0].raw==='string'?JSON.parse(o.rows[0].raw):o.rows[0].raw;
    const keys=Object.keys(raw).filter(k=>k.toLowerCase().includes('factor')||k.toLowerCase().includes('vendor')||k.toLowerCase().includes('supplier')||k.toLowerCase().includes('factory'));
    console.log('\n订单中工厂相关字段:', keys);
    keys.forEach(k=>console.log(' ',k,'=',raw[k]));
  }
  await client.end();
}).catch(e=>console.error(e.message));
