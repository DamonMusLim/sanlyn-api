// api/lib/sc-field-policy-helper.js
//
// JS port of app/components/src/permission/fieldPolicy.ts
//
// Implements:
//   JDY_MIGRATION_ENDPOINTS — legacy endpoints that get warn+strip in production
//   applyAliasMap(body, aliasMap, endpoint) → { body, deprecatedFields }
//   enforceFieldPolicy(allowedSet, body, endpoint) → void  (throws on violation)
//
// Step 1: applyAliasMap — rename deprecated keys to canonical before whitelist check
// Step 2: enforceFieldPolicy — reject unknown fields (400) or warn+strip (JDY prod only)
//
// Errors thrown:
//   { code: 'MISSING_FIELD_WHITELIST', status: 500, endpoint }
//   { code: 'UNKNOWN_FIELD',           status: 400, fields: [...], endpoint }

export const JDY_MIGRATION_ENDPOINTS = new Set([
  'products_PUT',
  'products_PATCH',
  'orders_PATCH',
]);

/**
 * Rename deprecated field keys to canonical equivalents before whitelist validation.
 * Returns a shallow copy of body — does NOT mutate the original.
 *
 * @param {Record<string,unknown>} body
 * @param {Array<{deprecated:string, canonical:string, endpoint?:string}>} aliasMap
 * @param {string} endpoint
 * @returns {{ body: Record<string,unknown>, deprecatedFields: Array<{sent,use}> }}
 */
export function applyAliasMap(body, aliasMap, endpoint) {
  const result = Object.assign({}, body);
  const deprecatedFields = [];

  for (const entry of aliasMap) {
    if (entry.endpoint && entry.endpoint !== endpoint) continue;
    if (!Object.prototype.hasOwnProperty.call(result, entry.deprecated)) continue;

    if (!Object.prototype.hasOwnProperty.call(result, entry.canonical)) {
      result[entry.canonical] = result[entry.deprecated];
    }
    delete result[entry.deprecated];
    deprecatedFields.push({ sent: entry.deprecated, use: entry.canonical });
  }

  return { body: result, deprecatedFields };
}

/**
 * Assert all keys in body are in allowedSet.
 *
 * @param {Set<string>|undefined|null} allowedSet
 * @param {Record<string,unknown>}     body
 * @param {string}                     endpoint
 * @throws {{ code: 'MISSING_FIELD_WHITELIST', status: 500 }}
 * @throws {{ code: 'UNKNOWN_FIELD', status: 400, fields: string[], endpoint: string }}
 */
export function enforceFieldPolicy(allowedSet, body, endpoint) {
  if (!(allowedSet instanceof Set)) {
    const err = new Error('Missing field whitelist for endpoint: ' + endpoint);
    err.code     = 'MISSING_FIELD_WHITELIST';
    err.status   = 500;
    err.endpoint = endpoint;
    throw err;
  }

  const unknown = Object.keys(body).filter(k => !allowedSet.has(k));
  if (unknown.length === 0) return;

  const isJdyEndpoint = JDY_MIGRATION_ENDPOINTS.has(endpoint);
  const isProduction  = process.env.NODE_ENV === 'production';

  if (isJdyEndpoint && isProduction) {
    console.warn(
      '[sc-field-policy] JDY migration endpoint "%s" — stripping unknown fields: %j',
      endpoint, unknown,
    );
    for (const k of unknown) delete body[k];
    return;
  }

  const err = new Error('Unknown field(s) in request: ' + unknown.join(', '));
  err.code     = 'UNKNOWN_FIELD';
  err.status   = 400;
  err.fields   = unknown;
  err.endpoint = endpoint;
  throw err;
}
