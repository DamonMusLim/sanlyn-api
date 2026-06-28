// api/db/eport-rebate.js
// E-Port 退税报关单数据 API
// GET /api/db/eport-rebate?month=2026-05  → 该月 finance_export_rebates 记录
// GET /api/db/eport-rebate?list=months    → 有数据的月份列表
// GET /api/db/eport-rebate?last_sync=1    → 上次同步时间+记录数
// POST /api/db/eport-rebate               → 触发 mini eport-fetch.py (via jimeng-proxy)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MINI_JIMENG = process.env.MINI_JIMENG_URL || "http://100.87.134.113:3721";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ error: "仅财务/管理员可见" });
  }
  const pool = getPool();

  try {
    // ── POST: 触发 E-Port 抓取 ──
    if (req.method === "POST") {
      const resp = await fetch(`${MINI_JIMENG}/api/eport/sync`, { method: "POST", signal: AbortSignal.timeout(10000) });
      const j = await resp.json();
      return res.json({ success: j.ok, ...j });
    }

    // ── GET last_sync ──
    if (req.query.last_sync === "1") {
      const resp = await fetch(`${MINI_JIMENG}/api/eport/last-sync`, { signal: AbortSignal.timeout(5000) });
      const j = await resp.json();
      // Also get DB count
      const cnt = await pool.query("SELECT COUNT(*) AS c FROM finance_export_rebates");
      return res.json({ ...j, db_total: parseInt(cnt.rows[0]?.c || 0, 10) });
    }

    // ── GET list=months ──
    if (req.query.list === "months") {
      const r = await pool.query(`
        SELECT DISTINCT to_char(export_date, 'YYYY-MM') AS ym
        FROM finance_export_rebates
        WHERE export_date IS NOT NULL
        ORDER BY ym DESC LIMIT 36`);
      return res.json({ success: true, months: r.rows.map(x => x.ym).filter(Boolean) });
    }

    // ── GET month=YYYY-MM ──
    const month = req.query.month || "";
    if (!/^\d{4}-\d{2}$/.test(month) && req.query.month) {
      return res.status(400).json({ error: "month 格式 YYYY-MM" });
    }
    let q, params;
    if (month) {
      const [y, m] = month.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end   = new Date(Date.UTC(y, m, 1));
      q = `SELECT * FROM finance_export_rebates WHERE export_date >= $1 AND export_date < $2 ORDER BY export_date DESC`;
      params = [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
    } else {
      // Default: last 60 days
      q = `SELECT * FROM finance_export_rebates ORDER BY export_date DESC LIMIT 100`;
      params = [];
    }
    const r = await pool.query(q, params);
    const rows = r.rows.map(row => ({
      customs_no: row.customs_no,
      export_date: row.export_date,
      fob_foreign: parseFloat(row.fob_foreign || 0),
      currency: row.currency || "USD",
      rebate_rate: parseFloat(row.rebate_rate || 0.09),
      rebate_expected: parseFloat(row.rebate_expected || 0),
      contract_no: row.contract_no,
      customer_id: row.customer_id,
      status: row.status || "pending",
      note: row.note || "",
    }));

    const totalFob = rows.reduce((s, r) => s + r.fob_foreign, 0);
    const totalRebate = rows.reduce((s, r) => s + r.rebate_expected, 0);

    return res.json({
      success: true,
      period: month || "最近100条",
      count: rows.length,
      summary: { total_fob: Math.round(totalFob * 100) / 100, total_rebate: Math.round(totalRebate * 100) / 100 },
      records: rows,
    });
  } catch (e) {
    console.error("[eport-rebate]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
