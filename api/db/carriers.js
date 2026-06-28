// /api/db/carriers.js — 船公司列表（从 shipping_plans 聚合去重）
// GET /api/db/carriers?limit=1000&q=keyword
import { getPool } from "../db.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// 常见船公司代码→全名映射
const CARRIER_NAMES = {
  MSC: "Mediterranean Shipping Company (MSC)",
  COSCO: "COSCO Shipping Lines",
  OOCL: "Orient Overseas Container Line (OOCL)",
  YML: "Yang Ming Marine Transport (YML)",
  SITC: "SITC Container Lines",
  ESL: "Emirates Shipping Line (ESL)",
  CMA: "CMA CGM",
  PIL: "Pacific International Lines (PIL)",
  EVERGREEN: "Evergreen Marine Corporation",
  KMTC: "Korea Marine Transport Co. (KMTC)",
  ONE: "Ocean Network Express (ONE)",
  HAPAG: "Hapag-Lloyd",
  ZIM: "Zim Integrated Shipping",
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
  const q = (req.query.q || req.query.search || "").trim().toLowerCase();

  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT DISTINCT carrier_code AS code
      FROM shipping_plans
      WHERE carrier_code IS NOT NULL AND carrier_code <> ''
      ORDER BY carrier_code
      LIMIT $1
    `, [limit]);

    let carriers = rows.map(r => ({
      id: r.code,
      code: r.code,
      name: CARRIER_NAMES[r.code?.toUpperCase()] || r.code,
    }));

    // 合并硬编码常用列表（补全 DB 没有的）
    const hardcoded = Object.entries(CARRIER_NAMES).map(([code, name]) => ({ id: code, code, name }));
    const existingCodes = new Set(carriers.map(c => c.code?.toUpperCase()));
    hardcoded.forEach(h => { if (!existingCodes.has(h.code)) carriers.push(h); });

    if (q) carriers = carriers.filter(c =>
      c.code?.toLowerCase().includes(q) || c.name?.toLowerCase().includes(q)
    );
    carriers = carriers.slice(0, limit);

    return res.json({
      success: true,
      data: carriers,
      total: carriers.length,
    });
  } catch (e) {
    console.error("[carriers]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
