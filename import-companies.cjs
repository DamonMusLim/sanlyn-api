const {Client}=require('pg');
const fs=require('fs');
const data=JSON.parse(fs.readFileSync('/Users/apple/Desktop/sanlyn-api-dev/companies_import.json'));
const client=new Client({
  host:'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:'sanlyn_db',
  user:'sanlyn_admin',password:'SanlynRDS2026!',ssl:false
});
client.connect().then(async()=>{
  // Add missing columns to customers table
  const cols=[
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_cn TEXT DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_en TEXT DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_no VARCHAR(64) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(128) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(64) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS role_type VARCHAR(32) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_code VARCHAR(32) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS client_code VARCHAR(32) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS related_port VARCHAR(128) DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS jdy_id VARCHAR(64) DEFAULT ''",
  ];
  for(const sql of cols) try{await client.query(sql);}catch(e){}
  console.log('✅ 字段就绪\n');

  let ok=0,skip=0,fail=0;
  for(const p of data){
    try{
      const name=p.name_cn||p.name_en||p.company_code;
      await client.query(`
        INSERT INTO customers(company_code,name,name_cn,name_en,address_cn,address_en,
          tax_no,short_code,contact_name,contact_phone,contact_email,country,
          bank_name,bank_account,role_type,group_code,client_code,related_port,jdy_id,is_active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true)
        ON CONFLICT(company_code) DO UPDATE SET
          name=COALESCE(NULLIF(EXCLUDED.name,''),customers.name),
          name_cn=COALESCE(NULLIF(EXCLUDED.name_cn,''),customers.name_cn),
          name_en=COALESCE(NULLIF(EXCLUDED.name_en,''),customers.name_en),
          address_cn=COALESCE(NULLIF(EXCLUDED.address_cn,''),customers.address_cn),
          address_en=COALESCE(NULLIF(EXCLUDED.address_en,''),customers.address_en),
          tax_no=COALESCE(NULLIF(EXCLUDED.tax_no,''),customers.tax_no),
          short_code=COALESCE(NULLIF(EXCLUDED.short_code,''),customers.short_code),
          contact_name=COALESCE(NULLIF(EXCLUDED.contact_name,''),customers.contact_name),
          contact_phone=COALESCE(NULLIF(EXCLUDED.contact_phone,''),customers.contact_phone),
          contact_email=COALESCE(NULLIF(EXCLUDED.contact_email,''),customers.contact_email),
          bank_name=COALESCE(NULLIF(EXCLUDED.bank_name,''),customers.bank_name),
          bank_account=COALESCE(NULLIF(EXCLUDED.bank_account,''),customers.bank_account),
          role_type=COALESCE(NULLIF(EXCLUDED.role_type,''),customers.role_type),
          group_code=COALESCE(NULLIF(EXCLUDED.group_code,''),customers.group_code),
          client_code=COALESCE(NULLIF(EXCLUDED.client_code,''),customers.client_code),
          related_port=COALESCE(NULLIF(EXCLUDED.related_port,''),customers.related_port),
          jdy_id=COALESCE(NULLIF(EXCLUDED.jdy_id,''),customers.jdy_id),
          updated_at=NOW()`,
        [p.company_code,name,p.name_cn,p.name_en,p.address_cn,p.address_en,
         p.tax_no,p.short_name,p.contact_name,p.contact_tel,p.contact_email,
         p.country,p.bank_name,p.bank_account,p.role_type,p.group_code,
         p.client_code,p.related_port,p.jdy_id]
      );
      ok++;
    }catch(e){fail++;console.log('❌',p.company_code,e.message);}
  }
  const r=await client.query("SELECT role_type,COUNT(*) cnt FROM customers WHERE role_type!='' GROUP BY role_type ORDER BY cnt DESC");
  console.log(`✅ 导入完成: 成功${ok} 失败${fail}\n`);
  console.log('客户表角色分布:');
  r.rows.forEach(row=>console.log(`  ${row.role_type}: ${row.cnt}`));
  const total=await client.query("SELECT COUNT(*) FROM customers");
  console.log('\n总计:',total.rows[0].count,'家公司');
  await client.end();
}).catch(e=>console.error(e.message));
