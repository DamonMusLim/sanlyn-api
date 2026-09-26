const CACHE_TTL_MS = 60_000;

let cache = { at: 0, rows: null };

export function normName(s) {
  if (s == null) return "";
  return String(s)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[()（）[\]【】{}<>《》.,，。;；:：'"“”‘’`~!！?？/\\|、\-_\u2010-\u2015+*&^%$#@=]/g, "")
    .toLowerCase()
    .replace(/(有限责任公司|股份有限公司|有限公司|股份|集团|国际|货运代理|货代|报关代理|报关|物流|供应链|companylimited|coltd|co\.?ltd\.?|ltd\.?|limited)/g, "");
}

export async function loadActiveBlacklist(pool) {
  const now = Date.now();
  if (cache.rows && now - cache.at < CACHE_TTL_MS) return cache.rows;

  const r = await pool.query(
    `SELECT id, name_cn, category
       FROM freight_supplier_blacklist
      WHERE active`
  );
  cache = {
    at: now,
    rows: r.rows.map((row) => ({ ...row, norm: normName(row.name_cn) })),
  };
  return cache.rows;
}

export async function matchBlacklist(pool, name) {
  const nm = normName(name);
  if (nm.length < 2) return null;

  const rows = await loadActiveBlacklist(pool);
  const hit = rows.find((row) => {
    const bn = row.norm || "";
    return bn.length >= 2 && (nm.includes(bn) || bn.includes(nm));
  });
  if (!hit) return null;
  return { id: hit.id, name_cn: hit.name_cn, category: hit.category };
}

export async function partitionCompanyIds(pool, ids) {
  const companyIds = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!companyIds.length) return { allowed: [], blocked: [] };

  const r = await pool.query(
    `SELECT id, COALESCE(name_cn, name_en, code, id::text) nm
       FROM companies
      WHERE id = ANY($1::int[])`,
    [companyIds]
  );

  const blocked = [];
  const blockedIds = new Set();
  for (const row of r.rows) {
    const hit = await matchBlacklist(pool, row.nm);
    if (hit) {
      blockedIds.add(Number(row.id));
      blocked.push({ id: row.id, name: row.nm, hit });
    }
  }

  return {
    allowed: companyIds.filter((id) => !blockedIds.has(id)),
    blocked,
  };
}
