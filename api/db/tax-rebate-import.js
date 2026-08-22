// api/db/tax-rebate-import.js
// P2: 导入「外贸企业出口退税进货明细申报表」(VM-win从退税系统下载) → 按报关品名+金额匹配订单
// POST { period, rows:[{link_no,invoice_no,supplier_tax_id,invoice_date,hs_code,
//          declaration_name,qty,taxable_amount,rebate_rate,rebate_amount}] }
//   → 写 input_invoices, 匹配 order_line_items, 命中订单标已退税, 返回漏单清单
// GET ?period=2026-03 → 该批次进项票+匹配情况+漏单
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS input_invoices (
      id SERIAL PRIMARY KEY,
      period TEXT, link_no TEXT, invoice_no TEXT,
      supplier_tax_id TEXT, invoice_date TEXT, hs_code TEXT,
      declaration_name TEXT, qty NUMERIC, taxable_amount NUMERIC,
      rebate_rate NUMERIC, rebate_amount NUMERIC,
      matched_order_no TEXT, matched_line_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(invoice_no, declaration_name, taxable_amount)
    );
    CREATE INDEX IF NOT EXISTS idx_input_inv_period ON input_invoices(period);
    CREATE INDEX IF NOT EXISTS idx_input_inv_order ON input_invoices(matched_order_no);
  `).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rebate_status TEXT`).catch(() => {});
}

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(n) ? 0 : n; };

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ error: "退税导入仅财务/管理员" });
  }
  const pool = getPool();
  try {
    await ensureTable(pool);

    // ── GET: 查某批次进项票+匹配 ──
    if (req.method === "GET") {
      const period = req.query.period;
      const r = await pool.query(
        `SELECT * FROM input_invoices ${period ? "WHERE period=$1" : ""} ORDER BY id DESC LIMIT 2000`,
        period ? [period] : []);
      const matched = r.rows.filter(x => x.matched_order_no);
      const unmatched = r.rows.filter(x => !x.matched_order_no);
      return res.json({ success: true, period: period || "全部",
        total: r.rows.length, matched: matched.length, unmatched: unmatched.length,
        total_rebate: Math.round(r.rows.reduce((s, x) => s + num(x.rebate_amount), 0) * 100) / 100,
        invoices: r.rows });
    }

    // ── POST: 导入明细行 ──
    const { period, rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows 必填" });

    let inserted = 0, matchedCnt = 0;
    const unmatched = [];   // 漏单A: 申报表有,匹配不到订单
    const touchedOrders = new Set();

    for (const row of rows) {
      const decl = (row.declaration_name || "").trim();
      const amt = num(row.taxable_amount);
      if (!decl) continue;

      // 按 报关品名 + 金额(容差±1% 或 ±5元) 匹配 order_line_items → 订单
      let m = null;
      if (decl) {
        const tol = Math.max(amt * 0.01, 5);
        const mr = await pool.query(
          `SELECT li.id AS line_id, o.order_no
           FROM order_line_items li JOIN orders o ON o.id = li.order_id
           WHERE li.declaration_name = $1
             -- OLI_INTERNAL_SCAN_ONLY：按金额容差把退税行匹配到订单行，纯内部关联，金额不外显
             AND abs(COALESCE(li.factory_subtotal, li.subtotal, 0) - $2) <= $3
             AND o.status != 'cancelled'
           -- OLI_INTERNAL_SCAN_ONLY：同上，仅排序用
           ORDER BY abs(COALESCE(li.factory_subtotal, li.subtotal, 0) - $2) ASC
           LIMIT 1`, [decl, amt, tol]);
        m = mr.rows[0] || null;
      }

      // 写 input_invoices (幂等)
      await pool.query(
        `INSERT INTO input_invoices
          (period, link_no, invoice_no, supplier_tax_id, invoice_date, hs_code,
           declaration_name, qty, taxable_amount, rebate_rate, rebate_amount,
           matched_order_no, matched_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (invoice_no, declaration_name, taxable_amount)
         DO UPDATE SET matched_order_no=EXCLUDED.matched_order_no,
                       matched_line_id=EXCLUDED.matched_line_id,
                       rebate_amount=EXCLUDED.rebate_amount, period=EXCLUDED.period`,
        [period || null, row.link_no || null, row.invoice_no || null,
         row.supplier_tax_id || null, row.invoice_date || null, row.hs_code || null,
         decl, num(row.qty), amt, num(row.rebate_rate), num(row.rebate_amount),
         m?.order_no || null, m?.line_id || null]);
      inserted++;

      if (m) { matchedCnt++; touchedOrders.add(m.order_no); }
      else unmatched.push({ invoice_no: row.invoice_no, declaration_name: decl,
        taxable_amount: amt, rebate_amount: num(row.rebate_amount) });
    }

    // 命中的订单 → 标「已退税」(只在还没更高状态时)
    for (const ono of touchedOrders) {
      await pool.query(
        `UPDATE orders SET tax_rebate_status='已退税', updated_at=now()
         WHERE order_no=$1 AND COALESCE(tax_rebate_status,'未退税') NOT IN ('已到账')`,
        [ono]).catch(() => {});
    }

    // 漏单B: 该期已出口订单但无任何进项票匹配(需补进项票/发票号)
    let missingOrders = [];
    if (period && /^\d{4}-\d{2}$/.test(period)) {
      const [y, mo] = period.split("-").map(Number);
      const start = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
      const end = new Date(Date.UTC(y, mo, 1)).toISOString();
      const mo2 = await pool.query(
        `SELECT o.order_no, o.customer
         FROM orders o
         WHERE COALESCE(o.etd,o.delivery_date) >= $1 AND COALESCE(o.etd,o.delivery_date) < $2
           AND o.status != 'cancelled'
           AND NOT EXISTS (SELECT 1 FROM input_invoices ii WHERE ii.matched_order_no = o.order_no)
         ORDER BY o.order_no`, [start, end]);
      missingOrders = mo2.rows;
    }

    return res.json({
      success: true, period: period || null,
      summary: {
        rows_in: rows.length, inserted, matched: matchedCnt,
        unmatched_invoices: unmatched.length, orders_rebated: touchedOrders.size,
        missing_orders: missingOrders.length,
      },
      unmatched_invoices: unmatched,   // 漏单A: 票有单无 → 补发票号关联
      missing_orders: missingOrders,   // 漏单B: 单有票无 → 补进项票
    });
  } catch (e) {
    console.error("[tax-rebate-import]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
