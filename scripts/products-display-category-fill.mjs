/**
 * products-display-category-fill.mjs  v2
 * Fixes vs v1:
 *  - cat2='猫用' + GRAIN FREE/COMPLETE FOOD → dry-food before wet check
 *  - cat2='犬用' + FOR CAT in name → cat-wet override
 *  - cat1='宠物用品' + food/toy in product_name → redirect before supplies catchall
 */
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const VALID = new Set(['cat-dry','cat-wet','dog-dry','dog-wet','litter','toys','supplies','grooming','other']);

const CLASSIFY_SQL = `
  SELECT id, sku, product_name, cat1, cat2,
    CASE
      -- ── 1. LITTER ────────────────────────────────────────────────────────
      WHEN cat2 ILIKE '%猫砂%' OR cat2 = '膨润土猫砂' OR cat2 = '猫砂盆'
           OR cat2 IN ('猫砂铲','猫砂用品','猫砂配件') THEN 'litter'
      WHEN product_name ILIKE '%BENTONITE%' OR product_name ILIKE '%猫砂%'
           OR product_name ILIKE '%LITTER%' AND cat1 != '宠物玩具' THEN 'litter'

      -- ── 2. TOYS ──────────────────────────────────────────────────────────
      WHEN cat1 = '宠物玩具' AND (cat2 IS NULL OR (
             cat2 NOT ILIKE '%服装%' AND cat2 NOT ILIKE '%笼%' AND
             cat2 NOT ILIKE '%梳%'   AND cat2 NOT ILIKE '%小宠%'
           )) THEN 'toys'
      WHEN cat2 ILIKE '%玩具%' AND cat2 NOT ILIKE '%小宠%' THEN 'toys'
      -- product_name "Toy" keyword (catches misclassified rows in 其他宠物用品 etc.)
      WHEN (product_name ILIKE '%toy%' OR product_name ILIKE '%teaser%') AND cat1 != '宠物食品' THEN 'toys'

      -- ── 3. GROOMING ──────────────────────────────────────────────────────
      WHEN cat1 = '宠物清洁' AND cat2 NOT ILIKE '%猫砂%' THEN 'grooming'
      WHEN cat2 ILIKE '%美容%' OR cat2 ILIKE '%洗护%' OR cat2 ILIKE '%护理%'
           OR cat2 ILIKE '%清洁%' OR cat2 ILIKE '%香氛%' OR cat2 ILIKE '%除臭%' THEN 'grooming'
      WHEN cat2 ILIKE '%梳%' THEN 'grooming'
      WHEN cat2 ILIKE '%尿布%' OR cat2 ILIKE '%尿裤%' OR cat2 ILIKE '%尿垫%'
           OR cat2 ILIKE '%纸尿裤%' THEN 'grooming'
      WHEN cat2 ILIKE '%厕所%' OR cat2 ILIKE '%浴%' THEN 'grooming'
      WHEN cat1 = '生活用品' AND cat2 ILIKE '%纸巾%' THEN 'grooming'
      WHEN cat2 = '猫狗清洁/厕所用品' THEN 'grooming'
      WHEN cat1 = '宠物清洁' THEN 'grooming'

      -- ── 4. OTHER (exotic) ────────────────────────────────────────────────
      WHEN cat2 ILIKE '%仓鼠%' OR cat2 ILIKE '%水族%' OR cat2 ILIKE '%小动物%'
           OR cat2 ILIKE '%鸟%' OR cat2 ILIKE '%爬宠%' OR cat2 ILIKE '%小宠%' THEN 'other'
      WHEN cat1 = '⚠️_MISSING' OR cat1 IS NULL THEN 'other'

      -- ── 5. Clear cat2 food signals ────────────────────────────────────────
      WHEN cat2 = '猫粮' THEN 'cat-dry'
      WHEN cat2 = '猫零食' OR (cat1 = '宠物零食' AND cat2 ILIKE '%猫%') THEN 'cat-wet'
      WHEN cat2 = '狗粮' THEN 'dog-dry'
      WHEN cat2 IN ('犬零食','狗零食') OR (cat1 = '宠物零食' AND cat2 ILIKE '%狗%') THEN 'dog-wet'
      WHEN cat1 = '宠物零食' THEN 'other'

      -- ── 6. 干粮 ──────────────────────────────────────────────────────────
      WHEN cat2 = '干粮' AND (product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%') THEN 'dog-dry'
      WHEN cat2 = '干粮' THEN 'cat-dry'

      -- ── 7. cat2='猫用/猫用品' ────────────────────────────────────────────
      -- 7a. product is actually dry DOG food (GRAIN FREE COMPLETE for DOG)
      WHEN cat2 IN ('猫用','猫用品') AND (
        product_name ILIKE '%GRAIN FREE%' OR product_name ILIKE '%COMPLETE FOOD%'
        OR product_name ILIKE '%DRY FOOD%'  OR product_name ILIKE '%KIBBLE%'
      ) AND (product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%') THEN 'dog-dry'
      -- 7b. product is actually dry CAT food
      WHEN cat2 IN ('猫用','猫用品') AND (
        product_name ILIKE '%GRAIN FREE%' OR product_name ILIKE '%COMPLETE FOOD%'
        OR product_name ILIKE '%DRY FOOD%'  OR product_name ILIKE '%KIBBLE%'
      ) THEN 'cat-dry'
      -- 7c. product is DOG WET food misclassified under 猫用
      WHEN cat2 = '猫用' AND product_name ILIKE '%DOG%'
           AND product_name ILIKE '% FOOD%' AND product_name NOT ILIKE '%CAT%' THEN 'dog-wet'
      -- 7d. wet/treat signals → cat-wet
      WHEN cat2 IN ('猫用','猫用品') AND (
        product_name ILIKE '%TREAT%'    OR product_name ILIKE '%CREAMY%' OR
        product_name ILIKE '%LOAF%'     OR product_name ILIKE '%POUCH%' OR
        product_name ILIKE '%JELLY%'    OR product_name ILIKE '%MOUSSE%' OR
        product_name ILIKE '%PASTE%'    OR product_name ILIKE '%LICKABLE%' OR
        product_name ILIKE '%JERKY%'    OR product_name ILIKE '%STICK%' OR
        product_name ILIKE '%CHEW%'     OR product_name ILIKE '%TUBE%' OR
        product_name ILIKE '%CANNED%'   OR product_name ILIKE '%GRAVY%' OR
        product_name ILIKE '%SOUP%'     OR product_name ILIKE '%SNACK%'
      ) THEN 'cat-wet'
      -- 7e. default: cat-dry
      WHEN cat2 IN ('猫用','猫用品') THEN 'cat-dry'

      -- ── 8. cat2='犬用/犬用品/狗用品' ─────────────────────────────────────
      -- 8a. "FOR CAT" in name → cat product misclassified
      WHEN cat2 IN ('犬用','犬用品','狗用品') AND (
        product_name ILIKE '%FOR CAT%' OR product_name ILIKE '%FOR CATS%'
        OR product_name ILIKE '%CAT FOOD%'
      ) AND product_name NOT ILIKE '%FOR DOG%' THEN 'cat-wet'
      -- 8b. wet/treat signals → dog-wet
      WHEN cat2 IN ('犬用','犬用品','狗用品') AND (
        product_name ILIKE '%TREAT%'   OR product_name ILIKE '%JERKY%' OR
        product_name ILIKE '%SAUSAGE%' OR product_name ILIKE '%STICK%' OR
        product_name ILIKE '%BISCUIT%' OR product_name ILIKE '%CHEW%' OR
        product_name ILIKE '%RAWHIDE%' OR product_name ILIKE '%LOAF%' OR
        product_name ILIKE '%POUCH%'   OR product_name ILIKE '%CANNED%' OR
        product_name ILIKE '%CROISSANT%' OR product_name ILIKE '%BONE%' OR
        product_name ILIKE '%SNACK%'   OR product_name ILIKE '%HEART%' OR
        product_name ILIKE '%STRIP%'   OR product_name ILIKE '%FILLET%' OR
        product_name ILIKE '%BAR%'
      ) THEN 'dog-wet'
      -- 8c. dry signals → dog-dry
      WHEN cat2 IN ('犬用','犬用品','狗用品') AND (
        product_name ILIKE '%GRAIN FREE%' OR product_name ILIKE '%COMPLETE FOOD%'
        OR product_name ILIKE '%DRY FOOD%' OR product_name ILIKE '%KIBBLE%'
      ) THEN 'dog-dry'
      -- 8d. default: dog-dry
      WHEN cat2 IN ('犬用','犬用品','狗用品') THEN 'dog-dry'

      -- ── 9. 湿粮/罐头/餐盒 ────────────────────────────────────────────────
      WHEN cat2 ILIKE '%湿粮%' OR cat2 ILIKE '%餐盒%' OR cat2 ILIKE '%罐头%'
        THEN CASE WHEN product_name ILIKE '%DOG%' OR product_name ILIKE '%犬%' THEN 'dog-wet' ELSE 'cat-wet' END

      -- ── 10. 零食 catchall ────────────────────────────────────────────────
      WHEN cat2 ILIKE '%零食%'
        THEN CASE
          WHEN product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%'
               OR cat2 ILIKE '%犬%' OR cat2 ILIKE '%狗%' THEN 'dog-wet'
          WHEN product_name ILIKE '%CAT%' OR cat2 ILIKE '%猫%' THEN 'cat-wet'
          ELSE 'other'
        END

      -- ── 11. cat1='宠物用品' with food/toy signals (rescue misclassified) ──
      WHEN cat1 = '宠物用品' AND (
        product_name ILIKE '%JERKY%' OR product_name ILIKE '%BISCUIT%' OR
        product_name ILIKE '%TREAT%' OR product_name ILIKE '%CAT FOOD%' OR
        product_name ILIKE '%DOG FOOD%'
      ) AND (product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%') THEN 'dog-wet'
      WHEN cat1 = '宠物用品' AND (
        product_name ILIKE '%JERKY%' OR product_name ILIKE '%BISCUIT%' OR
        product_name ILIKE '%TREAT%' OR product_name ILIKE '%CAT FOOD%'
      ) THEN 'cat-wet'

      -- ── 12. cat1=宠物食品 product_name fallback ──────────────────────────
      WHEN cat1 = '宠物食品' AND (
        product_name ILIKE '%GRAIN FREE%' OR product_name ILIKE '%COMPLETE FOOD%'
        OR product_name ILIKE '%DRY FOOD%' OR product_name ILIKE '%KIBBLE%'
      ) AND (product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%') THEN 'dog-dry'
      WHEN cat1 = '宠物食品' AND (
        product_name ILIKE '%GRAIN FREE%' OR product_name ILIKE '%COMPLETE FOOD%'
        OR product_name ILIKE '%DRY FOOD%' OR product_name ILIKE '%KIBBLE%'
      ) THEN 'cat-dry'
      WHEN cat1 = '宠物食品' AND (
        product_name ILIKE '%SNIFFLY DOG%' OR product_name ILIKE '%DOG TRAY%'
      ) THEN 'dog-wet'
      WHEN cat1 = '宠物食品' AND (
        product_name ILIKE '%JERKY%' OR product_name ILIKE '%SAUSAGE%' OR
        product_name ILIKE '%TREAT%' OR product_name ILIKE '%LOAF%' OR
        product_name ILIKE '%CANNED%' OR product_name ILIKE '%POUCH%' OR
        product_name ILIKE '%CREAMY%' OR product_name ILIKE '%MOUSSE%' OR
        product_name ILIKE '%HEART%'  OR product_name ILIKE '%FILLET%' OR
        product_name ILIKE '%STRIP%'  OR product_name ILIKE '%BAR%'
      ) AND (product_name ILIKE '%DOG%' OR product_name ILIKE '%PUPPY%') THEN 'dog-wet'
      WHEN cat1 = '宠物食品' AND (
        product_name ILIKE '%JERKY%' OR product_name ILIKE '%SAUSAGE%' OR
        product_name ILIKE '%TREAT%' OR product_name ILIKE '%LOAF%' OR
        product_name ILIKE '%CANNED%' OR product_name ILIKE '%POUCH%' OR
        product_name ILIKE '%CREAMY%' OR product_name ILIKE '%MOUSSE%' OR
        product_name ILIKE '%HEART%'  OR product_name ILIKE '%FILLET%' OR
        product_name ILIKE '%STRIP%'  OR product_name ILIKE '%BAR%'
      ) THEN 'cat-wet'
      WHEN cat1 = '宠物食品' THEN 'other'

      -- ── 13. Catchalls ────────────────────────────────────────────────────
      WHEN cat1 = '宠物用品' THEN 'supplies'
      WHEN cat1 = '宠物玩具' THEN 'toys'
      WHEN cat1 = '宠物清洁' THEN 'grooming'
      WHEN cat1 = '生活用品' THEN 'other'
      ELSE 'other'
    END AS display_category
  FROM products WHERE active = true ORDER BY id
`;

async function run() {
  const client = await pool.connect();
  try {
    const rows = (await client.query(CLASSIFY_SQL)).rows;
    const dist = {}, samples = {};

    for (const r of rows) {
      const dc = r.display_category;
      if (!VALID.has(dc)) { console.error('INVALID:', dc, r.sku); process.exit(1); }
      dist[dc] = (dist[dc] || 0) + 1;
      if (!samples[dc]) samples[dc] = [];
      if (samples[dc].length < 5) samples[dc].push(`  ${r.sku} | ${(r.product_name||'').slice(0,65)}`);
    }

    console.log('\n=== Distribution ===');
    for (const [k,v] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) {
      const warn = (v > 500 || v < 5) ? ' ⚠️' : '';
      console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}${warn}`);
      (samples[k]||[]).forEach(s => console.log(s));
    }
    console.log(`  Total: ${rows.length}`);

    for (const [k,v] of Object.entries(dist)) {
      if (v > 500) console.warn(`\n⚠️  ALERT: ${k} has ${v} SKUs (>500)`);
      if (v < 5)   console.warn(`\n⚠️  ALERT: ${k} has only ${v} SKUs (<5)`);
    }

    if (!APPLY) { console.log('\nDry-run done. --apply to write.'); return; }

    console.log('\nApplying...');
    await client.query('BEGIN');
    for (const dc of VALID) {
      const ids = rows.filter(r => r.display_category === dc).map(r => r.id);
      if (!ids.length) continue;
      await client.query(
        `UPDATE products SET raw = jsonb_set(COALESCE(raw,'{}'),'{display_category}',$1::jsonb), updated_at=NOW() WHERE id=ANY($2) AND active=true`,
        [JSON.stringify(dc), ids]
      );
      console.log(`  ✅ ${dc}: ${ids.length}`);
    }
    // flag food items going to 'other' as pending
    const pendingIds = rows.filter(r => r.display_category==='other' &&
      (r.cat1==='宠物食品'||r.cat1===null)).map(r=>r.id);
    if (pendingIds.length) {
      await client.query(
        `UPDATE products SET raw=jsonb_set(raw,'{_display_category_pending}','true'::jsonb) WHERE id=ANY($1)`,
        [pendingIds]
      );
      console.log(`  📋 pending: ${pendingIds.length}`);
    }
    await client.query('COMMIT');

    const v = await client.query(`SELECT raw->>'display_category' dc,COUNT(*) FROM products WHERE active=true GROUP BY 1 ORDER BY 2 DESC`);
    console.log('\n=== Final ===');
    v.rows.forEach(r=>console.log(`  ${(r.dc||'NULL').padEnd(14)} ${r.count}`));
  } catch(e) { await client.query('ROLLBACK'); console.error(e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
