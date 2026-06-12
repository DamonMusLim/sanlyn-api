// customs-ai-audit.js — AI 报关审核 · 建议接口
//
// GET /api/db/customs-ai-audit?sku=CP0702
//   → 对比产品当前报关字段 vs customs_knowledge 建议值
//   → 返回逐字段建议 (suggestion only, 不自动写)
//
// GET /api/db/customs-ai-audit?action=stats
//   → 知识库统计 (总条目/文件数/平均置信度)
//
// GET /api/db/customs-ai-audit?action=search&q=猫砂
//   → 按 declaration_name ILIKE 模糊匹配知识库
//
import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

// ── Normalise helpers ─────────────────────────────────────────────────────────

function normaliseHs(hs) {
  return (hs || "").replace(/\D/g, "").slice(0, 10);
}

function normaliseElements(raw) {
  if (!raw) return [];
  return raw.split("|").map(s => s.trim()).filter(Boolean).sort();
}

function elementsMatch(a, b) {
  const na = normaliseElements(a);
  const nb = normaliseElements(b);
  if (na.length !== nb.length) return false;
  return na.every((v, i) => v === nb[i]);
}

function elementsDiffSummary(current, suggested) {
  const nc = normaliseElements(current);
  const ns = normaliseElements(suggested);
  const missing  = ns.filter(x => !nc.includes(x));
  const extra    = nc.filter(x => !ns.includes(x));
  const parts = [];
  if (missing.length) parts.push(`缺少: ${missing.slice(0, 3).join("; ")}`);
  if (extra.length)   parts.push(`多余: ${extra.slice(0, 3).join("; ")}`);
  return parts.join(" / ") || "内容不一致";
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const authErr = requireAuth(req, res);
  if (authErr) return;

  const pool   = getPool();
  const action = req.query?.action;

  // ── stats ──────────────────────────────────────────────────────────────────
  if (action === "stats") {
    try {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM customs_knowledge)::int          AS knowledge_entries,
          (SELECT COUNT(*) FROM customs_reference WHERE status='done')::int AS source_docs,
          (SELECT ROUND(AVG(confidence)::numeric,2) FROM customs_knowledge)::float AS avg_confidence,
          (SELECT MAX(last_seen_at) FROM customs_knowledge)      AS last_updated
      `);
      return res.status(200).json({ ok: true, stats: rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────
  if (action === "search") {
    const q = (req.query?.q || "").trim();
    if (!q) return res.status(400).json({ error: "q required" });
    try {
      const { rows } = await pool.query(`
        SELECT declaration_name, hs_code, declaration_elements, origin_country,
               doc_count, confidence, keywords
        FROM customs_knowledge
        WHERE declaration_name ILIKE $1
        ORDER BY doc_count DESC, confidence DESC
        LIMIT 20
      `, [`%${q}%`]);
      return res.status(200).json({ ok: true, results: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── per-SKU audit ──────────────────────────────────────────────────────────
  const sku = (req.query?.sku || "").trim();
  if (!sku) return res.status(400).json({ error: "sku or action required" });

  try {
    // 1. Fetch current product
    const prodRes = await pool.query(`
      SELECT sku, declaration_name, hs_code, declaration_elements, origin_country,
             product_name
      FROM products
      WHERE sku = $1
      LIMIT 1
    `, [sku]);

    if (!prodRes.rows.length) {
      return res.status(404).json({ error: `SKU not found: ${sku}` });
    }
    const prod = prodRes.rows[0];

    // 2. Lookup knowledge — try exact hs_code first, then declaration_name ILIKE
    let know = null;
    let matchMethod = null;

    if (prod.hs_code) {
      const normHs = normaliseHs(prod.hs_code);
      const r = await pool.query(`
        SELECT * FROM customs_knowledge
        WHERE REGEXP_REPLACE(hs_code, '[^0-9]', '', 'g') = $1
        ORDER BY doc_count DESC, confidence DESC
        LIMIT 1
      `, [normHs]);
      if (r.rows.length) { know = r.rows[0]; matchMethod = "hs_code"; }
    }

    if (!know && prod.declaration_name) {
      const r = await pool.query(`
        SELECT * FROM customs_knowledge
        WHERE declaration_name ILIKE $1
        ORDER BY doc_count DESC, confidence DESC
        LIMIT 1
      `, [`%${prod.declaration_name}%`]);
      if (r.rows.length) { know = r.rows[0]; matchMethod = "declaration_name"; }
    }

    if (!know && prod.product_name) {
      const r = await pool.query(`
        SELECT * FROM customs_knowledge
        WHERE $1 ILIKE '%' || split_part(declaration_name, ' ', 1) || '%'
           OR declaration_name ILIKE $2
        ORDER BY doc_count DESC, confidence DESC
        LIMIT 1
      `, [prod.product_name, `%${(prod.product_name || "").slice(0, 6)}%`]);
      if (r.rows.length) { know = r.rows[0]; matchMethod = "product_name"; }
    }

    if (!know) {
      return res.status(200).json({
        ok: true,
        sku,
        product_name: prod.product_name,
        match_method: null,
        overall_status: "null",
        message: "knowledge base 中暂无匹配记录",
        fields: {},
      });
    }

    // 3. Build field suggestions
    const FIELDS = [
      { key: "declaration_name", label: "报关品名" },
      { key: "hs_code",          label: "HS 编码" },
      { key: "declaration_elements", label: "申报要素" },
      { key: "origin_country",   label: "产地" },
    ];

    const fields = {};
    let warnCount = 0;
    let errorCount = 0;

    for (const f of FIELDS) {
      const curr = prod[f.key] || "";
      const sugg = know[f.key] || "";

      let match = false;
      let diff  = null;

      if (f.key === "hs_code") {
        match = normaliseHs(curr) === normaliseHs(sugg);
        diff  = match ? null : `当前: ${curr || "—"} → 建议: ${sugg}`;
      } else if (f.key === "declaration_elements") {
        match = elementsMatch(curr, sugg);
        diff  = match ? null : elementsDiffSummary(curr, sugg);
      } else {
        match = (curr.trim().toLowerCase() === sugg.trim().toLowerCase());
        diff  = match ? null : `当前: ${curr || "—"} → 建议: ${sugg}`;
      }

      // Severity
      let severity = "ok";
      if (!match) {
        if (!curr) severity = "error";        // field empty, KB has value
        else       severity = "warn";         // field filled but differs
        if (severity === "error") errorCount++;
        else warnCount++;
      }

      fields[f.key] = {
        label:       f.label,
        current:     curr,
        suggested:   sugg,
        match,
        severity,
        diff,
        confidence:  parseFloat(know.confidence) || 0,
        doc_count:   know.doc_count || 0,
      };
    }

    const overall_status =
      errorCount > 0 ? "error" :
      warnCount  > 0 ? "warn"  : "ok";

    return res.status(200).json({
      ok: true,
      sku,
      product_name: prod.product_name,
      match_method: matchMethod,
      knowledge_entry: {
        declaration_name: know.declaration_name,
        hs_code:          know.hs_code,
        doc_count:        know.doc_count,
        confidence:       parseFloat(know.confidence),
        keywords:         know.keywords || [],
      },
      overall_status,
      fields,
    });
  } catch (err) {
    console.error("[customs-ai-audit]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
