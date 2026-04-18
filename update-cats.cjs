require('dotenv').config();
const {Client}=require('pg');
const client=new Client({
  host:process.env.PG_HOST||'pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com',
  port:5432,database:process.env.PG_DB||'sanlyn_db',
  user:process.env.PG_USER||'sanlyn_admin',password:process.env.PG_PASSWORD,ssl:false
});

// ── 1. Bulk category remapping (old cat1/cat2/cat3 → new English) ──
const CAT_MAP=[
  // Pet Supplies
  ['宠物用品','猫砂','豆腐猫砂',          'Pet Supplies','Cat Litter','Tofu Cat Litter'],
  ['宠物用品','猫砂','膨润土猫砂',         'Pet Supplies','Cat Litter','Bentonite Cat Litter'],
  ['宠物用品','宠物餐具','喂水器',          'Pet Supplies','Feeding Accessories','Water Dispensers'],
  ['宠物用品','宠物餐具','喂食器',          'Pet Supplies','Feeding Accessories','Food Bowls'],
  ['宠物用品','宠物出行','航空箱',          'Pet Supplies','Pet Travel','Pet Carriers'],
  ['宠物用品','猫狗清洁/厕所用品','尿垫',  'Pet Supplies','Hygiene & Cleaning','Pee Pads'],
  ['宠物用品','小宠用品','仓鼠用品',        'Pet Supplies','Small Pets','Hamster Supplies'],
  // Pet Food
  ['宠物食品','猫粮','干粮',               'Pet Food','Cat Food','Dry Food'],
  ['宠物食品','猫粮','湿粮/罐头',          'Pet Food','Cat Food','Wet Food / Canned'],
  ['宠物食品','犬粮','烘焙粮',             'Pet Food','Dog Food','Baked Food'],
  ['宠物食品','犬粮','烘干狗粮',           'Pet Food','Dog Food','Dehydrated Food'],
  ['宠物食品','猫犬零食','猫条',           'Pet Food','Cat & Dog Treats','Cat Treats'],
  ['宠物食品','猫犬零食','罐头',           'Pet Food','Cat & Dog Treats','Mixed Treats'],
  ['宠物食品','猫犬零食','鲜封包',         'Pet Food','Cat & Dog Treats','Pouches'],
  ['宠物食品','犬零食','湿粮/罐头',        'Pet Food','Dog Treats','Wet Food / Canned'],
  ['宠物食品','犬零食','湿粮/餐盒',        'Pet Food','Dog Treats','Wet Food / Tray'],
  // Household
  ['生活用品','纸巾','待分类',             'Household Supplies','Paper Products','Tissues'],
];

// ── 2. SKU-based rules for 其他宠物用品 ──
function classifyOther(name){
  const n=(name||'').toLowerCase();
  if(/jerkytime/.test(n))                        return ['Pet Food','Cat & Dog Treats','Jerky Treats'];
  if(/cat teaser|teaser|catnip/.test(n))         return ['Pet Supplies','Cat Toys','Cat Teasers'];
  if(/spin.*cat|cat.*spin|interactive.*cat/.test(n)) return ['Pet Supplies','Cat Toys','Interactive Toys'];
  if(/cat toy|toy.*cat/.test(n))                 return ['Pet Supplies','Cat Toys','Cat Toys'];
  if(/cat tree/.test(n))                         return ['Pet Supplies','Cat Furniture','Cat Trees'];
  if(/nest/.test(n))                             return ['Pet Supplies','Cat Furniture','Cat Beds'];
  if(/dog toy|savage|tug|snuffle/.test(n))       return ['Pet Supplies','Dog Toys','Plush Toys'];
  if(/coto/.test(n))                             return ['Pet Supplies','Dog Toys','Chew Toys'];
  if(/training tray/.test(n))                    return ['Pet Supplies','Dog Supplies','Training Pads'];
  if(/eye care|nose balm|flea|tick|tear stain/.test(n)) return ['Pet Supplies','Pet Care','Health & Grooming'];
  if(/food container|stoko/.test(n))             return ['Pet Supplies','Feeding Accessories','Food Storage'];
  if(/merchandising|display/.test(n))            return ['Pet Supplies','Other','Display'];
  if(/toy/.test(n))                              return ['Pet Supplies','Cat Toys','Cat Toys'];
  return ['Pet Supplies','Other','Uncategorized'];
}

client.connect().then(async()=>{
  console.log('🔌 已连接，开始更新分类...\n');
  let total=0;

  // Step 1: bulk category remap
  for(const[oc1,oc2,oc3,nc1,nc2,nc3]of CAT_MAP){
    const r=await client.query(
      "UPDATE products SET cat1=$1,cat2=$2,cat3=$3,cat1_cn=$1,cat2_cn=$2,cat3_cn=$3,updated_at=NOW() WHERE cat1=$4 AND cat2=$5 AND cat3=$6",
      [nc1,nc2,nc3,oc1,oc2,oc3]
    );
    if(r.rowCount>0){console.log(`✅ ${oc2}>${oc3} → ${nc2}>${nc3}  (${r.rowCount}条)`);total+=r.rowCount;}
  }

  // Step 2: classify 其他宠物用品 by product name
  console.log('\n📦 按品名分类 其他宠物用品...');
  const others=await client.query(
    "SELECT id,sku,product_name,product_name_cn FROM products WHERE cat2='其他宠物用品'"
  );
  let otherFixed=0;
  for(const p of others.rows){
    const[nc1,nc2,nc3]=classifyOther(p.product_name||p.product_name_cn);
    await client.query(
      "UPDATE products SET cat1=$1,cat2=$2,cat3=$3,cat1_cn=$1,cat2_cn=$2,cat3_cn=$3,updated_at=NOW() WHERE id=$4",
      [nc1,nc2,nc3,p.id]
    );
    otherFixed++;
  }
  console.log(`✅ 重新分类 ${otherFixed} 条 其他宠物用品`);
  total+=otherFixed;

  // Step 3: rename any leftover Chinese cat1
  const renames=[
    ['宠物用品','Pet Supplies'],['宠物食品','Pet Food'],['生活用品','Household Supplies']
  ];
  for(const[old,nw]of renames){
    const r=await client.query(
      "UPDATE products SET cat1=$1,cat1_cn=$1 WHERE cat1=$2",
      [nw,old]
    );
    if(r.rowCount>0){console.log(`✅ ${old} → ${nw}  (${r.rowCount}条)`);total+=r.rowCount;}
  }

  console.log('\n📊 共更新: '+total+' 条');

  // Final summary
  const v=await client.query(
    "SELECT cat1,cat2,cat3,COUNT(*) cnt FROM products WHERE cat1!='' GROUP BY cat1,cat2,cat3 ORDER BY cat1,cat2,cat3"
  );
  console.log('\n最终分类结构:');
  let prev='';
  v.rows.forEach(r=>{
    if(r.cat1!==prev){console.log('\n  📁 '+r.cat1);prev=r.cat1;}
    console.log(`      [${r.cat2}] > [${r.cat3}]  (${r.cnt}条)`);
  });
  await client.end();
}).catch(e=>console.error('连接失败:',e.message));
