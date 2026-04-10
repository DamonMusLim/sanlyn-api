const {Client}=require('pg');
const client=new Client({
  host:'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:'sanlyn_db',
  user:'sanlyn_admin',password:'SanlynRDS2026!',ssl:false
});
client.connect().then(async()=>{
  // 1. Add columns
  const cols=[
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS tax_no VARCHAR(64) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS bank_name VARCHAR(128) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS bank_account VARCHAR(64) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS contact_tel VARCHAR(32) DEFAULT ''",
    "ALTER TABLE factories ADD COLUMN IF NOT EXISTS contact_email VARCHAR(128) DEFAULT ''",
  ];
  for(const sql of cols) try{await client.query(sql);}catch(e){}
  console.log('✅ 字段已就绪\n');

  // 2. Pull all customers with roleType=Manufacturer and sync to factories
  const custs=await client.query(
    "SELECT name, raw FROM customers WHERE raw->>'roleType' LIKE '%Manufacturer%' OR raw->'supTypes' @> '[\"Manufacturer（工厂）\"]'"
  );
  console.log('找到工厂类客户:', custs.rows.length, '条');

  for(const c of custs.rows){
    const raw=typeof c.raw==='string'?JSON.parse(c.raw):c.raw;
    const inv=raw.invoice||{};
    const name=inv.nameCN||c.name;
    const taxNo=inv.taxNo||'';
    const address=inv.addressCN||inv.addressEN||'';
    const bankName=inv.bankCNY?.bankNameCN||inv.bankCNY?.bankNameEN||'';
    const bankAccount=inv.bankCNY?.account||'';

    // Upsert into factories by name match
    const existing=await client.query("SELECT id FROM factories WHERE name=$1 OR name LIKE $2",[name,'%'+name.slice(0,6)+'%']);
    if(existing.rows.length){
      await client.query(
        "UPDATE factories SET tax_no=$1, address=$2, bank_name=$3, bank_account=$4 WHERE id=$5",
        [taxNo, address, bankName, bankAccount, existing.rows[0].id]
      );
      console.log(`✅ 更新: ${name}`);
      console.log(`   税号: ${taxNo} | 地址: ${address||'(空)'} | 银行: ${bankName} | 账号: ${bankAccount}`);
    } else {
      // Insert new factory
      await client.query(
        "INSERT INTO factories(name, tax_no, address, bank_name, bank_account, po_prefix, is_active) VALUES($1,$2,$3,$4,$5,'',true)",
        [name, taxNo, address, bankName, bankAccount]
      );
      console.log(`✅ 新增工厂: ${name}`);
    }
  }

  // 3. Show final state
  console.log('\n📋 factories表最终状态:');
  const final=await client.query("SELECT id,name,tax_no,bank_name,bank_account,address FROM factories ORDER BY id");
  final.rows.forEach(f=>{
    console.log(`\n  [${f.id}] ${f.name}`);
    console.log(`   税号: ${f.tax_no||'(空)'}`);
    console.log(`   银行: ${f.bank_name||'(空)'} | 账号: ${f.bank_account||'(空)'}`);
    console.log(`   地址: ${f.address||'(空)'}`);
  });
  await client.end();
}).catch(e=>console.error(e.message));
