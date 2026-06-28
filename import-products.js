require('dotenv').config();
const {Client}=require('pg');
const fs=require('fs');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,
  database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',
  password:process.env.PG_PASSWORD,
  ssl:false
});
const cols=[
  ['cat1','VARCHAR(64)'],['cat2','VARCHAR(64)'],['cat3','VARCHAR(64)'],
  ['cat1_cn','VARCHAR(64)'],['cat2_cn','VARCHAR(64)'],['cat3_cn','VARCHAR(64)'],
  ['factory_price','NUMERIC(12,2)'],['sanlyn_price','NUMERIC(12,2)'],['price_usd','NUMERIC(12,2)'],
  ['tax_rate','NUMERIC(5,4)'],['rebate_rate','NUMERIC(5,4)'],['profit','NUMERIC(12,4)'],
  ['trade_terms','VARCHAR(16)'],['declaration_name','VARCHAR(512)'],['declaration_elements','TEXT'],
  ['bl_description','VARCHAR(512)'],['factory_name','VARCHAR(256)'],['declaration_amount','NUMERIC(12,2)'],
  ['bg_bx','NUMERIC(8,2)'],['flavor','VARCHAR(128)'],['moq','VARCHAR(64)'],
  ['jdy_id','VARCHAR(64)'],['spec','VARCHAR(256)'],['image_url','VARCHAR(512)']
];
client.connect().then(async()=>{
  console.log('🔌 已连接数据库');
  for(const[c,t]of cols){
    try{await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS '+c+' '+t+" DEFAULT ''");console.log('✅ '+c);}
    catch(e){console.log('⏩ '+c+' (已存在)');}
  }
  console.log('\n📦 开始导入产品...');
  const products=JSON.parse(fs.readFileSync(require('os').homedir()+'/Desktop/sanlyn-os-dev/data/products_v2.json'));
  let ok=0,fail=0;
  for(const p of products){
    try{
      await client.query(
        'INSERT INTO products(sku,product_name,product_name_cn,brand,size,unit,cbm,net_weight,gross_weight,barcode,hs_code,factory_price,sanlyn_price,price_usd,tax_rate,rebate_rate,profit,cat1,cat2,cat3,cat1_cn,cat2_cn,cat3_cn,trade_terms,declaration_name,declaration_elements,bl_description,factory_name,declaration_amount,bg_bx,flavor,moq,jdy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33) ON CONFLICT(sku) DO UPDATE SET product_name=EXCLUDED.product_name,product_name_cn=EXCLUDED.product_name_cn,brand=EXCLUDED.brand,size=EXCLUDED.size,factory_price=EXCLUDED.factory_price,sanlyn_price=EXCLUDED.sanlyn_price,tax_rate=EXCLUDED.tax_rate,rebate_rate=EXCLUDED.rebate_rate,cat1=EXCLUDED.cat1,cat2=EXCLUDED.cat2,cat3=EXCLUDED.cat3,bl_description=EXCLUDED.bl_description,hs_code=EXCLUDED.hs_code,declaration_name=EXCLUDED.declaration_name,factory_name=EXCLUDED.factory_name,flavor=EXCLUDED.flavor,updated_at=NOW()',
        [p.sku,p.product_name||'',p.product_name_cn||'',p.brand||'',p.size||'',p.unit||'CTN',p.cbm||0,p.net_weight||0,p.gross_weight||0,p.barcode||'',p.hs_code||'',p.factory_price||null,p.sanlyn_price||null,p.price_usd||null,p.tax_rate||0,p.rebate_rate||0,p.profit||null,p.cat1||'',p.cat2||'',p.cat3||'',p.cat1_cn||'',p.cat2_cn||'',p.cat3_cn||'',p.trade_terms||'',p.declaration_name||'',p.declaration_elements||'',p.bl_description||'',p.factory_name||'',p.declaration_amount||null,p.bg_bx||null,p.flavor||'',p.moq||'',p.jdy_id||'']
      );
      ok++;
    }catch(e){fail++;if(fail<=3)console.log('err:',p.sku,e.message);}
  }
  const r=await client.query('SELECT COUNT(*) FROM products');
  console.log('\n✅ 导入完成！成功:'+ok+' 失败:'+fail);
  console.log('📊 数据库总计:'+r.rows[0].count+'条产品');
  await client.end();
}).catch(e=>console.error('连接失败:',e.message));
