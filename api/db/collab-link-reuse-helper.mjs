// collab-link-reuse-helper.mjs
// 本轮只造不接线：纯只读 helper，不 mint、不延期、不写库。

const SCOPE_KEYS = [
  "bl_no",
  "company_code",
  "container_nos",
  "contract_no",
  "factory_code",
  "factory_scope",
  "field_profile",
  "order_no",
  "segments",
  "shipment_id",
  "stage",
  "view",
];
const LOWER_KEYS = new Set(["company_code", "factory_code", "bl_no", "order_no", "contract_no"]);
const PREFIX = "scope:v1:";

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

function cleanScalar(key, value) {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    return LOWER_KEYS.has(key) ? s.toLowerCase() : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function cleanArray(key, value) {
  const items = value
    .map(v => cleanScalar(key, v))
    .filter(v => v !== undefined)
    .map(v => String(v));
  return Array.from(new Set(items)).sort();
}

// factory_scope is an object; only its stable {label, code, id} subset defines the scope.
function cleanFactoryScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  const label = cleanScalar("factory_scope_label", value.label);
  if (label !== undefined) out.label = label;
  const code = cleanScalar("factory_code", value.code); // reuse code lowercasing
  if (code !== undefined) out.code = code;
  if (value.id != null && value.id !== "") {
    const id = Number(value.id);
    if (Number.isFinite(id)) out.id = id;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeScope(meta) {
  const source = parseMeta(meta);
  const stable = {};
  for (const key of SCOPE_KEYS) {
    const value = source[key];
    if (key === "factory_scope") {
      const fs = cleanFactoryScope(value);
      if (fs !== undefined) stable[key] = fs;
      continue;
    }
    if (Array.isArray(value)) {
      const arr = cleanArray(key, value);
      if (arr.length) stable[key] = arr;
      continue;
    }
    const scalar = cleanScalar(key, value);
    if (scalar !== undefined) stable[key] = scalar;
  }
  return PREFIX + JSON.stringify(stable);
}

export async function findReusableLink(pool, recipientRole, scopeMeta) {
  if (!pool || !recipientRole) return null;
  const wanted = normalizeScope(scopeMeta);
  const r = await pool.query(
    `SELECT id, recipient_role, meta, created_at, created_by, expires_at, revoked_at, used_at
       FROM magic_links
      WHERE recipient_role = $1
        AND revoked_at IS NULL
        AND COALESCE(revoked,false) = false
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1000`,
    [recipientRole]
  );
  for (const row of r.rows || []) {
    if (normalizeScope(row.meta) === wanted) return row;
  }
  return null;
}
