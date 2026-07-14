import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

function ymdPeriod(period) {
  const s = String(period || "").replace(/[^0-9]/g, "");
  if (!/^\d{6}$/.test(s)) return null;
  const m = Number(s.slice(4, 6));
  if (m < 1 || m > 12) return null;
  const start = `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
  const endDate = new Date(Date.UTC(Number(s.slice(0, 4)), m, 1));
  return { period: s, start, end: endDate.toISOString().slice(0, 10) };
}

function batchNo(v) {
  const s = String(v || "001").replace(/[^0-9]/g, "");
  return s.padStart(3, "0").slice(-3);
}

function rawObj(v) {
  if (!v) return {};
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v;
}

function itemsFromRaw(raw) {
  const r = rawObj(raw);
  return Array.isArray(r.items) ? r.items : [];
}

function text(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function declarationNo(row) {
  const raw = rawObj(row.raw);
  return text(raw.declaration_no) || text(row.customs_no);
}

async function loadSeeds(client, customsNos) {
  const params = [];
  const where = [];
  if (customsNos?.length) {
    params.push(customsNos);
    where.push(`customs_no = ANY($${params.length}::text[])`);
  }
  const sql = `
    SELECT id, customs_no, contract_no, export_date, raw
      FROM finance_export_rebates
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY export_date NULLS LAST, customs_no`;
  const r = await client.query(sql, params);
  return r.rows.filter((row) => declarationNo(row) && itemsFromRaw(row.raw).length);
}

async function upsertDeclaration(client, seed, rebatePeriod, rebateBatch) {
  const raw = rawObj(seed.raw);
  const no = declarationNo(seed);
  const declaredAt = text(raw.declare_date) || seed.export_date || null;
  const totalAmount = num(raw.total_amount) || null;
  const currency = text(raw.currency) || text(raw.items?.[0]?.currency) || "人民币";
  const r = await client.query(
    `INSERT INTO customs_declarations
       (declaration_no, declaration_status, total_declaration_amount, total_declaration_currency,
        declared_at, container_nos, source_system, raw, rebate_period, rebate_batch, created_at, updated_at)
     VALUES ($1, 'seeded_from_finance_export_rebates', $2, $3, $4::date, $5, 'tax-rebate-backfill', $6::jsonb, $7, $8, now(), now())
     ON CONFLICT (declaration_no) DO UPDATE SET
       total_declaration_amount = COALESCE(customs_declarations.total_declaration_amount, EXCLUDED.total_declaration_amount),
       total_declaration_currency = COALESCE(customs_declarations.total_declaration_currency, EXCLUDED.total_declaration_currency),
       declared_at = COALESCE(customs_declarations.declared_at, EXCLUDED.declared_at),
       container_nos = COALESCE(customs_declarations.container_nos, EXCLUDED.container_nos),
       raw = COALESCE(customs_declarations.raw, '{}'::jsonb) || EXCLUDED.raw,
       rebate_period = EXCLUDED.rebate_period,
       rebate_batch = EXCLUDED.rebate_batch,
       updated_at = now()
     RETURNING id, declaration_no, rebate_period, rebate_batch`,
    [no, totalAmount, currency, declaredAt, text(raw.container_nos), JSON.stringify({
      ...raw,
      finance_export_rebate_id: seed.id,
      fob_usd_source: "pending_pdf_anchor",
    }), rebatePeriod, rebateBatch]
  );
  return r.rows[0];
}

async function replaceItems(client, declId, seed) {
  const items = itemsFromRaw(seed.raw);
  await client.query(
    `DELETE FROM customs_declaration_items
      WHERE declaration_id=$1 AND COALESCE(source_system,'')='tax-rebate-backfill'`,
    [declId]
  );
  const rows = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const sort = i + 1;
    const raw = { ...it, fob_usd_source: "pending_pdf_anchor" };
    const r = await client.query(
      `INSERT INTO customs_declaration_items
         (declaration_id, hs_code, declaration_name_cn, unit, qty, gross_weight_kg, net_weight_kg,
          declaration_amount, declaration_currency, unit_price, country_of_origin, destination_country,
          sort_order, fob_usd, fob_usd_source, source_system, raw, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, $9, $10,
          $11, NULL, 'pending_pdf_anchor', 'tax-rebate-backfill', $12::jsonb, now(), now())
       RETURNING id, hs_code, declaration_name_cn, unit, qty, sort_order, fob_usd, fob_usd_source`,
      [
        declId,
        text(it.hs_code),
        text(it.name_cn),
        text(it.unit1) || text(it.unit) || "千克",
        num(it.qty1) ?? num(it.qty),
        num(it.amount),
        text(it.currency) || "人民币",
        num(it.unit_price),
        text(it.origin_country) || text(it.country_of_origin) || "中国",
        text(it.dest_country) || text(it.destination_country),
        sort,
        JSON.stringify(raw),
      ]
    );
    rows.push(r.rows[0]);
  }
  return rows;
}

export async function runDeclarationBackfill({ period, batch = "001", customs_nos } = {}) {
  const periodInfo = ymdPeriod(period);
  if (period && !periodInfo) throw new Error("period must be YYYYMM");
  if (!periodInfo) throw new Error("period is required");
  const b = batchNo(batch);
  const customsNos = Array.isArray(customs_nos) ? customs_nos.map(text).filter(Boolean) : [];
  if (!customsNos.length) throw new Error("customs_nos is required to assign a rebate declaration batch");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seeds = await loadSeeds(client, customsNos);
    const declarations = [];
    let itemCount = 0;
    for (const seed of seeds) {
      const decl = await upsertDeclaration(client, seed, periodInfo.period, b);
      const items = await replaceItems(client, decl.id, seed);
      itemCount += items.length;
      declarations.push({ ...decl, customs_no: seed.customs_no, item_count: items.length, items });
    }
    await client.query("COMMIT");
    return { success: true, period: periodInfo.period, batch: b, declarations, item_count: itemCount };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!FINANCE_ROLES.has(req.user?.role)) return res.status(403).json({ error: "仅财务/管理员可操作" });
  try {
    const input = req.method === "POST" ? req.body || {} : req.query || {};
    const data = await runDeclarationBackfill(input);
    return res.json(data);
  } catch (e) {
    console.error("[tax-rebate-declaration-backfill]", e);
    return res.status(500).json({ error: e.message });
  }
}
