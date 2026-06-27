#!/usr/bin/env node
// display_category fill script v2
import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';

const DB_BASE = `PGPASSWORD=Snlnb7f92c74d6fbaa8b97b0379b psql -U sanlyn_admin -d sanlyn_db`;

function psql(sql) {
  // write to temp file to avoid shell quoting issues
  const tmpFile = `/tmp/dc_query_${Date.now()}.sql`;
  fs.writeFileSync(tmpFile, sql);
  try {
    const result = execSync(`${DB_BASE} -t -A -f ${tmpFile}`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return result.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
}

// ---- Layer 1 Rules ----
const RULES = [
  // cat litter (must be before CAT fallback)
  { re: /TOFU.*LITTER|CAT.*LITTER|CAT\s+LITTER|BENTONITE|膨润土|猫砂/i, cat: 'litter' },
  // litter accessories - supplies
  { re: /LITTER\s+BOX|LITTER\s+MAT|LITTER\s+SCOOP|CAT\s+GRASS\s+PLANTER/i, cat: 'supplies' },
  // toys
  { re: /\bTOY\b|TEASER|PLUSH|毛绒|玩具|SPIN|ROUND\s*BALL/i, cat: 'toys' },
  // grooming
  { re: /PUPPY\s+PAD|(?<!\w)PAD(?!\w)|GROOM|纸巾|清洁|尿不湿|尿裤/i, cat: 'grooming' },
  // cat dry - explicit keywords
  { re: /(CAT|KITTEN|CATSOME).*(GF|GRAIN\s*FREE|KIBBLE|DRY\s*FOOD|COMPLETE\s*FOOD)/i, cat: 'cat-dry' },
  { re: /(GF|GRAIN\s*FREE).*(CAT|KITTEN)/i, cat: 'cat-dry' },
  // dog dry
  { re: /(DOG|PUPPY|DOGSOME).*(GF|GRAIN\s*FREE|KIBBLE|DRY\s*FOOD|COMPLETE\s*FOOD)/i, cat: 'dog-dry' },
  { re: /(GF|GRAIN\s*FREE).*(DOG|PUPPY)/i, cat: 'dog-dry' },
  // cat wet with explicit wet keywords + cat brand
  { re: /(CAT|KITTEN|CATSOME|SNIFFLY\s+CAT|SNIFFLY\s+KITTEN).*(JELLY|MOUSSE|POUCH|TRAY|CAN(NED)?|TREAT|CREAMY|STICK|MEATY|JERKY|LOAF|SOUP|GRAVY|STEW|PATE|LICKABLE|CREAM|BITES|RECIPE|DELIGHT|SARDINE|ANCHOVY|SALMON|TUNA|MACKEREL|CHICKEN|DUCK|BEEF|LAMB)/i, cat: 'cat-wet' },
  { re: /(JELLY|MOUSSE|POUCH|CAN(NED)?|GRAVY|STEW|PATE|LOAF).*(CAT|KITTEN)/i, cat: 'cat-wet' },
  // SNIFFLY CAT explicit
  { re: /SNIFFLY\s+(CAT|KITTEN|DELIGHT|KITTY)/i, cat: 'cat-wet' },
  // WANPY for cat
  { re: /WANPY.*(FOR\s+CAT|FOR\s+KITTEN|\bCAT\b|\bKITTEN\b)/i, cat: 'cat-wet' },
  // WANPY for dog
  { re: /WANPY.*(FOR\s+DOG|FOR\s+PUPPY|\bDOG\b|\bPUPPY\b)/i, cat: 'dog-wet' },
  // CREAMY TREAT - check for cat or dog
  { re: /CREAMY\s+TREAT.*(FOR\s+CAT|CAT|KITTEN)/i, cat: 'cat-wet' },
  { re: /CREAMY\s+TREAT.*(FOR\s+DOG|DOG)/i, cat: 'dog-wet' },
  // DIGESTIVE/HAIRBALL/KIDNEY etc creamy treats (likely cat)
  { re: /(DIGESTIVE|HAIRBALL|URINARY|KIDNEY|JOINT|SKIN)\s+(HEALTH\s+)?CREAMY\s+TREAT/i, cat: 'cat-wet' },
  // dog wet with explicit keywords
  { re: /(DOG|PUPPY|DOGSOME|SNIFFLY\s+DOG|SNIFFLY\s+GF\s+DOG).*(JELLY|POUCH|TRAY|CAN(NED)?|TREAT|JERKY|STICK|SAUSAGE|MEATY|BISCUIT|CHEW|LOAF|RAWHIDE)/i, cat: 'dog-wet' },
  { re: /(JELLY|POUCH|TRAY|CAN(NED)?).*(\bDOG\b|\bPUPPY\b)/i, cat: 'dog-wet' },
  // SNIFFLY DOG explicit
  { re: /SNIFFLY\s+(GF\s+)?DOG/i, cat: 'dog-wet' },
  // WANPY MEAT LOAF for dog
  { re: /WANPY\s+MEAT\s+LOAF.*FOR\s+DOG/i, cat: 'dog-wet' },
  // WANPY TOOTHBRUSH CHEW (dog)
  { re: /WANPY\s+TOOTHBRUSH\s+CHEW/i, cat: 'dog-wet' },
  // WANPY CHICKEN JERKY (dog treats)
  { re: /WANPY\s+CHICKEN\s+JERKY|WANPY\s+DUCK\s+JERKY|WANPY\s+LAMB\s+JERKY|WANPY\s+SWEET\s+POTATO/i, cat: 'dog-wet' },
  // WANPY STEW for cat
  { re: /WANPY\s+STEW.*(CAT|KITTEN)/i, cat: 'cat-wet' },
  // WANPY LICKABLE for cat
  { re: /WANPY\s+LICKABLE.*CAT/i, cat: 'cat-wet' },
  // WANPY SALMON FISH / SALMON STICKS (ambiguous - likely cat treat)
  { re: /WANPY\s+(SALMON|CREAMY)\s+(FISH|STICKS|TREAT)/i, cat: 'cat-wet' },
  // WANPY CREAMY TREAT generic - cat
  { re: /WANPY\s+CREAMY\s+TREAT/i, cat: 'cat-wet' },
  // WANPY SOFT ... STRIPS FOR CAT
  { re: /WANPY\s+SOFT.*FOR\s+CAT/i, cat: 'cat-wet' },
  // WANPY SOFT CHICKEN JERKY generic - dog
  { re: /WANPY\s+SOFT\s+CHICKEN\s+JERKY/i, cat: 'dog-wet' },
  // CATSOME fallback (brand=cat)
  { re: /\bCATSOME\b/i, cat: 'cat-wet' },
  // KITTEN fallback
  { re: /\bKITTEN\b/i, cat: 'cat-wet' },
  // DOGSOME fallback (brand=dog)
  { re: /\bDOGSOME\b/i, cat: 'dog-wet' },
  // supplies (bowls, feeders, carriers, cages, dispensers, etc.)
  { re: /BOWL|碗|\bBAG\b|CAGE|LEASH|HARNESS|窝|床|餐|FEEDER|DISPENSER|CARRIER|SCOOP|HAMSTER/i, cat: 'supplies' },
];

function applyKeywordRules(name) {
  for (const rule of RULES) {
    if (rule.re.test(name)) return rule.cat;
  }
  return null;
}

// ---- MiniMax API ----
function fetchMinimax(apiKey, names) {
  return new Promise((resolve, reject) => {
    const prompt = `你是宠物产品分类专家。9 类:
- cat-dry: 猫干粮
- cat-wet: 猫湿粮/罐头/零食/餐盒/猫用零食
- dog-dry: 狗干粮
- dog-wet: 狗湿粮/罐头/零食/烘焙肉条/狗用零食
- litter: 猫砂 (含豆腐砂、膨润土砂、矿砂)
- toys: 玩具
- supplies: 用品 (碗、包、窝、牵引、餐具、猫砂盆、饮水机、航空箱、仓鼠笼、自动喂食器等)
- grooming: 美容清洁 (纸巾、尿垫、护理工具)
- other: 其他 (含小动物如仓鼠、水族)

输入 ${names.length} 个产品名, 严格按顺序返回 JSON array, 每个元素是上述 9 个 key 之一:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

只返回 JSON array, 不要解释. 例: ["cat-dry","dog-wet",...]`;

    const body = JSON.stringify({
      model: 'abab6.5s-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0
    });

    const options = {
      hostname: 'api.minimax.chat',
      path: '/v1/text/chatcompletion_v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content || '';
          const match = content.match(/\[[\s\S]*\]/);
          if (!match) { console.log('  No JSON array in response:', content.slice(0, 200)); return resolve(null); }
          const arr = JSON.parse(match[0]);
          resolve(arr);
        } catch (e) {
          console.log('  Parse error:', e.message, data.slice(0, 200));
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

const VALID_CATS = new Set(['cat-dry', 'cat-wet', 'dog-dry', 'dog-wet', 'litter', 'toys', 'supplies', 'grooming', 'other']);

async function main() {
  console.log('=== Stage 0: Fetching data ===');

  // Get distinct order IDs + total product counts
  const orderListSQL = `
    SELECT o.id, o.order_no, jsonb_array_length(o.raw->'products') AS total_products
    FROM orders o
    WHERE o.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(o.raw->'products') t(it)
        WHERE (t.it->>'display_category') IS NULL
          AND (t.it->>'name') IS NOT NULL
          AND t.it->>'name' != ''
      )
    ORDER BY o.id;
  `;
  const orderLines = psql(orderListSQL).split('\n').filter(Boolean);
  console.log(`Orders with missing display_category: ${orderLines.length}`);

  const orders = orderLines.map(line => {
    const parts = line.split('|');
    return { id: parseInt(parts[0]), order_no: parts[1], total_products: parseInt(parts[2]) };
  });

  // Get all unique product names missing DC
  const uniqueNamesSQL = `
    SELECT DISTINCT t.it->>'name' AS name
    FROM orders o, jsonb_array_elements(o.raw->'products') WITH ORDINALITY t(it, ord)
    WHERE o.deleted_at IS NULL
      AND (t.it->>'display_category') IS NULL
      AND (t.it->>'name') IS NOT NULL
      AND t.it->>'name' != ''
    ORDER BY name;
  `;
  const uniqueNamesStr = psql(uniqueNamesSQL);
  const uniqueNames = uniqueNamesStr.split('\n').filter(Boolean);
  console.log(`Unique product names to classify: ${uniqueNames.length}`);

  // ---- Stage 1: Keyword rules ----
  console.log('\n=== Stage 1: Keyword Rules ===');
  const nameToCategory = {};
  const pendingAI = [];
  let keywordHits = 0;

  for (const name of uniqueNames) {
    const cat = applyKeywordRules(name);
    if (cat) {
      nameToCategory[name] = { cat, source: 'keyword' };
      keywordHits++;
    } else {
      pendingAI.push(name);
    }
  }

  console.log(`Keyword hits: ${keywordHits} (${Math.round(keywordHits/uniqueNames.length*100)}%)`);
  console.log(`Pending AI: ${pendingAI.length}`);
  if (pendingAI.length > 0) {
    console.log('Names pending AI:', pendingAI);
  }

  // ---- Stage 2: MiniMax ----
  console.log('\n=== Stage 2: MiniMax API ===');

  let minimaxKey = '';
  try {
    const envContent = fs.readFileSync('/opt/sanlyn-api-test/.env', 'utf8');
    const keyMatch = envContent.match(/MINIMAX_API_KEY\s*=\s*(.+)/);
    if (keyMatch) minimaxKey = keyMatch[1].trim().replace(/['"]/g, '');
    console.log(`MiniMax key found: ${minimaxKey ? 'YES (' + minimaxKey.slice(0,8) + '...)' : 'NO'}`);
  } catch (e) {
    console.log('Warning: Could not read env:', e.message);
  }

  let aiHits = 0;
  let aiInvalid = 0;
  let aiErrors = 0;
  const BATCH_SIZE = 10;

  if (pendingAI.length > 0 && minimaxKey) {
    console.log(`Calling MiniMax for ${pendingAI.length} names`);

    for (let i = 0; i < pendingAI.length; i += BATCH_SIZE) {
      const batch = pendingAI.slice(i, i + BATCH_SIZE);
      console.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(pendingAI.length/BATCH_SIZE)}: [${batch.join(', ').slice(0,80)}...]`);

      try {
        const result = await fetchMinimax(minimaxKey, batch);

        if (!result || !Array.isArray(result)) {
          console.log(`  Batch failed - null result`);
          aiErrors++;
          for (const name of batch) {
            nameToCategory[name] = { cat: 'other', source: 'ai_error' };
          }
          if (aiErrors >= 3) {
            console.log('Too many errors, marking remaining as other');
            for (const name of pendingAI.slice(i + BATCH_SIZE)) {
              nameToCategory[name] = { cat: 'other', source: 'ai_fallback' };
            }
            break;
          }
          continue;
        }

        for (let j = 0; j < batch.length; j++) {
          const name = batch[j];
          const cat = result[j];
          if (VALID_CATS.has(cat)) {
            nameToCategory[name] = { cat, source: 'minimax-abab6.5s' };
            aiHits++;
            console.log(`  "${name}" → ${cat}`);
          } else {
            console.log(`  Invalid cat "${cat}" for "${name}"`);
            nameToCategory[name] = { cat: 'other', source: 'ai_invalid' };
            aiInvalid++;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.log(`  Batch error:`, e.message);
        aiErrors++;
        for (const name of batch) {
          nameToCategory[name] = { cat: 'other', source: 'ai_error' };
        }
        if (aiErrors >= 3) {
          for (const name of pendingAI.slice(i + BATCH_SIZE)) {
            nameToCategory[name] = { cat: 'other', source: 'ai_fallback' };
          }
          break;
        }
      }
    }
  } else if (pendingAI.length > 0) {
    console.log('No MiniMax key - marking pending as other');
    for (const name of pendingAI) {
      nameToCategory[name] = { cat: 'other', source: 'no_api_key' };
    }
  }

  console.log(`AI hits: ${aiHits}, AI invalid: ${aiInvalid}, AI errors: ${aiErrors}`);

  // ---- Stage 3: Write back ----
  console.log('\n=== Stage 3: Write back to DB ===');

  // Build VALUES table for SQL
  const mappingEntries = Object.entries(nameToCategory)
    .map(([name, { cat, source }]) => {
      const safeName = name.replace(/'/g, "''");
      return `('${safeName}', '${cat}', '${source}')`;
    })
    .join(',\n    ');

  let ordersUpdated = 0;
  let updateErrors = [];

  for (const order of orders) {
    const orderId = order.id;

    // BEFORE count
    const beforeStr = psql(`SELECT jsonb_array_length(raw->'products') FROM orders WHERE id = ${orderId} AND deleted_at IS NULL`);
    const beforeCount = parseInt(beforeStr);
    if (isNaN(beforeCount)) {
      console.log(`Order ${orderId}: before count error, skipping`);
      updateErrors.push({ orderId, error: 'before_count_nan' });
      continue;
    }

    const updateSQL = `
      UPDATE orders
      SET
        raw = jsonb_set(
          raw,
          '{products}',
          (
            SELECT jsonb_agg(
              CASE
                WHEN (it->>'display_category') IS NOT NULL
                  THEN it
                WHEN nd.dc IS NOT NULL
                  THEN it || jsonb_build_object('display_category', nd.dc, '_dc_source', nd.src || '_2026_05_19')
                ELSE it
              END
              ORDER BY ord
            )
            FROM jsonb_array_elements(raw->'products') WITH ORDINALITY t(it, ord)
            LEFT JOIN (VALUES
              ${mappingEntries}
            ) AS nd(name, dc, src) ON nd.name = it->>'name'
          )
        ),
        updated_at = NOW()
      WHERE id = ${orderId}
        AND deleted_at IS NULL;
    `;

    try {
      psql(updateSQL);

      // AFTER count
      const afterStr = psql(`SELECT jsonb_array_length(raw->'products') FROM orders WHERE id = ${orderId} AND deleted_at IS NULL`);
      const afterCount = parseInt(afterStr);

      if (afterCount !== beforeCount) {
        console.log(`ERROR: Order ${orderId} count changed! ${beforeCount} -> ${afterCount}`);
        updateErrors.push({ orderId, beforeCount, afterCount, error: 'count_mismatch' });
      } else {
        ordersUpdated++;
        if (ordersUpdated % 10 === 0) console.log(`  Updated ${ordersUpdated}/${orders.length}...`);
      }
    } catch (e) {
      console.log(`Error updating order ${orderId}:`, e.message.slice(0, 200));
      updateErrors.push({ orderId, error: e.message.slice(0, 100) });
    }
  }

  console.log(`\nOrders updated: ${ordersUpdated}/${orders.length}`);
  if (updateErrors.length > 0) {
    console.log('Errors:', JSON.stringify(updateErrors, null, 2));
  }

  // ---- Stage 4: Validation ----
  console.log('\n=== Stage 4: Validation ===');

  const validationSQL = `
    SELECT
      COUNT(*) FILTER (WHERE (raw->'products'->0->>'display_category') IS NOT NULL) AS has_dc,
      COUNT(*) AS total
    FROM orders
    WHERE deleted_at IS NULL
      AND jsonb_array_length(COALESCE(raw->'products','[]'::jsonb)) > 0;
  `;
  const validationResult = psql(validationSQL);
  console.log('Has DC / Total:', validationResult);

  const catCountSQL = `
    SELECT t.it->>'display_category' AS dc, COUNT(*) AS cnt
    FROM orders o, jsonb_array_elements(o.raw->'products') t(it)
    WHERE o.deleted_at IS NULL AND (t.it->>'display_category') IS NOT NULL
    GROUP BY dc ORDER BY cnt DESC;
  `;
  const catCountResult = psql(catCountSQL);
  console.log('Category distribution:\n' + catCountResult);

  const stillMissingSQL = `
    SELECT DISTINCT t.it->>'name' AS name
    FROM orders o, jsonb_array_elements(o.raw->'products') t(it)
    WHERE o.deleted_at IS NULL
      AND (t.it->>'display_category') IS NULL
      AND (t.it->>'name') IS NOT NULL
      AND t.it->>'name' != ''
    ORDER BY name LIMIT 25;
  `;
  const stillMissing = psql(stillMissingSQL);
  console.log('Still missing:\n' + (stillMissing || 'NONE'));

  // ---- Report ----
  const estimatedCost = (aiHits * 0.001).toFixed(3);
  const report = `# display_category Fill Report — 2026-05-19

## Summary
- Orders processed: ${orders.length}
- Orders updated successfully: ${ordersUpdated}
- Update errors: ${updateErrors.length}

## Classification
| Metric | Count | % |
|--------|-------|---|
| Total unique names | ${uniqueNames.length} | 100% |
| Layer 1 keyword hits | ${keywordHits} | ${Math.round(keywordHits/uniqueNames.length*100)}% |
| MiniMax AI hits | ${aiHits} | ${Math.round(aiHits/uniqueNames.length*100)}% |
| AI invalid/error | ${aiInvalid + aiErrors} | ${Math.round((aiInvalid+aiErrors)/uniqueNames.length*100)}% |

## Cost
- MiniMax calls: ${aiHits + aiInvalid} names × ~$0.001 = ~$${estimatedCost} USD (~¥${(parseFloat(estimatedCost) * 7.2).toFixed(2)} CNY)

## DB Validation (has_dc | total)
\`\`\`
${validationResult}
\`\`\`

## Category Distribution (dc | count)
\`\`\`
${catCountResult}
\`\`\`

## Still Missing After Update
\`\`\`
${stillMissing || 'NONE - All classified!'}
\`\`\`

## Ambiguous / AI-classified Names
${pendingAI.map(n => `- [${nameToCategory[n]?.source || 'pending'}] ${n} → ${nameToCategory[n]?.cat || '?'}`).join('\n') || 'None'}

## Update Errors
${updateErrors.length === 0 ? 'None' : JSON.stringify(updateErrors, null, 2)}
`;

  fs.writeFileSync('/tmp/display-category-77-report.md', report);
  console.log('\nReport written to /tmp/display-category-77-report.md');
  console.log('\n=== COMPLETE ===');
  console.log(`Summary: ${keywordHits} keyword + ${aiHits} AI = ${keywordHits + aiHits} total names classified`);
  console.log(`Orders updated: ${ordersUpdated}/${orders.length}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
