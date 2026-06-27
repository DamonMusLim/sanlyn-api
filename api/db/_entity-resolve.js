import { getPool } from "../db.js";

/**
 * 统一公司实体解析模块。
 *
 * 用法约定：
 * - soft 来源：manual/excel。解析不到时，调用方可以提示建议并允许 forced，但必须 recordResolution。
 * - hard 来源：ai/ocr/script。解析不到时，调用方应拒绝写入或进待处理队列，不允许写自由文本。
 * - AI 当前只建议不落库：AI/OCR 结果只 recordResolution；只有人确认或可信自动规则确认后，才 learnAlias。
 */

const HARD_SOURCES = new Set(["ai", "ocr", "script"]);
const SOFT_SOURCES = new Set(["manual", "excel"]);

const ROLE_TYPE_MAP = {
  forwarder: ["forwarder"],
  customer: ["customer"],
  factory: ["factory"],
  supplier: ["factory"],
  trucking: ["trucking"],
  customs_broker: ["customs_broker"],
  sanlyn_entity: ["sanlyn_entity"],
  insurance: ["insurance"],
};

function db(pool) {
  return pool || getPool();
}

function normalizedValue(input) {
  return normalizeText(input).upper;
}

function expectedTypes(role) {
  if (!role) return null;
  if (Array.isArray(role)) return role.filter(Boolean);

  const key = String(role).trim();
  if (!key) return null;

  return ROLE_TYPE_MAP[key] || [key];
}

function companyName(row) {
  return row.name_cn || row.name_en || row.code;
}

function toCandidate(row, score) {
  return {
    code: row.code,
    name: companyName(row),
    type: row.type,
    score,
  };
}

function applyRole(result, role) {
  const expect = expectedTypes(role);
  if (!expect || !result) return result;

  if (result.ok && result.company) {
    if (expect.includes(result.company.type)) return result;

    return {
      ok: false,
      need: "role_mismatch",
      got: {
        code: result.company.code,
        name: companyName(result.company),
        type: result.company.type,
      },
      expect,
      confidence: result.confidence,
      via: result.via,
    };
  }

  if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
    return result;
  }

  const matched = result.candidates.filter((item) => expect.includes(item.type));
  if (matched.length === 1) {
    const company = {
      code: matched[0].code,
      name_cn: matched[0].name,
      type: matched[0].type,
    };

    return {
      ok: true,
      company,
      confidence: matched[0].score,
      via: result.via || "fuzzy",
    };
  }

  if (matched.length > 1) {
    return {
      ...result,
      candidates: matched,
      confidence: matched[0]?.score || result.confidence,
    };
  }

  return {
    ok: false,
    need: "role_mismatch",
    got: result.candidates.map((item) => ({
      code: item.code,
      name: item.name,
      type: item.type,
    })),
    expect,
    confidence: result.confidence,
    via: result.via,
  };
}

function fuzzyScore(row, normalizedQuery) {
  const cn = normalizedValue(row.name_cn);
  const en = normalizedValue(row.name_en);

  if (cn === normalizedQuery || en === normalizedQuery) return 0.88;
  if (cn.startsWith(normalizedQuery) || en.startsWith(normalizedQuery)) return 0.82;
  if (cn.includes(normalizedQuery) || en.includes(normalizedQuery)) return 0.76;

  return 0.7;
}

export function normalizeText(s) {
  const raw = s == null ? "" : String(s);
  const normalized = raw
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\u3000/g, " ")
    .trim()
    .replace(/\s+/g, "");

  return {
    raw,
    normalized,
    upper: normalized.toUpperCase(),
  };
}

export function enforcementMode(sourceType) {
  const source = String(sourceType || "").toLowerCase();

  if (SOFT_SOURCES.has(source)) return "soft";
  if (HARD_SOURCES.has(source)) return "hard";

  return "hard";
}

export async function resolveCompany(pool, query, opts = {}) {
  const conn = db(pool);
  const normalized = normalizeText(query);
  const q = normalized.upper;

  if (!q) {
    return {
      ok: false,
      need: "create_company",
      query,
    };
  }

  const codeResult = await conn.query(
    `
      SELECT code, name_cn, name_en, type, merged_into_code
      FROM companies
      WHERE upper(code) = $1
      LIMIT 2
    `,
    [q],
  );

  if (codeResult.rows.length === 1) {
    let row = codeResult.rows[0];
    let via = "code";
    // 收尾(Claude 2026-06-28):若该码已被合并,自动跳转到canonical公司码。
    // 旧码不物理删,靠 merged_into_code 重定向,输 LL 自动认 VEN-LL。
    if (row.merged_into_code) {
      const canon = await conn.query(
        `SELECT code, name_cn, name_en, type FROM companies WHERE upper(code) = $1 LIMIT 1`,
        [String(row.merged_into_code).toUpperCase()],
      );
      if (canon.rows.length === 1) { row = canon.rows[0]; via = "merge_redirect"; }
    }
    return applyRole(
      { ok: true, company: row, confidence: 1, via },
      opts.role,
    );
  }

  const aliasResult = await conn.query(
    `
      SELECT c.code, c.name_cn, c.name_en, c.type, a.confidence
      FROM company_aliases a
      JOIN companies c ON c.code = a.company_code
      WHERE a.normalized_alias = $1
        AND a.status = 'active'
      LIMIT 2
    `,
    [q],
  );

  if (aliasResult.rows.length === 1) {
    const row = aliasResult.rows[0];

    return applyRole(
      {
        ok: true,
        company: {
          code: row.code,
          name_cn: row.name_cn,
          name_en: row.name_en,
          type: row.type,
        },
        confidence: Number(row.confidence ?? 0.95),
        via: "alias",
      },
      opts.role,
    );
  }

  if (aliasResult.rows.length > 1) {
    const candidates = aliasResult.rows.map((row) =>
      toCandidate(row, Number(row.confidence ?? 0.92)),
    );

    return applyRole(
      {
        ok: false,
        need: "disambiguate",
        candidates,
        confidence: candidates[0]?.score || 0.9,
        via: "alias",
      },
      opts.role,
    );
  }

  const fuzzyResult = await conn.query(
    `
      SELECT code, name_cn, name_en, type
      FROM companies
      WHERE
        upper(
          regexp_replace(
            replace(replace(replace(coalesce(name_cn, ''), '（', '('), '）', ')'), '　', ' '),
            '\\s+',
            '',
            'g'
          )
        ) ILIKE $1
        OR upper(
          regexp_replace(
            replace(replace(replace(coalesce(name_en, ''), '（', '('), '）', ')'), '　', ' '),
            '\\s+',
            '',
            'g'
          )
        ) ILIKE $1
      ORDER BY code
      LIMIT 20
    `,
    [`%${q}%`],
  );

  if (fuzzyResult.rows.length === 0) {
    return {
      ok: false,
      need: "create_company",
      query,
    };
  }

  const candidates = fuzzyResult.rows
    .map((row) => toCandidate(row, fuzzyScore(row, q)))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 1) {
    const row = fuzzyResult.rows[0];

    return applyRole(
      {
        ok: true,
        company: row,
        confidence: candidates[0].score,
        via: "fuzzy",
      },
      opts.role,
    );
  }

  return applyRole(
    {
      ok: false,
      need: "disambiguate",
      candidates,
      confidence: candidates[0]?.score || 0.7,
      via: "fuzzy",
    },
    opts.role,
  );
}

export async function recordResolution(
  pool,
  {
    domain_key,
    source_type,
    entity_type,
    raw_text,
    candidates,
    suggested_company_code,
    confidence,
    chosen_company_code,
    outcome,
    enforcement,
    is_critical,
    reviewed_by,
  },
) {
  const conn = db(pool);
  const normalized = normalizeText(raw_text);

  const result = await conn.query(
    `
      INSERT INTO entity_resolution_log (
        domain_key,
        source_type,
        entity_type,
        raw_text,
        normalized_text,
        candidates,
        suggested_company_code,
        confidence,
        chosen_company_code,
        outcome,
        is_critical,
        enforcement,
        reviewed_by
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `,
    [
      domain_key,
      source_type,
      entity_type,
      raw_text,
      normalized.upper,
      JSON.stringify(candidates || []),
      suggested_company_code,
      confidence,
      chosen_company_code,
      outcome,
      Boolean(is_critical),
      enforcement || enforcementMode(source_type),
      reviewed_by,
    ],
  );

  return result.rows[0];
}

export async function learnAlias(
  pool,
  { company_code, alias_text, source, confidence, created_by },
) {
  const conn = db(pool);
  const normalized = normalizeText(alias_text);

  const result = await conn.query(
    `
      INSERT INTO company_aliases (
        company_code,
        alias_text,
        normalized_alias,
        source,
        confidence,
        status,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6)
      ON CONFLICT (normalized_alias)
      DO UPDATE SET
        alias_text = EXCLUDED.alias_text,
        source = coalesce(EXCLUDED.source, company_aliases.source),
        confidence = greatest(
          coalesce(company_aliases.confidence, 0),
          coalesce(EXCLUDED.confidence, 0)
        ),
        status = 'active',
        created_by = coalesce(EXCLUDED.created_by, company_aliases.created_by)
      WHERE company_aliases.company_code = EXCLUDED.company_code
      RETURNING id, company_code, alias_text, normalized_alias, confidence, status
    `,
    [
      company_code,
      alias_text,
      normalized.upper,
      source,
      confidence,
      created_by,
    ],
  );

  if (result.rows[0]) {
    return {
      ok: true,
      alias: result.rows[0],
    };
  }

  const conflict = await conn.query(
    `
      SELECT id, company_code, alias_text, normalized_alias, confidence, status
      FROM company_aliases
      WHERE normalized_alias = $1
      LIMIT 1
    `,
    [normalized.upper],
  );

  return {
    ok: false,
    conflict: true,
    alias: conflict.rows[0],
  };
}

export function confidenceTier(score) {
  const value = Number(score || 0);

  if (value >= 0.9) return "auto";
  if (value >= 0.7) return "confirm";

  return "manual";
}
