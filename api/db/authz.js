import { getPool } from "../db.js";

function pushCandidate(out, seen, sourceSystem, identityType, value, label) {
  if (value === undefined || value === null || value === "") return;
  const identityKey = String(value).trim();
  if (!identityKey) return;
  const k = `${sourceSystem}:${identityType}:${identityKey.toLowerCase()}`;
  if (seen.has(k)) return;
  seen.add(k);
  out.push({ source_system: sourceSystem, identity_type: identityType, identity_key: identityKey, label });
}

export function identityCandidatesFromRequest(req) {
  const out = [];
  const seen = new Set();
  const user = req?.user || {};
  pushCandidate(out, seen, "backend", "user_id", user.uid || user.id || user.sub, "req.user.uid/id/sub");
  pushCandidate(out, seen, "backend", "username", user.username || user.account, "req.user.username/account");
  pushCandidate(out, seen, "hr", "employee_id", user.employee_id || user.employeeId, "req.user.employee_id");

  const headers = req?.headers || {};
  pushCandidate(out, seen, "clerk", "clerk_user", headers["x-clerk-user-id"], "x-clerk-user-id");
  pushCandidate(out, seen, "clerk", "session_user", headers["x-clerk-session-user"], "x-clerk-session-user");
  pushCandidate(out, seen, "clerk", "session_user", headers["x-session-user"], "x-session-user");
  return out;
}

async function writeUnmappedAudit(pool, req, candidates) {
  try {
    await pool.query(
      `INSERT INTO authz_audit_log(action, source, detail)
       VALUES ($1, $2::jsonb, $3::jsonb)`,
      [
        "authz.resolve_unmapped",
        JSON.stringify({
          path: req?.path || req?.url || null,
          method: req?.method || null,
          ip: req?.ip || req?.headers?.["x-forwarded-for"] || null,
        }),
        JSON.stringify({ candidates }),
      ]
    );
  } catch (err) {
    console.warn("[authz] unmapped audit failed:", err.message);
  }
}

export async function resolvePerson(req, options = {}) {
  const pool = options.pool || getPool();
  const candidates = options.candidates || identityCandidatesFromRequest(req);
  if (!candidates.length) {
    if (options.audit !== false) await writeUnmappedAudit(pool, req, []);
    return null;
  }

  const values = [];
  const tuples = [];
  candidates.forEach((c, i) => {
    const base = i * 3;
    values.push(c.source_system, c.identity_type, c.identity_key);
    tuples.push(`($${base + 1}, $${base + 2}, lower($${base + 3}))`);
  });

  const identitySql = `
    WITH candidate(source_system, identity_type, identity_key) AS (
      VALUES ${tuples.join(",")}
    )
    SELECT pi.person_id, pi.source_system, pi.identity_type, pi.identity_key, pi.display_label
      FROM candidate c
      JOIN person_identities pi
        ON pi.source_system = c.source_system
       AND pi.identity_type = c.identity_type
       AND lower(pi.identity_key) = c.identity_key
       AND pi.is_active
     ORDER BY pi.identity_id
     LIMIT 1`;
  const identity = (await pool.query(identitySql, values)).rows[0];
  if (!identity) {
    if (options.audit !== false) await writeUnmappedAudit(pool, req, candidates);
    return null;
  }

  const rows = (await pool.query(
    `SELECT p.person_id, p.display_name, ph.hat_code, hc.capability, hc.constraints
       FROM people p
       JOIN person_hats ph ON ph.person_id = p.person_id
        AND ph.valid_from <= now()
        AND (ph.valid_until IS NULL OR ph.valid_until > now())
       JOIN hats h ON h.hat_code = ph.hat_code AND h.is_active
  LEFT JOIN hat_capabilities hc ON hc.hat_code = ph.hat_code
      WHERE p.person_id = $1
      ORDER BY ph.hat_code, hc.capability`,
    [identity.person_id]
  )).rows;

  const hats = [];
  const caps = [];
  const source = {
    identity: {
      source_system: identity.source_system,
      identity_type: identity.identity_type,
      identity_key: identity.identity_key,
      display_label: identity.display_label,
    },
    hats: {},
    caps: {},
  };
  const hatSeen = new Set();
  const capSeen = new Set();

  for (const row of rows) {
    if (!hatSeen.has(row.hat_code)) {
      hatSeen.add(row.hat_code);
      hats.push(row.hat_code);
      source.hats[row.hat_code] = { person_id: row.person_id };
    }
    if (!row.capability) continue;
    if (!capSeen.has(row.capability)) {
      capSeen.add(row.capability);
      caps.push(row.capability);
      source.caps[row.capability] = [];
    }
    source.caps[row.capability].push({
      hat_code: row.hat_code,
      constraints: row.constraints || {},
    });
  }

  return {
    person_id: identity.person_id,
    display_name: rows[0]?.display_name || identity.display_label || null,
    hats,
    caps,
    source,
  };
}

export function capSources(resolved, capability) {
  return resolved?.source?.caps?.[capability] || [];
}
