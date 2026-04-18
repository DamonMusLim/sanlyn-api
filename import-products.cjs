require('dotenv').config();
const {Client}=require('pg');
const fs=require('fs');
const path=require('path');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});

const ALL_COLS=[
  ['size','VARCHAR(128)',"DEFAULT ''"],
  ['unit','VARCHAR(16)',"DEFAULT 'CTN'"],
  ['spec','VARCHAR(256)',"DEFAULT ''"],
  ['cbm','NUMERIC(12,6)','DEFAULT 0'],
  ['net_weight','NUMERIC(12,2)','DEFAULT 0'],
  ['gross_weight','NUMERIC(12,2)','DEFAULT 0'],
  ['barcode','VARCHAR(64)',"DEFAULT ''"],
  ['hs_code','VARCHAR(32)',"DEFAULT ''"],
  ['image_url','VARCHAR(512)',"DEFAULT ''"],
  ['cat1','VARCHAR(64)',"DEFAULT ''"],
  ['cat2','VARCHAR(64)',"DEFAULT ''"],
  ['cat3','VARCHAR(64)',"DEFAULT ''"],
  ['cat1_cn','VARCHAR(64)',"DEFAULT ''"],
  ['cat2_cn','VARCHAR(64)',"DEFAULT ''"],
  ['cat3_cn','VARCHAR(64)',"DEFAULT ''"],
  ['factory_price','NUMERIC(12,2)','DEFAULT NULL'],
  ['sanlyn_price','NUMERIC(12,2)','DEFAULT NULL'],
  ['price_usd','NUMERIC(12,2)','DEFAULT NULL'],
  ['tax_rate','NUMERIC(5,4)','DEFAULT 0'],
  ['rebate_rate','NUMERIC(5,4)','DEFAULT 0'],
  ['profit','NUMERIC(12,4)','DEFAULT NULL'],
  ['trade_terms','VARCHAR(16)',"DEFAULT ''"],
  ['declaration_name','VARCHAR(512)',"DEFAULT ''"],
  ['declaration_elements','TEXT',"DEFAULT ''"],
  ['bl_description','VARCHAR(512)',"DEFAULT ''"],
  ['factory_name','VARCHAR(256)',"DEFAULT ''"],
  ['declaration_amount','NUMERIC(12,2)','DEFAULT NULL'],
  ['bg_bx','NUMERIC(8,2)','DEFAULT NULL'],
  ['flavor','VARCHAR(128)',"DEFAULT ''"],
  ['moq','VARCHAR(64)',"DEFAULT ''"],
  ['jdy_id','VARCHAR(64)',"DEFAULT ''"],
];

client.connect().then(async()=>{
  console.log('🔌 已连接数据库');

  // Check + add missing columns
  const res=await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='products'"
  );
  const existing=new Set(res.rows.map(r=>r.column_name));
  for(const[c,t,d]of ALL_COLS){
    if(!existing.has(c)){
      try{await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS '+c+' '+t+' '+d);console.log('✅ 新增: '+c);}
      catch(e){console.log('⚠️  '+c+': '+e.message);}
    }
  }

  // Ensure UNIQUE constraint on sku
  try{
    await client.query('ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku)');
    console.log('✅ 添加 sku 唯一约束');
  }catch(e){
    if(e.message.includes('already exists')||e.message.includes('already exists')){
      console.log('⏩ sku 唯一约束已存在');
    } else {
      console.log('⚠️  约束: '+e.message);
    }
  }

  console.log('\n📦 导入产品中...');
  const products=JSON.parse(fs.readFileSync(path.join(require('os').homedir(),'Desktop/sanlyn-os-dev/data/products_v2.json')));
  let ok=0,fail=0;
  for(const p of products){
    try{
      await client.query(
        `INSERT INTO products(sku,product_name,product_name_cn,brand,size,unit,cbm,
          net_weight,gross_weight,barcode,hs_code,factory_price,sanlyn_price,price_usd,
          tax_rate,rebate_rate,profit,cat1,cat2,cat3,cat1_cn,cat2_cn,cat3_cn,
          trade_terms,declaration_name,declaration_elements,bl_description,
          factory_name,declaration_amount,bg_bx,flavor,moq,jdy_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
        ON CONFLICT(sku) DO UPDATE SET
          product_name=EXCLUDED.product_name, product_name_cn=EXCLUDED.product_name_cn,
          brand=EXCLUDED.brand, size=EXCLUDED.size, unit=EXCLUDED.unit,
          cbm=EXCLUDED.cbm, net_weight=EXCLUDED.net_weight, gross_weight=EXCLUDED.gross_weight,
          barcode=EXCLUDED.barcode, hs_code=EXCLUDED.hs_code,
          factory_price=EXCLUDED.factory_price, sanlyn_price=EXCLUDED.sanlyn_price,
          price_usd=EXCLUDED.price_usd, tax_rate=EXCLUDED.tax_rate,
          rebate_rate=EXCLUDED.rebate_rate, profit=EXCLUDED.profit,
          cat1=EXCLUDED.cat1, cat2=EXCLUDED.cat2, cat3=EXCLUDED.cat3,
          cat1_cn=EXCLUDED.cat1_cn, cat2_cn=EXCLUDED.cat2_cn, cat3_cn=EXCLUDED.cat3_cn,
          trade_terms=EXCLUDED.trade_terms, declaration_name=EXCLUDED.declaration_name,
          declaration_elements=EXCLUDED.declaration_elements,
          bl_description=EXCLUDED.bl_description, factory_name=EXCLUDED.factory_name,
          declaration_amount=EXCLUDED.declaration_amount, bg_bx=EXCLUDED.bg_bx,
          flavor=EXCLUDED.flavor, moq=EXCLUDED.moq, jdy_id=EXCLUDED.jdy_id,
          updated_at=NOW()`,
        [p.sku,p.product_name||'',p.product_name_cn||'',p.brand||'',p.size||'',p.unit||'CTN',
         p.cbm||0,p.net_weight||0,p.gross_weight||0,p.barcode||'',p.hs_code||'',
         p.factory_price||null,p.sanlyn_price||null,p.price_usd||null,
         p.tax_rate||0,p.rebate_rate||0,p.profit||null,
         p.cat1||'',p.cat2||'',p.cat3||'',p.cat1_cn||'',p.cat2_cn||'',p.cat3_cn||'',
         p.trade_terms||'',p.declaration_name||'',p.declaration_elements||'',
         p.bl_description||'',p.factory_name||'',
         p.declaration_amount||null,p.bg_bx||null,p.flavor||'',p.moq||'',p.jdy_id||'']
      );
      ok++;if(ok%100===0)console.log('  进度: '+ok+'/'+products.length);
    }catch(e){fail++;if(fail<=3)console.log('❌ '+p.sku+': '+e.message);}
  }
  const r=await client.query('SELECT COUNT(*) FROM products');
  console.log('\n'+(fail===0?'✅':'⚠️')+' 完成! 成功:'+ok+' 失败:'+fail);
  console.log('📊 数据库总计: '+r.rows[0].count+' 条产品');
  await client.end();
}).catch(e=>console.error('连接失败:',e.message));
