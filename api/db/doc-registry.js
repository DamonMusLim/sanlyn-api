// /api/db/doc-registry — unified document template registry (read-only P0)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const COLUMNS = `
  id, code, domain, doc_type, name_cn, name_en, render_kind, renderer, status,
  version, customer_code, note, sort, active, created_at, updated_at
`;

const REQUIRED_FIELDS = ["code", "domain", "render_kind", "name_cn", "name_en"];
const RENDER_KINDS = new Set([
  "dynamic",
  "inline",
  "route",
  "static_fill",
  "data_template",
  "docx",
]);
const DYNAMIC_KINDS = new Set(["dynamic", "inline", "route"]);

function getCode(req) {
  if (req.params?.code) return req.params.code;
  const path = (req.path || req.url || "").split("?")[0];
  const match = path.match(/\/api\/db\/doc-registry\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function conflict(res, error, field) {
  return res.status(409).json({ success: false, error, field });
}

function addFilter(parts, values, column, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return;
  values.push(String(rawValue));
  parts.push(`${column} = $${values.length}`);
}

function groupByDomain(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.domain)) map.set(row.domain, { domain: row.domain, items: [] });
    map.get(row.domain).items.push(row);
  }
  return Array.from(map.values());
}

function groupVersions(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.registry_code)) map.set(row.registry_code, []);
    map.get(row.registry_code).push(row);
  }
  for (const versions of map.values()) {
    versions.sort((a, b) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return String(a.version || "").localeCompare(String(b.version || ""));
    });
  }
  return map;
}

function groupFields(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.doc_type)) map.set(row.doc_type, []);
    map.get(row.doc_type).push(row);
  }
  for (const fields of map.values()) {
    fields.sort((a, b) => {
      const sortA = a.sort_order === null || a.sort_order === undefined ? 0 : Number(a.sort_order);
      const sortB = b.sort_order === null || b.sort_order === undefined ? 0 : Number(b.sort_order);
      if (sortA !== sortB) return sortA - sortB;
      return String(a.col_key || "").localeCompare(String(b.col_key || ""));
    });
  }
  return map;
}

async function loadRegistryLinks(pool) {
  const [versionsResult, fieldsResult] = await Promise.all([
    pool.query(
      `SELECT registry_code, version, style_variant, is_current, note, status
       FROM doc_template_versions`
    ),
    pool.query(
      `SELECT doc_type, col_key, label, visible, sort_order
       FROM doc_column_config`
    ),
  ]);
  return {
    versionsByCode: groupVersions(versionsResult.rows),
    fieldsByDocType: groupFields(fieldsResult.rows),
  };
}

function enrichItem(item, links) {
  const versions = links.versionsByCode.get(item.code) || [];
  const fields = item.doc_type ? links.fieldsByDocType.get(item.doc_type) || [] : [];
  return {
    ...item,
    versions: versions.map(({ version, style_variant, is_current, note, status }) => ({
      version,
      style_variant,
      is_current,
      note,
      status,
    })),
    field_count: fields.length,
    fields: fields.map(({ col_key, label, visible, sort_order }) => ({
      col_key,
      label,
      visible,
      sort_order,
    })),
  };
}

async function enrichItems(pool, rows) {
  const links = await loadRegistryLinks(pool);
  return rows.map((row) => enrichItem(row, links));
}

async function validatePost(pool, body) {
  for (const field of REQUIRED_FIELDS) {
    if (!clean(body[field])) return { error: `${field} 必填`, field };
  }

  const code = clean(body.code);
  const renderKind = clean(body.render_kind);
  if (!RENDER_KINDS.has(renderKind)) {
    return { error: "render_kind 不支持", field: "render_kind" };
  }

  const exists = await pool.query(
    "SELECT 1 FROM doc_template_registry WHERE code = $1 LIMIT 1",
    [code]
  );
  if (exists.rows[0]) return { error: "code 已存在", field: "code" };

  const docType = clean(body.doc_type);
  const renderer = clean(body.renderer);
  const fileUrl = clean(body.file_url);
  if (DYNAMIC_KINDS.has(renderKind) && !docType && !renderer) {
    return { error: "动态件需 doc_type 或 renderer", field: "doc_type" };
  }
  if (renderKind === "static_fill" && !fileUrl) {
    return { error: "file_url 必填", field: "file_url" };
  }
  if (renderKind === "data_template") {
    if (!renderer || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(renderer)) {
      return { error: "数据模板表不存在", field: "renderer" };
    }
    const table = await pool.query("SELECT to_regclass($1) AS oid", [renderer]);
    if (!table.rows[0]?.oid) {
      return { error: "数据模板表不存在", field: "renderer" };
    }
  }
  if (renderKind === "docx" && !renderer) {
    return { error: "renderer 必填", field: "renderer" };
  }
  return null;
}

async function handlePost(pool, req, res) {
  const body = req.body || {};
  const invalid = await validatePost(pool, body);
  if (invalid) return conflict(res, invalid.error, invalid.field);

  const renderKind = clean(body.render_kind);
  const renderer = renderKind === "static_fill" ? clean(body.file_url) : clean(body.renderer);
  const { rows } = await pool.query(
    `INSERT INTO doc_template_registry
       (code, domain, doc_type, name_cn, name_en, render_kind, renderer, status,
        version, customer_code, note, sort, active)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, 'live', $8, $9, $10,
        (SELECT COALESCE(MAX(sort), 0) + 1 FROM doc_template_registry), true)
     RETURNING ${COLUMNS}`,
    [
      clean(body.code),
      clean(body.domain),
      clean(body.doc_type) || null,
      clean(body.name_cn),
      clean(body.name_en),
      renderKind,
      renderer,
      clean(body.version) || "v1",
      clean(body.customer_code) || null,
      clean(body.note) || null,
    ]
  );
  return res.json({ success: true, item: rows[0] });
}

async function handleDelete(pool, req, res) {
  const code = clean(getCode(req) || req.query?.code || req.body?.code);
  if (!code) return conflict(res, "code 必填", "code");
  await pool.query(
    "UPDATE doc_template_registry SET status = 'archived', active = false, updated_at = now() WHERE code = $1",
    [code]
  );
  return res.json({ success: true });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const pool = getPool();
  const code = getCode(req);

  try {
    if (req.method === "POST") return handlePost(pool, req, res);
    if (req.method === "DELETE") return handleDelete(pool, req, res);

    if (code) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM doc_template_registry WHERE code = $1 LIMIT 1`,
        [code]
      );
      if (!rows[0]) return res.status(404).json({ success: false, error: "not found" });
      const [item] = await enrichItems(pool, rows);
      return res.json({ success: true, item });
    }

    const filters = ["active = true"];
    const values = [];
    addFilter(filters, values, "domain", req.query?.domain);
    if (req.query?.status) addFilter(filters, values, "status", req.query.status);
    else filters.push("status <> 'archived'");

    const { rows } = await pool.query(
      `SELECT ${COLUMNS}
       FROM doc_template_registry
       WHERE ${filters.join(" AND ")}
       ORDER BY domain, sort, code`,
      values
    );
    const items = await enrichItems(pool, rows);
    return res.json({ success: true, registry: groupByDomain(items), total: items.length });
  } catch (err) {
    console.error("[doc-registry]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
