const EMPTY_RESULT = {
  port_id: null,
  code: null,
  unlocode: null,
  canonical_name: null,
  parent_port_id: null,
  parent_code: null,
  ambiguous: false,
  candidates: [],
  confidence: "none",
  status: "unknown",
};

export function normalizeAlias(text) {
  let value = String(text || "").trim().toUpperCase();
  if (!value) return "";
  value = value.replace(/\([^)]*\)/g, "");
  value = value.replace(/\[[^\]]*\]/g, "");
  value = value.replace(/\bP\.?\s*KL(?:A|G)?\b/g, "PORT KLANG");
  value = value.replace(/\bPKG\b/g, "PORT KLANG");
  value = value.replace(/\bKELANG\b/g, "KLANG");
  value = value.replace(/\bWEST\s+PORT\b/g, "WESTPORT");
  value = value.replace(/\bNORTH\s+PORT\b/g, "NORTHPORT");
  value = value.replace(/[,\./_]+/g, " ");
  return value.replace(/[\s-]+/g, "");
}

function baseResult(input, normalizedInput) {
  return {
    input,
    normalized_input: normalizedInput,
    ...EMPTY_RESULT,
  };
}

function rowName(row) {
  return row?.name_en || row?.name_cn || row?.code || null;
}

function toResolved(input, normalizedInput, row, confidence) {
  return {
    input,
    normalized_input: normalizedInput,
    port_id: row.id,
    code: row.code,
    unlocode: row.unlocode || null,
    canonical_name: rowName(row),
    parent_port_id: row.parent_port_id || null,
    parent_code: row.parent_code || null,
    ambiguous: false,
    candidates: [],
    confidence,
    status: "resolved",
  };
}

function candidateRow(row) {
  return {
    port_id: row.id,
    code: row.code,
    name: rowName(row),
  };
}

function uniqueByPort(rows) {
  const seen = new Set();
  return rows.filter(row => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

async function childrenFor(pool, parentId) {
  const { rows } = await pool.query(
    `SELECT id, code, name_en, name_cn
       FROM ports
      WHERE parent_port_id = $1
      ORDER BY code`,
    [parentId]
  );
  return rows;
}

async function finalizeMatch(pool, input, normalizedInput, row, confidence) {
  const children = row.requires_terminal ? await childrenFor(pool, row.id) : [];
  if (row.requires_terminal && children.length) {
    return {
      input,
      normalized_input: normalizedInput,
      port_id: row.id,
      code: row.code,
      unlocode: row.unlocode || null,
      canonical_name: rowName(row),
      parent_port_id: row.parent_port_id || null,
      parent_code: row.parent_code || null,
      ambiguous: true,
      candidates: children.map(candidateRow),
      confidence,
      status: "ambiguous",
    };
  }
  return toResolved(input, normalizedInput, row, confidence);
}

async function findPortExact(pool, normalizedInput) {
  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.unlocode, p.name_en, p.name_cn, p.parent_port_id,
            p.requires_terminal, parent.code AS parent_code
       FROM ports p
       LEFT JOIN ports parent ON parent.id = p.parent_port_id
      ORDER BY p.code`
  );
  return rows.find(row => {
    return [
      row.code,
      row.unlocode,
      row.name_en,
      row.name_cn,
    ].some(value => normalizeAlias(value) === normalizedInput);
  }) || null;
}

async function findPortAlias(pool, normalizedInput) {
  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.unlocode, p.name_en, p.name_cn, p.parent_port_id,
            p.requires_terminal, parent.code AS parent_code
       FROM port_aliases a
       JOIN ports p ON p.id = a.port_id
       LEFT JOIN ports parent ON parent.id = p.parent_port_id
      WHERE a.is_active IS TRUE
        AND a.normalized_alias = $1
      ORDER BY p.requires_terminal DESC, p.code`,
    [normalizedInput]
  );
  return uniqueByPort(rows);
}

export async function resolvePort(pool, text, opts = {}) {
  const input = text == null ? "" : String(text);
  const normalizedInput = normalizeAlias(input);
  if (!pool || !normalizedInput) return baseResult(input, normalizedInput);

  const exact = await findPortExact(pool, normalizedInput);
  if (exact) return finalizeMatch(pool, input, normalizedInput, exact, "exact");

  const aliases = await findPortAlias(pool, normalizedInput);
  if (aliases.length === 1) return finalizeMatch(pool, input, normalizedInput, aliases[0], "alias");
  if (aliases.length > 1) {
    return {
      ...baseResult(input, normalizedInput),
      ambiguous: true,
      candidates: aliases.map(candidateRow),
      confidence: "alias",
      status: "ambiguous",
    };
  }

  return baseResult(input, normalizedInput);
}

export async function resolvePortPair(pool, pol, pod, opts = {}) {
  const [polResult, podResult] = await Promise.all([
    resolvePort(pool, pol, opts),
    resolvePort(pool, pod, opts),
  ]);
  return { pol: polResult, pod: podResult };
}
