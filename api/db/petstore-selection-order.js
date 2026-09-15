import crypto from "crypto";
import { getPool, setCors } from "../db.js";

const ROW_SQL = `
SELECT r.product_code, r.our_name, r.spec_text, r.total_sales, r.shop_count,
       r.max_sales, r.max_shop, r.eff_min_price, r.eff_min_shop, r.raw_min_price,
       r.our_store_price, r.our_mt_price, r.qty_180, r.cur_stock, r.monthly_demand,
       COALESCE(o.cost, ops.cost_price) AS cost,
       CASE WHEN o.cost IS NOT NULL THEN 'override'
            WHEN ops.cost_price IS NOT NULL THEN 'ops_row'
            ELSE 'none' END AS cost_source
  FROM public.v_selection_rows r
  LEFT JOIN (
    SELECT DISTINCT ON (product_code) product_code, cost_price::numeric AS cost_price
      FROM public.petstore_ops_row
     ORDER BY product_code
  ) ops ON ops.product_code = r.product_code
  LEFT JOIN public.petstore_cost_override o ON o.product_code = r.product_code
 WHERE r.product_code = $1`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function div(a, b) {
  a = num(a);
  b = num(b);
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

function moneyDiff(a, b) {
  a = num(a);
  b = num(b);
  if (a === null || b === null) return null;
  return a - b;
}

function ceilNeed(monthlyDemand, curStock) {
  monthlyDemand = num(monthlyDemand);
  curStock = num(curStock);
  if (monthlyDemand === null || curStock === null) return null;
  return Math.ceil(monthlyDemand * 1.5) - curStock;
}

// 口径同源 public/dataops-wb.js 选品表接口 petstore-selection-table.js
function gradeOf(r, cost, unitProfit, unitProfitMt, margin) {
  const eff = num(r.eff_min_price);
  if (cost === null || cost <= 0.2 || eff === null || cost > eff * 3) return "待核";
  if (unitProfitMt !== null && unitProfitMt < 0) return "3";
  if (margin !== null && margin < 0.05) return "3";
  if (num(r.total_sales) >= 50 && unitProfit !== null && unitProfit >= 2 && margin !== null && margin >= 0.15) return "1";
  if (num(r.qty_180) >= 50) return "1";
  return "2";
}

function kindOf(r, unitProfit, margin) {
  if (num(r.max_sales) >= 50 && (unitProfit === null || unitProfit < 2 || margin === null || margin < 0.15)) return "流量款";
  if (margin !== null && margin >= 0.20 && unitProfit !== null && unitProfit >= 2) return "利润款";
  return "普通";
}

function adviceOf(r, grade) {
  const stock = num(r.cur_stock);
  const qty = num(r.qty_180);
  if (grade === "待核") return "先核数据";
  if (grade === "3") return "不跟价,核进价";
  if (stock === null) return "库存待盘";
  if (qty === 0 && stock <= 0 && grade === "1") return "试销2";
  const need = ceilNeed(r.monthly_demand, stock);
  if (need !== null && need > 0 && (grade === "1" || grade === "2")) return "进" + need;
  return "不补";
}

function money(v) {
  v = num(v);
  return v === null ? "" : String(Math.round(v * 100) / 100);
}

function clip(s, n) {
  return Array.from(String(s || "")).slice(0, n).join("");
}

function ymdShanghai(withDash) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((a, p) => {
    a[p.type] = p.value;
    return a;
  }, {});
  return withDash ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.year}${parts.month}${parts.day}`;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    return json(res, 403, { ok: false, code: "FORBIDDEN", error: "forbidden" });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });

  const body = parseBody(req);
  const productCode = String(body.product_code || "").trim();
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty <= 0 || qty > 200) {
    return json(res, 400, { ok: false, code: "QTY_INVALID" });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const got = await client.query(ROW_SQL, [productCode]);
    if (!got.rows.length) return json(res, 404, { ok: false, code: "NOT_IN_TABLE" });

    const r = got.rows[0];
    const cost = num(r.cost);
    const eff = num(r.eff_min_price);
    const unitProfit = moneyDiff(eff, cost);
    const unitProfitMt = eff === null || cost === null ? null : eff * 0.95 - cost;
    const margin = div(unitProfit, eff);
    const grade = gradeOf(r, cost, unitProfit, unitProfitMt, margin);
    const kind = kindOf(r, unitProfit, margin);
    const advice = adviceOf(r, grade);

    if (grade === "待核" || grade === "3") {
      return json(res, 409, { ok: false, code: "GRADE_BLOCKED", reason: `评估${grade}/${advice}` });
    }

    const reason = clip(
      `选品表:附近总月销${num(r.total_sales) ?? ""}/最高月销${num(r.max_sales) ?? ""}(${r.max_shop || ""})/有效最低价${money(eff)}(${r.eff_min_shop || ""})/评估${grade}/款型${kind}/建议${advice}`,
      300
    );
    const ymd = ymdShanghai(false);
    const batchNo = `sel-${ymd}`;
    const taskId = `so-${ymd}-${crypto.randomBytes(3).toString("hex")}`;
    const intentTitleName = clip(r.our_name || r.product_code, 80);
    const title = `采购:${intentTitleName} ×${qty}`;
    const costSource = r.cost_source === "override" ? "override" : "ops_row";
    const criteria = {
      dod: [
        "等Damon在补货审核批准数量后再采购",
        "核验真实采购价:供应商实际报价/发票价 vs 成本,差>5%写原因",
        "到货后回写task_events"
      ],
      intent_id: null,
      cost
    };

    await client.query("BEGIN");

    const dup = await client.query(
      `SELECT id
         FROM public.petstore_restock_intents
        WHERE source = 'selection_table'
          AND product_code = $1
          AND status = 'proposed'
          AND created_at >= now() - interval '7 days'
        ORDER BY id DESC
        LIMIT 1`,
      [productCode]
    );
    if (dup.rows.length) {
      await client.query("ROLLBACK");
      return json(res, 409, { ok: false, code: "DUPLICATE", id: dup.rows[0].id });
    }

    const intentIns = await client.query(
      `INSERT INTO public.petstore_restock_intents
        (batch_no, store_code, product_code, product_name, spec, cur_stock, qty_30,
         suggest_qty, verdict_reason, source, buy_unit)
       VALUES ($1, '63350001', $2, $3, $4, $5, NULL, $6, $7, 'selection_table', 'piece')
       RETURNING id`,
      [batchNo, productCode, r.our_name || null, r.spec_text || null, num(r.cur_stock), qty, reason]
    );
    const intentId = intentIns.rows[0].id;
    criteria.intent_id = intentId;

    await client.query(
      `INSERT INTO public.tasks
        (id, title, status, source, dispatched_by, reason, for_role, current_holder,
         next_holder, verifier, acceptance_criteria, due_at, domain, dedupe_key)
       VALUES
        ($1, $2, 'open', 'dataops', 'human_request', $3, 'PET', '',
         'PET-22', 'PET-01', $4::jsonb, now() + interval '3 days', 'petstore', $5)`,
      [
        taskId,
        title,
        `${reason} 成本${money(cost)}(来源 ${costSource})`,
        JSON.stringify(criteria),
        `selorder:${productCode}:${ymd}`
      ]
    );

    await client.query(
      `INSERT INTO public.task_events
        (task_id, event_type, actor_type, actor_id, note, metadata)
       VALUES ($1, 'created', 'human', 'damon', '选品表下单', $2::jsonb)`,
      [taskId, JSON.stringify({ intent_id: intentId, qty })]
    );

    await client.query("COMMIT");

    const [intentRb, taskRb] = await Promise.all([
      pool.query(
        `SELECT id, status, suggest_qty FROM public.petstore_restock_intents WHERE id = $1`,
        [intentId]
      ),
      pool.query(
        `SELECT id, status, next_holder FROM public.tasks WHERE id = $1`,
        [taskId]
      )
    ]);

    return json(res, 200, {
      ok: true,
      intent_id: intentId,
      task_id: taskId,
      readback: { intent: intentRb.rows[0], task: taskRb.rows[0] }
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[petstore-selection-order]", err);
    return json(res, 500, { ok: false, code: "SERVER_ERROR", error: "server_error" });
  } finally {
    client.release();
  }
}
