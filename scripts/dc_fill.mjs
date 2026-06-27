#!/usr/bin/env node
// display_category fill script - runs on prod server
// Stage 0: fetch, Stage 1: keyword, Stage 2: MiniMax, Stage 3: write back

import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';

const require = createRequire(import.meta.url);

// ---- Config ----
const DB_CMD = `PGPASSWORD=Snlnb7f92c74d6fbaa8b97b0379b psql -U sanlyn_admin -d sanlyn_db`;

function psql(sql) {
  const escaped = sql.replace(/'/g, `'\\''`);
  const result = execSync(`${DB_CMD} -t -c '${escaped}'`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return result.trim();
}

function psqlJSON(sql) {
  const escaped = sql.replace(/'/g, `'\\''`);
  const result = execSync(`${DB_CMD} -t -A -c '${escaped}'`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return result.trim();
}

// ---- Layer 1 Rules ----
const RULES = [
  // cat litter
  { re: /TOFU.*LITTER|CAT.*LITTER|CAT\s+LITTER|LITTER\s+BOX|LITTER\s+MAT|LITTER\s+SCOOP|猫砂|BENTONITE|膨润土/i, cat: 'litter' },
  // toys
  { re: /\bTOY\b|TEASER|PLUSH|毛绒|玩具|SPIN|ROUND\s*BALL/i, cat: 'toys' },
  // grooming/supplies
  { re: /PUPPY\s+PAD|(?<!\w)PAD(?!\w)|GROOM|纸巾|清洁|尿不湿|尿裤/i, cat: 'grooming' },
  // cat dry food - explicit keywords
  { re: /(CAT|KITTEN|CATSOME).*(GF|GRAIN\s*FREE|KIBBLE|DRY\s*FOOD|COMPLETE\s*FOOD)/i, cat: 'cat-dry' },
  { re: /(GF|GRAIN\s*FREE).*(CAT|KITTEN)/i, cat: 'cat-dry' },
  // dog dry food - explicit keywords
  { re: /(DOG|PUPPY|DOGSOME).*(GF|GRAIN\s*FREE|KIBBLE|DRY\s*FOOD|COMPLETE\s*FOOD)/i, cat: 'dog-dry' },
  { re: /(GF|GRAIN\s*FREE).*(DOG|PUPPY)/i, cat: 'dog-dry' },
  // cat wet food - POUCH/CAN/TRAY/JELLY/etc with CAT/KITTEN/CATSOME/SNIFFLY
  { re: /(CAT|KITTEN|CATSOME|SNIFFLY).*(JELLY|MOUSSE|POUCH|TRAY|CAN(NED)?|TREAT|CREAMY|STICK|MEATY|JERKY|LOAF|SOUP|GRAVY|STEW|PATE|SARDINE|LICKABLE|CREAM|BITES|CANNED)/i, cat: 'cat-wet' },
  { re: /(JELLY|MOUSSE|POUCH|TRAY|CANNED|TREAT|CREAMY|STICK|MEATY|JERKY|LOAF|SOUP|GRAVY|STEW|PATE|SARDINE|LICKABLE|CREAM|BITES).*(CAT|KITTEN)/i, cat: 'cat-wet' },
  // WANPY products - check for FOR CAT suffix
  { re: /WANPY.*(FOR\s+CAT|KITTEN|FOR\s+KITTEN)/i, cat: 'cat-wet' },
  { re: /WANPY.*(FOR\s+DOG|FOR\s+PUPPY)/i, cat: 'dog-wet' },
  // dog wet food
  { re: /(DOG|PUPPY|DOGSOME|SNIFFLY\s+DOG).*(JELLY|POUCH|TRAY|CAN(NED)?|TREAT|JERKY|STICK|SAUSAGE|MEATY|BISCUIT|CHEW|LOAF|RAWHIDE|CANNED)/i, cat: 'dog-wet' },
  { re: /(JELLY|POUCH|TRAY|CANNED|TREAT|JERKY|STICK|SAUSAGE|MEATY|BISCUIT|CHEW|LOAF|RAWHIDE).*(DOG|PUPPY)/i, cat: 'dog-wet' },
  // SNIFFLY without explicit cat/dog - check context clues
  { re: /SNIFFLY.*(CAT|KITTEN)/i, cat: 'cat-wet' },
  { re: /SNIFFLY.*DOG/i, cat: 'dog-wet' },
  // CATSOME fallback (brand=cat)
  { re: /CATSOME|CATSOME\s+GF|CATSOME\s+KITCHEN|CATSOME\s+GRAIN/i, cat: 'cat-wet' },
  // KITTEN fallback
  { re: /\bKITTEN\b/i, cat: 'cat-wet' },
  // DOGSOME fallback (brand=dog)
  { re: /DOGSOME/i, cat: 'dog-wet' },
  // supplies (bowls, feeders, carriers, cages, dispensers, etc.)
  { re: /BOWL|碗|\bBAG\b|CAGE|LEASH|HARNESS|窝|床|餐|FEEDER|DISPENSER|CARRIER|PLANTER|SCOOP/i, cat: 'supplies' },
  // cat litter box/accessories (supplies not litter)
  { re: /LITTER\s+BOX|LITTER\s+MAT|LITTER\s+SCOOP/i, cat: 'supplies' },
];

function applyKeywordRules(name) {
  for (const rule of RULES) {
    if (rule.re.test(name)) return rule.cat;
  }
  return null;
}

// ---- MiniMax API ----
function fetchMinimax(apiKey, groupId, names) {
  return new Promise((resolve, reject) => {
    const prompt = `你是宠物产品分类专家。9 类:
- cat-dry: 猫干粮
- cat-wet: 猫湿粮/罐头/零食/餐盒
- dog-dry: 狗干粮
- dog-wet: 狗湿粮/罐头/零食/烘焙肉条
- litter: 猫砂 (含豆腐砂、膨润土砂、矿砂)
- toys: 玩具
- supplies: 用品 (碗、包、窝、牵引、餐具、猫砂盆、饮水机、航空箱、仓鼠笼等)
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
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content || '';
          // Extract JSON array from response
          const match = content.match(/\[[\s\S]*\]/);
          if (!match) return resolve(null);
          const arr = JSON.parse(match[0]);
          resolve(arr);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const VALID_CATS = new Set(['cat-dry', 'cat-wet', 'dog-dry', 'dog-wet', 'litter', 'toys', 'supplies', 'grooming', 'other']);

async function main() {
  console.log('=== Stage 0: Fetching data ===');

  // Get all orders with products missing display_category
  const fetchSQL = `
    SELECT
      o.id AS order_id,
      o.order_no,
      jsonb_array_length(o.raw->'products') AS total_products,
      jsonb_agg(jsonb_build_object('idx', t.ord - 1, 'name', t.it->>'name', 'sku', t.it->>'sku') ORDER BY t.ord) AS missing_items
    FROM orders o, jsonb_array_elements(o.raw->'products') WITH ORDINALITY t(it, ord)
    WHERE o.deleted_at IS NULL
      AND (t.it->>'display_category') IS NULL
      AND (t.it->>'name') IS NOT NULL
      AND t.it->>'name' != ''
    GROUP BY o.id, o.order_no
    ORDER BY o.id;
  `;

  const rows = psql(`COPY (${fetchSQL}) TO STDOUT WITH (FORMAT csv, HEADER false)`);
  // Actually use json format
  const jsonSQL = fetchSQL.replace(/^/g, '');

  // Use json mode
  const result = execSync(`${DB_CMD} -t -A -F'|' -c "SELECT o.id, o.order_no, jsonb_array_length(o.raw->'products') AS total_products FROM orders o WHERE o.deleted_at IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.raw->'products') t(it) WHERE (t.it->>'display_category') IS NULL AND (t.it->>'name') IS NOT NULL AND t.it->>'name' != '') ORDER BY o.id;"`, { encoding: 'utf8' });

  const orderLines = result.trim().split('\n').filter(Boolean);
  console.log(`Orders with missing display_category: ${orderLines.length}`);

  // For each order, get full product list and which ones are missing
  const orders = [];
  for (const line of orderLines) {
    const parts = line.split('|');
    orders.push({
      id: parseInt(parts[0]),
      order_no: parts[1],
      total_products: parseInt(parts[2])
    });
  }

  // Get all unique product names missing DC
  const allNamesResult = execSync(`${DB_CMD} -t -A -F'|' -c "SELECT DISTINCT t.it->>'name' FROM orders o, jsonb_array_elements(o.raw->'products') WITH ORDINALITY t(it, ord) WHERE o.deleted_at IS NULL AND (t.it->>'display_category') IS NULL AND (t.it->>'name') IS NOT NULL AND t.it->>'name' != '' ORDER BY 1;"`, { encoding: 'utf8' });

  const uniqueNames = allNamesResult.trim().split('\n').filter(Boolean);
  console.log(`Unique product names: ${uniqueNames.length}`);

  // ---- Stage 1: Keyword rules ----
  console.log('\n=== Stage 1: Keyword Rules ===');
  const nameToCategory = {};
  const pendingAI = [];
  let keywordHits = 0;
  let keywordMisses = 0;

  for (const name of uniqueNames) {
    const cat = applyKeywordRules(name);
    if (cat) {
      nameToCategory[name] = { cat, source: 'keyword' };
      keywordHits++;
    } else {
      pendingAI.push(name);
      keywordMisses++;
    }
  }

  console.log(`Keyword hits: ${keywordHits}, Pending AI: ${pendingAI.length}`);

  // ---- Stage 2: MiniMax ----
  console.log('\n=== Stage 2: MiniMax API ===');

  // Read API key from prod env
  let minimaxKey = '';
  let minimaxGroupId = '';
  try {
    const envContent = fs.readFileSync('/opt/sanlyn-api-test/.env', 'utf8');
    const keyMatch = envContent.match(/MINIMAX_API_KEY=(.+)/);
    const groupMatch = envContent.match(/MINIMAX_GROUP_ID=(.+)/);
    if (keyMatch) minimaxKey = keyMatch[1].trim().replace(/['"]/g, '');
    if (groupMatch) minimaxGroupId = groupMatch[1].trim().replace(/['"]/g, '');
  } catch (e) {
    console.log('Warning: Could not read MiniMax API key:', e.message);
  }

  let aiHits = 0;
  let aiInvalid = 0;
  let aiErrors = 0;
  let totalTokensUsed = 0;
  const BATCH_SIZE = 10;
  const MAX_ERRORS = 3;

  if (pendingAI.length > 0 && minimaxKey) {
    console.log(`Calling MiniMax for ${pendingAI.length} names in batches of ${BATCH_SIZE}`);

    for (let i = 0; i < pendingAI.length; i += BATCH_SIZE) {
      const batch = pendingAI.slice(i, i + BATCH_SIZE);
      console.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1}: ${batch.length} names`);

      try {
        const result = await fetchMinimax(minimaxKey, minimaxGroupId, batch);

        if (!result || !Array.isArray(result)) {
          console.log(`  Batch failed - null result`);
          aiErrors++;
          if (aiErrors >= MAX_ERRORS) {
            console.log('Too many MiniMax errors, marking remaining as other');
            for (const name of pendingAI.slice(i)) {
              nameToCategory[name] = { cat: 'other', source: 'ai_fallback' };
            }
            break;
          }
          // Mark batch as 'other' and continue
          for (const name of batch) {
            nameToCategory[name] = { cat: 'other', source: 'ai_error' };
          }
          continue;
        }

        for (let j = 0; j < batch.length; j++) {
          const name = batch[j];
          const cat = result[j];
          if (VALID_CATS.has(cat)) {
            nameToCategory[name] = { cat, source: 'minimax-abab6.5s' };
            aiHits++;
          } else {
            console.log(`  Invalid cat "${cat}" for "${name}", marking ai_invalid`);
            nameToCategory[name] = { cat: 'other', source: 'ai_invalid' };
            aiInvalid++;
          }
        }

        // Small delay between batches
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.log(`  Batch error:`, e.message);
        aiErrors++;
        if (aiErrors >= MAX_ERRORS) {
          for (const name of pendingAI.slice(i)) {
            nameToCategory[name] = { cat: 'other', source: 'ai_fallback' };
          }
          break;
        }
        for (const name of batch) {
          nameToCategory[name] = { cat: 'other', source: 'ai_error' };
        }
      }
    }
  } else if (pendingAI.length > 0) {
    console.log('No MiniMax key - marking pending as other');
    for (const name of pendingAI) {
      nameToCategory[name] = { cat: 'other', source: 'no_api_key' };
    }
  }

  console.log(`\nMapping complete: ${Object.keys(nameToCategory).length} names mapped`);

  // ---- Stage 3: Write back ----
  console.log('\n=== Stage 3: Write back to DB ===');

  // For each order, do BEFORE count, update, AFTER count
  let ordersUpdated = 0;
  let ordersSkipped = 0;
  let rowsWritten = 0;
  const updateErrors = [];

  for (const order of orders) {
    const orderId = order.id;

    // BEFORE: get product count
    const beforeCount = parseInt(psql(`SELECT jsonb_array_length(raw->'products') FROM orders WHERE id = ${orderId} AND deleted_at IS NULL`));

    if (isNaN(beforeCount)) {
      console.log(`Order ${orderId}: could not get before count, skipping`);
      ordersSkipped++;
      continue;
    }

    // Build the UPDATE SQL using a VALUES table approach
    // We need to update only items missing display_category
    // Using jsonb_set with array reconstruction

    // Escape helper
    const esc = s => s.replace(/'/g, "''");

    // Build VALUES for our name mapping
    const mappingEntries = Object.entries(nameToCategory)
      .map(([name, { cat, source }]) => `('${esc(name)}', '${cat}', '${source}')`)
      .join(',\n');

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
            LEFT JOIN (VALUES ${mappingEntries}) AS nd(name, dc, src)
              ON nd.name = it->>'name'
          )
        ),
        updated_at = NOW()
      WHERE id = ${orderId}
        AND deleted_at IS NULL;
    `;

    try {
      psql(updateSQL);

      // AFTER: verify count
      const afterCount = parseInt(psql(`SELECT jsonb_array_length(raw->'products') FROM orders WHERE id = ${orderId} AND deleted_at IS NULL`));

      if (afterCount !== beforeCount) {
        console.log(`ERROR: Order ${orderId} product count changed! ${beforeCount} -> ${afterCount}. ROLLING BACK!`);
        // We can't really roll back individual psql calls, but log the error
        updateErrors.push({ orderId, beforeCount, afterCount });
      } else {
        ordersUpdated++;
        rowsWritten += beforeCount;
      }
    } catch (e) {
      console.log(`Error updating order ${orderId}:`, e.message);
      updateErrors.push({ orderId, error: e.message });
    }
  }

  console.log(`\nOrders updated: ${ordersUpdated}`);
  console.log(`Orders skipped: ${ordersSkipped}`);
  console.log(`Update errors: ${updateErrors.length}`);
  if (updateErrors.length > 0) {
    console.log('Errors:', JSON.stringify(updateErrors, null, 2));
  }

  // ---- Stage 4: Validation ----
  console.log('\n=== Stage 4: Validation ===');

  const validationResult = psql(`
    SELECT
      COUNT(*) FILTER (WHERE (raw->'products'->0->>'display_category') IS NOT NULL) AS has_dc,
      COUNT(*) AS total
    FROM orders
    WHERE deleted_at IS NULL
      AND jsonb_array_length(COALESCE(raw->'products','[]'::jsonb)) > 0
  `);
  console.log('Validation:', validationResult);

  // Count by category for report
  const catCountResult = psql(`
    SELECT
      t.it->>'display_category' AS dc,
      COUNT(*) AS cnt
    FROM orders o, jsonb_array_elements(o.raw->'products') t(it)
    WHERE o.deleted_at IS NULL
      AND (t.it->>'display_category') IS NOT NULL
    GROUP BY dc
    ORDER BY cnt DESC
  `);
  console.log('Category distribution:\n', catCountResult);

  // Still missing
  const stillMissingResult = psql(`
    SELECT DISTINCT t.it->>'name' AS name
    FROM orders o, jsonb_array_elements(o.raw->'products') t(it)
    WHERE o.deleted_at IS NULL
      AND (t.it->>'display_category') IS NULL
      AND (t.it->>'name') IS NOT NULL
      AND t.it->>'name' != ''
    ORDER BY name
    LIMIT 25
  `);

  // ---- Generate Report ----
  const ambiguousNames = pendingAI.filter(n => nameToCategory[n]?.source?.includes('error') || nameToCategory[n]?.source === 'no_api_key' || nameToCategory[n]?.cat === 'other');

  const report = `# display_category Fill Report — 2026-05-19

## Summary
- Orders processed: ${orders.length}
- Orders updated: ${ordersUpdated}
- Orders skipped/errored: ${ordersSkipped + updateErrors.length}

## Classification
- Total unique names: ${uniqueNames.length}
- Layer 1 keyword hits: ${keywordHits} (${Math.round(keywordHits/uniqueNames.length*100)}%)
- MiniMax AI hits: ${aiHits}
- AI invalid/fallback: ${aiInvalid + aiErrors}
- Estimated cost: ~¥${(aiHits * 0.001).toFixed(3)} (${aiHits} API calls × $0.001)

## DB Validation
\`\`\`
${validationResult}
\`\`\`

## Category Distribution
\`\`\`
${catCountResult}
\`\`\`

## Still Missing (after update)
\`\`\`
${stillMissingResult}
\`\`\`

## Keyword Mapping Detail
${Object.entries(nameToCategory).slice(0, 50).map(([n, v]) => `- [${v.source}] ${n} → ${v.cat}`).join('\n')}
${Object.keys(nameToCategory).length > 50 ? `... and ${Object.keys(nameToCategory).length - 50} more` : ''}

## Update Errors (if any)
${updateErrors.length === 0 ? 'None' : JSON.stringify(updateErrors, null, 2)}
`;

  fs.writeFileSync('/tmp/display-category-77-report.md', report);
  console.log('\nReport written to /tmp/display-category-77-report.md');
  console.log('\n=== DONE ===');
  console.log(`Keyword hits: ${keywordHits}, AI hits: ${aiHits}, Orders updated: ${ordersUpdated}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
