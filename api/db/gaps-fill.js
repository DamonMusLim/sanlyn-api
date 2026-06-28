// api/db/gaps-fill.js — 订单缺失字段快速补档
// GET  /api/db/gaps-fill  → 返回缺失记录 + AI建议值
// PATCH /api/db/gaps-fill → 写回单条字段
import { getPool, setCors } from "../db.js";

const ALLOWED_FIELDS = ["brand", "trade_terms", "company_code"];

// 从订单号提取品牌前缀："42-DG-5" → "DG"，"48-CL-8" → "CL"
function extractBrand(orderNo) {
  if (!orderNo) return null;
  const m = orderNo.match(/^\d+-([A-Z]+)-\d+$/);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── PATCH：写回单条 ────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { order_no, field, value } = req.body || {};
    if (!ALLOWED_FIELDS.includes(field))
      return res.status(400).json({ ok: false, error: `不允许修改字段: ${field}` });
    if (!order_no || value == null || value === "")
      return res.status(400).json({ ok: false, error: "缺少 order_no 或 value" });

    const colMap = { brand: "brand", trade_terms: "trade_terms", company_code: "company_code" };
    await pool.query(`UPDATE orders SET ${colMap[field]}=$1, updated_at=NOW() WHERE order_no=$2`,
      [value.trim(), order_no]);
    return res.json({ ok: true });
  }

  // ── GET：扫描缺口 + 计算建议 ──────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "GET/PATCH only" });

  try {
    // 1. 拉全部缺字段订单
    const { rows: gap } = await pool.query(`
      SELECT order_no, contract_no, customer, company_code, trade_terms, brand
      FROM orders
      WHERE deleted_at IS NULL
        AND (
          company_code IS NULL OR company_code = ''
          OR trade_terms IS NULL OR trade_terms = ''
          OR brand IS NULL OR brand = ''
        )
      ORDER BY order_no DESC
    `);

    // 2. trade_terms 众数：按 company_code 分组，正确写法（子查询 + DISTINCT ON）
    const codesNeedTerms = [...new Set(
      gap.filter(r => (!r.trade_terms) && r.company_code).map(r => r.company_code)
    )];
    let termsModeMap = {};
    if (codesNeedTerms.length) {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (company_code) company_code, trade_terms, cnt
        FROM (
          SELECT company_code, trade_terms, COUNT(*) AS cnt
          FROM orders
          WHERE company_code = ANY($1)
            AND trade_terms IS NOT NULL AND trade_terms != ''
          GROUP BY company_code, trade_terms
        ) sub
        ORDER BY company_code, cnt DESC
      `, [codesNeedTerms]);
      rows.forEach(r => { termsModeMap[r.company_code] = { value: r.trade_terms, cnt: parseInt(r.cnt) }; });
    }

    // 3. company_code 建议：用 customer 字段 ILIKE 匹配 companies.name_en
    const custNeedCode = [...new Set(
      gap.filter(r => (!r.company_code) && r.customer).map(r => r.customer)
    )];
    let codeMap = {};
    if (custNeedCode.length) {
      for (const name of custNeedCode) {
        const keyword = name.split(" ").slice(0, 2).join("%");
        const { rows } = await pool.query(
          `SELECT code FROM companies WHERE name_en ILIKE $1 AND code IS NOT NULL LIMIT 1`,
          [`%${keyword}%`]
        );
        if (rows[0]) codeMap[name] = rows[0].code;
      }
    }

    // 4. 展开每条记录
    const resultRows = [];
    const stats = { brand: 0, trade_terms: 0, company_code: 0 };

    for (const r of gap) {
      if (!r.brand || r.brand === "") {
        stats.brand++;
        const sug = extractBrand(r.order_no);
        resultRows.push({
          order_no: r.order_no,
          contract_no: r.contract_no,
          customer: r.customer || "—",
          field: "brand",
          suggested_value: sug,
          confidence: sug ? "high" : "none",
          reason: sug ? `从订单号前缀推断` : "订单号格式无法推断，请手动填写",
        });
      }
      if (!r.trade_terms || r.trade_terms === "") {
        stats.trade_terms++;
        const hist = termsModeMap[r.company_code];
        resultRows.push({
          order_no: r.order_no,
          contract_no: r.contract_no,
          customer: r.customer || "—",
          field: "trade_terms",
          suggested_value: hist?.value ?? null,
          confidence: hist ? (hist.cnt >= 3 ? "high" : "medium") : "none",
          reason: hist ? `该客户 ${hist.cnt} 单历史均用 ${hist.value}` : "无历史记录，请手动填写",
        });
      }
      if (!r.company_code || r.company_code === "") {
        stats.company_code++;
        const sug = codeMap[r.customer] ?? null;
        resultRows.push({
          order_no: r.order_no,
          contract_no: r.contract_no,
          customer: r.customer || "—",
          field: "company_code",
          suggested_value: sug,
          confidence: sug ? "medium" : "none",
          reason: sug ? `从公司名匹配到 ${sug}` : "未找到匹配公司，请手动填写",
        });
      }
    }

    res.json({ stats, rows: resultRows });
  } catch (e) {
    console.error("[gaps-fill]", e);
    res.status(500).json({ error: e.message });
  }
}
