import { getPool, setCors } from "../db.js";
import { importCostPreview } from "./lib/freight-cost-import.js";

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

function requireCostPreviewAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  var allowed = new Set(["internal", "admin", "finance", "logistics"]);
  if (!allowed.has(req.user.role)) {
    res.status(403).json({ error: "internal/admin/finance/logistics role required" });
    return false;
  }
  return true;
}

function money(v) {
  var n = Number(v || 0);
  return isNaN(n) ? 0 : n;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    if (req.query.action === "import_cost_preview") {
      if (!requireCostPreviewAuth(req, res)) return;
      var previewBlNo = String(req.query.bl_no || "").trim();
      var shippingPlanId = String(req.query.shipping_plan_id || "").trim();
      if (!previewBlNo && !shippingPlanId) {
        return res.status(400).json({ error: "bl_no or shipping_plan_id required" });
      }
      try {
        var preview = await importCostPreview(pool, {
          bl_no: previewBlNo || null,
          shipping_plan_id: shippingPlanId || null,
        });
        return res.json(preview);
      } catch (e) {
        console.error("[freight-cost-audit] import preview failed:", e);
        return res.status(500).json({ error: "import cost preview failed", detail: e.message });
      }
    }

    if (!requireFinanceAuth(req, res)) return;
    var blNo = String(req.query.bl_no || "").trim();
    if (!blNo) return res.status(400).json({ error: "bl_no required" });

    try {
      var r = await pool.query(
        `SELECT id, bl_no, cost_amount, sale_amount, currency, supplier_type
           FROM freight_supplier_bills
          WHERE bl_no = $1`,
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

      var costCny = 0;
      var saleCny = 0;
      var hasSaleMissing = false;
      var hasNonCny = false;

      rows.forEach(function(row) {
        var currency = String(row.currency || "CNY").toUpperCase();
        if (currency !== "CNY") hasNonCny = true;
        costCny += money(row.cost_amount);
        saleCny += money(row.sale_amount);
        if (row.sale_amount === null || money(row.sale_amount) === 0) {
          hasSaleMissing = true;
        }
      });

      if (hasSaleMissing) {
        checks.push({ code: "SALE_MISSING", severity: "warn", message: "存在销售额为空或为0的货代账单行" });
      }
      if (hasNonCny) {
        checks.push({ code: "NON_CNY_LINE", severity: "warn", message: "存在非CNY币种账单行，本次仅按账面金额汇总为CNY" });
      }

      var profitCny = saleCny - costCny;
      if (profitCny < 0) {
        checks.push({ code: "NEGATIVE_PROFIT", severity: "high", message: "销售金额低于成本金额" });
      }

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
        summary: { cost_cny: costCny, sale_cny: saleCny, profit_cny: profitCny },
      });
    } catch (e) {
      console.error("[freight-cost-audit] GET failed:", e);
      return res.status(500).json({ error: "freight cost audit failed", detail: e.message });
    }
  }

  if (req.method === "POST") {
    if (!requireFinanceAuth(req, res)) return;
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
            SET sale_amount = cost_amount
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
