require('dotenv').config();
const {Client}=require('pg');
const fs=require('fs');
const data=JSON.parse(fs.readFileSync('/Users/apple/Desktop/sanlyn-api-dev/companies_import.json'));
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});

// All JDY roles — exact match strings
const ROLE_MAP=[
  ['Buyer',           'Buyer'],
  ['Seller',          'Seller'],
  ['Manufacturer',    'Manufacturer'],
  ['Group',           'Group'],
  ['Carrier',         'Carrier'],
  ['Co-loader',       'Co-loader'],
  ['DDP Agent',       'DDP Agent'],
  ['Express',         'Express'],
  ['Trucking',        'Trucking'],
  ['Customs Broker',  'Customs Broker'],
  ['Warehouse',       'Warehouse'],
  ['Insurance',       'Insurance'],
  ['Overseas Agent',  'Overseas Agent'],
];

function parseRoles(raw){
  if(!raw) return [];
  const roles=new Set();
  for(const[keyword,role] of ROLE_MAP){
    if(raw.includes(keyword)) roles.add(role);
  }
  return Array.from(roles);
}

client.connect().then(async()=>{
  try{await client.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS role_types TEXT[] DEFAULT '{}'");}catch(e){}

  let updated=0;
  for(const p of data){
    const roles=parseRoles(p.roles_raw);
    if(roles.length){
      await client.query(
        "UPDATE customers SET role_types=$1, role_type=$2 WHERE company_code=$3",
        [roles, roles[0], p.company_code]
      );
      updated++;
    }
  }
  console.log(`✅ 更新 ${updated} 条，多角色示例:`);

  const r=await client.query(`
    SELECT company_code,name_cn,role_types 
    FROM customers WHERE array_length(role_types,1)>1 
    ORDER BY company_code LIMIT 10
  `);
  r.rows.forEach(row=>
    console.log(`  [${row.company_code}] ${(row.name_cn||'').slice(0,16).padEnd(16)} → ${row.role_types.join(' + ')}`)
  );

  // Role distribution
  const dist=await client.query(`
    SELECT unnest(role_types) as role, COUNT(*) cnt 
    FROM customers GROUP BY role ORDER BY cnt DESC
  `);
  console.log('\n角色分布:');
  dist.rows.forEach(r=>console.log(`  ${r.role.padEnd(18)}: ${r.cnt}`));
  await client.end();
}).catch(e=>console.error(e.message));
