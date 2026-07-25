import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL/POSTGRES_URL/PG_URL required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function text(v) {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function currency(items) {
  for (const it of items) {
    const c = text(it?.currency);
    if (c) return c;
  }
  return "CNY";
}

function netWeightKg(it) {
  const u = text(it?.unit1);
  return ["千克", "KG", "kg"].includes(u) ? num(it?.qty1) : null;
}

function itemQtyUnit(it) {
  const ctn = num(it?.qty_ctn);
  if (ctn !== null) return { qty: ctn, unit: "箱" };
  return { qty: num(it?.qty2), unit: text(it?.unit2) };
}

async function loadFer(client) {
  const r = await client.query(
    `SELECT id, customs_no, contract_no, raw
       FROM finance_export_rebates
      WHERE COALESCE(customs_no,'') <> ''
        AND jsonb_typeof(raw->'items')='array'
      ORDER BY customs_no, id`
  );
  const grouped = new Map();
  for (const row of r.rows) {
    const key = row.customs_no;
    if (!grouped.has(key)) grouped.set(key, { customs_no: key, fer_id: row.id, contract_no: row.contract_no, items: [] });
    const g = grouped.get(key);
    for (const item of arr(row.raw?.items)) g.items.push(item);
  }
  return [...grouped.values()].filter((x) => x.items.length);
}

async function resolvePlanId(client, fer) {
  // FK fk_cd_shipping_plan 强制指向 shipping_plans._id;经 orders(bl/order_no/contract) 关联解析
  const r = await client.query(
    `WITH ords AS (
       SELECT o.order_no, o.bl_no FROM orders o
        WHERE (o.bl_no=$1 OR o.order_no=$1 OR ($2::text IS NOT NULL AND o.contract_no=$2))
          AND COALESCE(o.status,'') <> 'cancelled'
     )
     SELECT DISTINCT sp._id FROM shipping_plans sp
      WHERE (COALESCE(sp.bl_no,'')<>'' AND sp.bl_no IN (SELECT bl_no FROM ords WHERE COALESCE(bl_no,'')<>''))
         OR sp.order_nos && (SELECT COALESCE(array_agg(order_no),'{}') FROM ords)`,
    [fer.customs_no, fer.contract_no || null]
  );
  // 多计划歧义=不猜,跳过+警示(同"匹配不上就回退"哲学);恰一个才用
  if (r.rows.length !== 1) return { planId: null, ambiguous: r.rows.length > 1 };
  return { planId: r.rows[0]._id, ambiguous: false };
}

async function upsertDeclaration(client, fer) {
  // 照录: 全部项都无申报金额时 total 存 NULL,不存 0(0 会被误读成申报0元)
  const amounts = fer.items.map((it) => num(it?.amount)).filter((v) => v !== null);
  const total = amounts.length ? amounts.reduce((s, v) => s + v, 0) : null;
  const r = await client.query(
    `INSERT INTO customs_declarations
       (declaration_no, shipping_plan_id, owner_company_id, total_declaration_amount, total_declaration_currency,
        source_system, source_table, source_record_id, raw, updated_at)
     VALUES ($1,$6,37,$2,$3,'fer_raw_import','finance_export_rebates',$4,
             jsonb_build_object('fer_contract_no',$5::text),NOW())
     ON CONFLICT (declaration_no) DO UPDATE SET
       total_declaration_amount=EXCLUDED.total_declaration_amount,
       total_declaration_currency=EXCLUDED.total_declaration_currency,
       source_system=EXCLUDED.source_system,
       source_table=EXCLUDED.source_table,
       source_record_id=EXCLUDED.source_record_id,
       raw=EXCLUDED.raw,
       updated_at=NOW()
     RETURNING id`,
    [fer.customs_no, total, currency(fer.items), fer.fer_id, fer.contract_no, fer.plan_id]
  );
  return { id: r.rows[0].id, total };
}

async function replaceItems(client, declarationId, customsNo, items) {
  // chk_cdi_source 只允许枚举值,fer 导入行用 'other';幂等按本关单 idempotency_key 前缀删,不碰他源行
  await client.query(
    `DELETE FROM customs_declaration_items
      WHERE declaration_id=$1 AND source_type='other' AND idempotency_key LIKE $2
        AND raw->>'import'='fer_raw'`,
    [declarationId, `${customsNo}#%`]
  );
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const qu = itemQtyUnit(it);
    await client.query(
      `INSERT INTO customs_declaration_items
        (declaration_id, owner_company_id, declaration_name_cn, declaration_elements, hs_code,
         qty, unit, net_weight_kg, declaration_amount, unit_price,
         declaration_currency, source_region, destination_country,
         sort_order, source_type, idempotency_key, raw)
       VALUES ($1,37,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'other',$14,'{"import":"fer_raw"}'::jsonb)`,
      [
        declarationId,
        // NOT NULL 列: 原文缺失存 ''/0 占位(reader 映射回 null),不造数据
        text(it?.name_cn ?? it?.name) || "",
        text(it?.spec),
        text(it?.hs_code ?? it?.hs) || "",
        qu.qty ?? 0,
        qu.unit,
        netWeightKg(it),
        num(it?.amount),
        num(it?.unit_price),
        text(it?.currency) || "CNY",
        text(it?.source_region),
        text(it?.dest_country),
        i + 1,
        `${customsNo}#${i + 1}`,
      ]
    );
  }
}

async function customsDocTotals(client) {
  const r = await client.query(
    `SELECT customs_no, cny_total
       FROM customs_docs
      WHERE cny_total IS NOT NULL`
  );
  return new Map(r.rows.map((x) => [x.customs_no, num(x.cny_total)]));
}

async function main() {
  const client = await pool.connect();
  const warnings = [];
  const skipped = [];
  let declarations = 0;
  let itemCount = 0;
  try {
    const docTotals = await customsDocTotals(client);
    const rows = await loadFer(client);
    for (const fer of rows) {
      const plan = await resolvePlanId(client, fer);
      fer.plan_id = plan.planId;
      if (!fer.plan_id) {
        // FK 硬约束无法满足或多计划歧义 → 跳过并警示;reader 对这些关单自动回退 fer.raw.items,不断功能
        skipped.push(plan.ambiguous ? `${fer.customs_no}(ambiguous_plan)` : fer.customs_no);
        continue;
      }
      await client.query("BEGIN");
      try {
        const decl = await upsertDeclaration(client, fer);
        await replaceItems(client, decl.id, fer.customs_no, fer.items);
        await client.query("COMMIT");
        declarations += 1;
        itemCount += fer.items.length;
        const docTotal = docTotals.get(fer.customs_no);
        if (docTotal !== null && docTotal !== undefined && decl.total !== null && Math.abs(decl.total - docTotal) > 1) {
          warnings.push({ customs_no: fer.customs_no, items_total: decl.total, customs_docs_cny_total: docTotal, diff: decl.total - docTotal });
        }
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
  for (const w of warnings) console.warn("[amount_mismatch]", JSON.stringify(w));
  console.log(JSON.stringify({ declarations, items: itemCount, warnings, skipped_no_plan: skipped }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
