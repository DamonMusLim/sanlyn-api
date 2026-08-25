import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

class IdentifierError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentifierError";
  }
}

const LOOKUPS = {
  ports: {
    table: "ports",
    key: "code",
    display: "name_cn",
    search: ["code", "name_cn", "name_en", "unlocode"],
    expose: ["id", "code", "name_cn", "name_en", "country_code", "unlocode", "port_type", "requires_terminal", "weight_limit_kg", "weight_limit_note", "note"],
    order: ["name_cn", "code"],
  },
  countries: {
    table: "countries",
    key: "code",
    display: "name_cn",
    search: ["code", "code3", "name_cn", "name_en"],
    expose: ["id", "code", "code3", "name_cn", "name_en", "currency", "flag_emoji", "region", "sanlyn_market", "is_sovereign", "note", "notes"],
    order: ["name_cn", "code"],
  },
  companies: {
    table: "companies",
    key: "code",
    display: "name_cn",
    search: ["code", "name_cn", "name_en", "short_name", "tax_id"],
    expose: ["id", "code", "name_cn", "name_en", "short_name", "tax_id", "type", "country", "country_id", "address", "address_en", "active"],
    order: ["name_cn", "code"],
  },
  customers: {
    table: "customers",
    key: "company_code",
    display: "name",
    search: ["company_code", "name", "name_cn", "name_en", "tax_id", "contact_name"],
    expose: ["company_code", "name", "name_cn", "name_en", "country", "contact_name", "tax_id", "is_active"],
    order: ["name", "company_code"],
  },
  manifest_parties: {
    table: "manifest_parties",
    key: "id",
    display: "name_en",
    search: ["name_en", "enterprise_code", "aeo_code", "contact_name"],
    expose: ["id", "name_en", "enterprise_code", "aeo_code", "role", "country_code", "address_en", "contact_name", "contact_phone", "verified", "note"],
    order: ["name_en", "id"],
  },
};

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;
const COLUMN_CACHE_TTL_MS = 5 * 60 * 1000;
const columnCache = new Map();

function assertIdentifier(name) {
  if (!IDENTIFIER_RE.test(name)) throw new IdentifierError(`invalid identifier: ${name}`);
  return name;
}

function qid(name) {
  return `"${assertIdentifier(name).replace(/"/g, '""')}"`;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function pickColumn(columns, allowed, requested, fallback) {
  const name = String(requested || "").trim();
  if (name && allowed.includes(name) && columns.has(name)) return name;
  if (fallback && columns.has(fallback)) return fallback;

  const firstAvailable = allowed.find(column => columns.has(column));
  if (firstAvailable) return firstAvailable;

  throw new IdentifierError(`no usable column from: ${allowed.join(", ")}`);
}

async function loadColumns(pool, tableName) {
  const cached = columnCache.get(tableName);
  if (cached && Date.now() - cached.loadedAt < COLUMN_CACHE_TTL_MS) {
    return cached.columns;
  }

  const { rows } = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );

  if (rows.length === 0) return null;

  const columns = new Set(rows.map(row => row.column_name));
  columnCache.set(tableName, { columns, loadedAt: Date.now() });
  return columns;
}

function getLookupConfig(rawType) {
  const type = String(rawType || "").trim();
  const config = LOOKUPS[type];
  if (!config) throw new IdentifierError(`unsupported lookup type: ${type}`);
  return { type, config };
}

function buildWhere(config, columns, query, params) {
  const clauses = [];
  if (columns.has("deleted_at")) clauses.push(`${qid("deleted_at")} IS NULL`);
  if (columns.has("active")) clauses.push(`${qid("active")} IS NOT FALSE`);
  if (columns.has("is_active")) clauses.push(`${qid("is_active")} IS NOT FALSE`);

  const q = String(query || "").trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    const searchColumns = config.search.filter(column => columns.has(column));
    if (searchColumns.length === 0) {
      throw new IdentifierError(`no searchable columns for ${config.table}`);
    }
    clauses.push(`(${searchColumns.map(column => `${qid(column)}::text ILIKE ${p}`).join(" OR ")})`);
  }

  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

function normalizeLimit(rawLimit) {
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(limit, 50);
}

function makePublicRow(row, keyField, displayField, exposeColumns) {
  const out = {};
  for (const column of exposeColumns) out[column] = row[column];
  out.value = row[keyField];
  out.label = row[displayField] ?? row[keyField];
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!requireAuth(req, res)) return;

  try {
    const { type, config } = getLookupConfig(req.query?.target_table || req.query?.type || req.query?.table || req.query?.source);
    const pool = getPool();
    const columns = await loadColumns(pool, config.table);
    if (!columns) throw new IdentifierError(`table not found: ${config.table}`);

    const keyField = pickColumn(columns, [config.key, ...config.expose], req.query?.target_key_field || req.query?.key, config.key);
    const displayField = pickColumn(columns, [config.display, ...config.search, ...config.expose], req.query?.target_display_field || req.query?.display, config.display);
    const exposeColumns = unique([...config.expose, keyField, displayField]).filter(column => columns.has(column));
    const selectColumns = unique([...exposeColumns, keyField, displayField]);
    const params = [];
    const whereSql = buildWhere(config, columns, req.query?.q || req.query?.query || req.query?.keyword, params);
    const orderColumns = config.order.filter(column => columns.has(column));
    const orderSql = orderColumns.length
      ? `ORDER BY ${orderColumns.map(column => `${qid(column)} ASC NULLS LAST`).join(", ")}`
      : "";

    params.push(normalizeLimit(req.query?.limit));
    const sql = `
      SELECT ${selectColumns.map(qid).join(", ")}
        FROM ${qid(config.table)}
        ${whereSql}
        ${orderSql}
       LIMIT $${params.length}
    `;
    const { rows } = await pool.query(sql, params);

    return res.status(200).json({
      success: true,
      type,
      key_field: keyField,
      display_field: displayField,
      data: rows.map(row => makePublicRow(row, keyField, displayField, exposeColumns)),
    });
  } catch (err) {
    if (err instanceof IdentifierError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[field-lookup]", err);
    return res.status(500).json({ error: "field lookup failed" });
  }
}
