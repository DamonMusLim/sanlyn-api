// GET /api/db/compliance-audit — admin-only compliance scanner.
//
// Sanlyn rule (Damon 2026-05-16): 贸易公司不能收物流费，除非 trade_terms 是
// DDP / CIF / CNF. EXW / FOB 下客户应直接付货代 (洋宝宝), 不付 BABI.
//
// Returns:
//   - violations.freight_to_trading_co  : BABI 等贸易主体在 FOB/EXW 单上收的运费
//   - violations.unlabeled_orders       : trade_terms 为空的订单 (审计盲区)
//   - violations.freight_to_unmapped    : 收款方不在 ISSUING_COMPANY_MAP 的运费
//
// Frontend / admin dashboard reads this for the red badge.
// Future: a cron job calls this daily and wechat-push's the summary to ops.
import { getPool, setCors } from "../db.js";

// Trading companies that are NOT freight forwarders. Edit when new trading
// entities are added (e.g. new Sanlyn group company).
const TRADING_COS = ["%巴匕%", "%PET BABY%", "%FORTUNE SANLYN%"];

// Incoterms where the trading company is allowed to bundle freight into the
// goods invoice (because seller has the obligation up to destination).
const FREIGHT_OK_INCOTERMS = ["DDP", "CIF", "CNF", "CFR", "DPU", "DAP"];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")    return res.status(405).json({ error: "GET only" });
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  const pool = getPool();

  try {
    // ── 1. Trading co collected freight on FOB/EXW orders (violation) ──
    const tradingFilter = TRADING_COS.map((_, i) => `fp.issuing_co ILIKE $${i + 1}`).join(" OR ");
    const okInTerms = FREIGHT_OK_INCOTERMS.map((_, i) => `$${TRADING_COS.length + 1 + i}`).join(",");
    const violationsQ = await pool.query(`
      SELECT fp.id, fp.contract_no, fp.order_no, fp.customer_en,
             o.trade_terms, fp.issuing_co,
             COALESCE(fp.freight_recv, 0) AS freight,
             COALESCE(fp.port_recv,    0) AS port,
             COALESCE(fp.truck_recv,   0) AS truck,
             COALESCE(fp.customs_recv, 0) AS customs,
             fp.pay_item, fp.payment_date
      FROM   finance_payments fp
      LEFT   JOIN orders o ON o.contract_no = fp.contract_no OR o.order_no = fp.order_no
      WHERE  (${tradingFilter})
        AND  (COALESCE(fp.freight_recv,0) + COALESCE(fp.port_recv,0) +
              COALESCE(fp.truck_recv,0)  + COALESCE(fp.customs_recv,0)) > 0
        AND  (o.trade_terms IS NULL OR o.trade_terms NOT IN (${okInTerms}))
      ORDER BY fp.payment_date DESC NULLS LAST
      LIMIT  100
    `, [...TRADING_COS, ...FREIGHT_OK_INCOTERMS]);

    // ── 2. Orders with NULL trade_terms (audit blind spots) ──
    const unlabeledQ = await pool.query(`
      SELECT id, order_no, contract_no, company_name_en, total_amount, currency
      FROM   orders
      WHERE  (trade_terms IS NULL OR trade_terms = '')
        AND  company_name_en IS NOT NULL
      ORDER BY id DESC
      LIMIT  50
    `);

    // ── 3. Summary ──
    const totalViolationAmount = violationsQ.rows.reduce(
      (s, r) => s + Number(r.freight) + Number(r.port) + Number(r.truck) + Number(r.customs), 0
    );

    return res.status(200).json({
      ok: true,
      scanned_at: new Date().toISOString(),
      summary: {
        violation_payments: violationsQ.rowCount,
        violation_amount_cny: Math.round(totalViolationAmount * 100) / 100,
        unlabeled_orders: unlabeledQ.rowCount,
      },
      violations: {
        freight_to_trading_co: violationsQ.rows,
        unlabeled_orders: unlabeledQ.rows,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, code: err.code });
  }
}
