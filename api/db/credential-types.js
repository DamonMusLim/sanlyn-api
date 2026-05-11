// credential-types.js — Stage 3 Phase 1 (read-only)
//
// Implements the GET portion of Stage 2C §5 /api/db/credential-types contract.
// Returns the unified response envelope:
//   { success: true, data: [...], count: <int>, next_cursor: null }
//
// Read-only by design in this stage:
//   - POST   → 405 with error="not_implemented"
//   - PATCH  → 405 with error="not_implemented"
//   - DELETE → 405 with error="not_implemented"
// Stage 3 phase ≥ 2 will add platform_admin writes per Stage 2C §5.3.
//
// Hard rules:
//   - NO writes. NO DB mutation. NO migration. NO OSS.
//   - 401 if no JWT.
//   - Filter params:
//       ?status=active|inactive|deprecated
//       ?category=<one of Stage 2C §4.2 enum>
//       ?role=<applies_to_roles element>
//       ?supply_chain_type=<applies_to_supply_chain_types element>
//   - Graceful unavailable when credential_types table does not yet exist:
//       fall back to reading legacy cert_type_config and remapping the row
//       into the new shape (Stage 2C §8 compat-read; no dual-canonical write).
//   - Source flag is always included so callers know whether they read
//     the canonical table or the legacy compat path.
//
// Source contracts:
//   docs/blueprints/COMPANY-CREDENTIALS-STAGE2C-API-CONTRACT.md §5
//   docs/blueprints/COMPANY-CREDENTIALS-STAGE2B-SCHEMA-DESIGN.md §4
//   docs/blueprints/COMPANY-CREDENTIALS-STAGE2B-V1_2-SCHEMA-DELTA.md
//
// Side notes:
//   The credential_types table is currently a Stage 2B draft only — it may
//   not exist on the live database when this endpoint is deployed. That is
//   the explicit graceful-unavailable case; we surface a 503 with error
//   code `credential_types_not_ready` when BOTH canonical and legacy tables
//   are missing, instead of crashing.

import { getPool, setCors } from "../db.js";

var CATEGORY_ENUM = new Set([
  "company_identity", "trade_export", "factory_compliance",
  "supply_chain_license", "quality_inspection", "finance_tax",
  "legal_contract", "brand_authorization", "other",
]);
var STATUS_ENUM = new Set(["active", "inactive", "deprecated"]);
var ROLE_ENUM = new Set([
  "factory", "trader", "supply_chain",
  "broker_factory", "broker_customer", "broker_supply",
  "platform_finance", "platform_admin",
]);
var SC_TYPE_ENUM = new Set([
  "customs", "trucking", "warehouse", "inspection",
  "quality_lab", "insurance", "packaging",
  "raw_material", "brand_authorization",
]);

function envelopeOk(data, extra) {
  return Object.assign(
    { success: true, data: data || [], count: Array.isArray(data) ? data.length : 0, next_cursor: null },
    extra || {}
  );
}

function envelopeErr(error, message, status, details) {
  return {
    status: status,
    body: {
      success: false,
      error: error,
      message: message,
      details: details || null,
    },
  };
}

// Detect whether a regclass exists. Returns boolean.
// Uses to_regclass which returns NULL instead of throwing.
async function tableExists(pool, qualifiedName) {
  try {
    var r = await pool.query("SELECT to_regclass($1) AS oid", [qualifiedName]);
    return !!(r && r.rows && r.rows[0] && r.rows[0].oid);
  } catch (e) {
    return false;
  }
}

// ── Canonical reader: credential_types ───────────────────────────────
async function readCanonical(pool, filters) {
  var where = [];
  var params = [];
  function add(clause, value) {
    params.push(value);
    where.push(clause.replace("$$", "$" + params.length));
  }

  // status default 'active' unless caller explicitly asks otherwise
  add("status = $$", filters.status || "active");

  if (filters.category)          add("category = $$", filters.category);
  if (filters.role)              add("$$ = ANY(applies_to_roles)", filters.role);
  if (filters.supply_chain_type) add("$$ = ANY(applies_to_supply_chain_types)", filters.supply_chain_type);

  var sql =
    "SELECT id, code, name_cn, name_en, category, " +
    "       applies_to_roles, applies_to_supply_chain_types, " +
    "       is_required_default, validity_required, file_required, " +
    "       default_sensitivity, sort_order, status, created_at, updated_at " +
    "FROM credential_types " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    "ORDER BY sort_order, code";

  var r = await pool.query(sql, params);
  return r.rows;
}

// ── Legacy reader: cert_type_config (Stage 2C §8 compat read) ────────
// Maps legacy column names into the canonical shape so callers see the
// same fields regardless of source.
async function readLegacy(pool, filters) {
  var where = [];
  var params = [];
  function add(clause, value) {
    params.push(value);
    where.push(clause.replace("$$", "$" + params.length));
  }

  // legacy uses `active BOOLEAN` instead of status enum
  if (!filters.status || filters.status === "active") {
    where.push("active = true");
  } else if (filters.status === "inactive" || filters.status === "deprecated") {
    where.push("active = false");
  }

  if (filters.role) add("$$ = ANY(company_roles)", filters.role);
  // legacy has no category / supply_chain_type — silently ignore those filters

  var sql =
    "SELECT id, cert_key AS code, cert_name_cn AS name_cn, cert_name_en AS name_en, " +
    "       company_roles AS applies_to_roles, " +
    "       sort_order, active, created_at " +
    "FROM cert_type_config " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    "ORDER BY sort_order, cert_key";

  var r = await pool.query(sql, params);
  return r.rows.map(function (row) {
    return {
      id: row.id,
      code: row.code,
      name_cn: row.name_cn,
      name_en: row.name_en || null,
      category: "other",  // legacy has no category; default
      applies_to_roles: row.applies_to_roles || [],
      applies_to_supply_chain_types: [],
      is_required_default: null,
      validity_required: null,
      file_required: null,
      default_sensitivity: "business_confidential",  // safe default
      sort_order: row.sort_order,
      status: row.active ? "active" : "inactive",
      created_at: row.created_at,
      updated_at: row.created_at,
    };
  });
}

function parseFilters(query) {
  var q = query || {};
  var errors = [];

  if (q.status !== undefined && !STATUS_ENUM.has(q.status)) {
    errors.push({ field: "status", message: "unknown status value" });
  }
  if (q.category !== undefined && !CATEGORY_ENUM.has(q.category)) {
    errors.push({ field: "category", message: "unknown category value" });
  }
  if (q.role !== undefined && !ROLE_ENUM.has(q.role)) {
    errors.push({ field: "role", message: "unknown role value" });
  }
  if (q.supply_chain_type !== undefined && !SC_TYPE_ENUM.has(q.supply_chain_type)) {
    errors.push({ field: "supply_chain_type", message: "unknown supply_chain_type value" });
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    filters: {
      status: q.status,
      category: q.category,
      role: q.role,
      supply_chain_type: q.supply_chain_type,
    },
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ success: false, error: "unauthorized", message: "JWT required" });

  // ── Read-only stage: any mutation is explicitly not implemented ──
  if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
    var err = envelopeErr(
      "not_implemented",
      "/api/db/credential-types write paths are not implemented in Stage 3 Phase 1. " +
      "See docs/blueprints/COMPANY-CREDENTIALS-STAGE2C-API-CONTRACT.md §5.3.",
      405,
      { allowed_methods: ["GET", "OPTIONS"] }
    );
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(err.status).json(err.body);
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ success: false, error: "method_not_allowed", message: "Method not allowed" });
  }

  // ── Filter validation ────────────────────────────────────────────
  var parsed = parseFilters(req.query);
  if (!parsed.ok) {
    return res.status(400).json({
      success: false,
      error: "validation_failed",
      message: "One or more query parameters are invalid",
      details: parsed.errors,
    });
  }

  // ── Source selection ─────────────────────────────────────────────
  var pool = getPool();
  var hasCanonical, hasLegacy;
  try {
    hasCanonical = await tableExists(pool, "credential_types");
    hasLegacy    = await tableExists(pool, "cert_type_config");
  } catch (e) {
    return res.status(503).json({
      success: false,
      error: "db_unavailable",
      message: "Database connection check failed",
      details: { reason: e && e.message },
    });
  }

  if (!hasCanonical && !hasLegacy) {
    // Stage 2B drafts not yet promoted AND no legacy table — graceful 503.
    return res.status(503).json({
      success: false,
      error: "credential_types_not_ready",
      message:
        "Neither the canonical credential_types table nor the legacy " +
        "cert_type_config table is present on this server. Stage 2B schema " +
        "draft promotion is pending.",
      details: { canonical_present: false, legacy_present: false },
    });
  }

  // ── Read ─────────────────────────────────────────────────────────
  var source, rows;
  try {
    if (hasCanonical) {
      source = "canonical";
      rows   = await readCanonical(pool, parsed.filters);
    } else {
      source = "legacy_compat";
      rows   = await readLegacy(pool, parsed.filters);
    }
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "Failed to read credential types",
      details: { source: source, reason: e && e.message },
    });
  }

  return res.status(200).json(envelopeOk(rows, {
    source: source,
    filters_applied: parsed.filters,
  }));
}
