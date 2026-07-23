import { getPool, setCors } from "../db.js";

function requireFinanceAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (req.user.role !== "admin" && req.user.role !== "finance") {
    res.status(403).json({ error: "admin or finance role required" });
    return false;
  }
  return true;
}

function money(v) {
  var n = Number(v || 0);
  return isNaN(n) ? 0 : n;
}

function addCurrency(bucket, currency, cost, sale) {
  var cur = String(currency || "CNY").trim().toUpperCase() || "CNY";
  if (!bucket[cur]) bucket[cur] = { cost: 0, sale: 0, profit: 0 };
  bucket[cur].cost += money(cost);
  bucket[cur].sale += money(sale);
  bucket[cur].profit = bucket[cur].sale - bucket[cur].cost;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireFinanceAuth(req, res)) return;

  const pool = getPool();

  if (req.method === "GET") {
    var blNo = String(req.query.bl_no || "").trim();
    if (!blNo) return res.status(400).json({ error: "bl_no required" });

    try {
      var r = await pool.query(
        `SELECT id, bl_no, amount AS cost_amount, amount, sale_amount, currency, supplier_type, cost_category
           FROM freight_supplier_bills
          WHERE bl_no = $1
            AND COALESCE(rebill_status, '') <> 'voided'`,
        [blNo]
      );

      var checks = [];
      var rows = r.rows || [];
      if (rows.length === 0) {
        return res.json({
          status: "fail",
          checks: [{ code: "NO_BILL_LINES", severity: "high", message: "未找到该BL的货代账单行" }],
          summary: { cost_cny: 0, sale_cny: 0, profit_cny: 0 },
        });
      }

      var byCurrency = {};
      var hasSaleMissing = false;

      rows.forEach(function(row) {
        var currency = String(row.currency || "CNY").toUpperCase();
        addCurrency(byCurrency, currency, row.amount, row.sale_amount);
        if (row.sale_amount === null || money(row.sale_amount) === 0) {
          hasSaleMissing = true;
        }
      });

      if (hasSaleMissing) {
        checks.push({ code: "SALE_MISSING", severity: "warn", message: "存在销售额为空或为0的货代账单行" });
      }
      var currencies = Object.keys(byCurrency);
      if (currencies.length > 1) {
        checks.push({ code: "MIXED_CURRENCY", severity: "warn", message: "存在多个币种账单行，已按币种分别汇总，不能混算为CNY" });
      } else if (currencies[0] && currencies[0] !== "CNY") {
        checks.push({ code: "NON_CNY_LINE", severity: "warn", message: "存在非CNY币种账单行，已按原币种汇总，未折算为CNY" });
      }

      currencies.forEach(function(cur) {
        if (byCurrency[cur].profit < 0) {
          checks.push({ code: "NEGATIVE_PROFIT", severity: "high", currency: cur, message: cur + " 销售金额低于成本金额" });
        }
      });

      if (checks.length === 0) {
        checks.push({ code: "COST_AUDIT_OK", severity: "ok", message: "货代成本与销售金额已核查" });
      }

      var status = checks.some(function(c) { return c.severity === "high"; })
        ? "fail"
        : checks.some(function(c) { return c.severity === "warn"; })
          ? "warn"
          : "pass";

      return res.json({
        status: status,
        checks: checks,
        summary: {
          cost_cny: byCurrency.CNY ? byCurrency.CNY.cost : 0,
          sale_cny: byCurrency.CNY ? byCurrency.CNY.sale : 0,
          profit_cny: byCurrency.CNY ? byCurrency.CNY.profit : 0,
          by_currency: byCurrency,
        },
      });
    } catch (e) {
      console.error("[freight-cost-audit] GET failed:", e);
      return res.status(500).json({ error: "freight cost audit failed", detail: e.message });
    }
  }

  if (req.method === "POST") {
    var body = req.body || {};
    var postBlNo = String(body.bl_no || "").trim();

    if (!postBlNo) return res.status(400).json({ error: "bl_no required" });
    if (body.action !== "set_par") return res.status(400).json({ error: "unsupported action" });
    if (body.confirmed !== true) return res.status(400).json({ error: "confirmed=true required" });

    var client = await pool.connect();
    try {
      await client.query("BEGIN");

      var upd = await client.query(
        `UPDATE freight_supplier_bills
            SET sale_amount = amount
          WHERE bl_no = $1
            AND (sale_amount IS NULL OR sale_amount = 0)`,
        [postBlNo]
      );

      await client.query(
        `INSERT INTO audit_logs (action, operator, entity_type, entity_id, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          "set_par",
          String(req.user.username || req.user.email || req.user.id || "unknown"),
          "freight_bill",
          postBlNo,
          JSON.stringify({ note: "sale set to cost parity", bl_no: postBlNo }),
        ]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, rows_updated: upd.rowCount });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[freight-cost-audit] POST failed:", e);
      return res.status(500).json({ error: "set par failed", detail: e.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
