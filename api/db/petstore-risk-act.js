import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { buildRiskCenter } from "./petstore-risk-center.js";

const PROBLEMS = [
  { key: "expired_onsale", label: "已过期仍在售", action: "下架+核日期", assignee: "PET-12", due: 1 },
  { key: "expired", label: "已过期", action: "核日期+报损待批", assignee: "PET-12", due: 1 },
  { key: "price_zero", label: "售价≈0有货", action: "修价", assignee: "PET-12", due: 1 },
  { key: "negative_stock", label: "负库存", action: "盘点", assignee: "PET-22", due: 3 },
  { key: "onsale_no_stock", label: "在售没货", action: "补货或下架", assignee: "PET-22", due: 3 },
  { key: "d30", label: "<=30天", action: "临期处理(降价需Damon批)", assignee: "PET-12", due: 3 },
  { key: "no_date", label: "会坏有货没日期", action: "店员补日期", assignee: "PET-01", due: 3 },
  { key: "d60", label: "31-60天", action: "临期观察", assignee: "PET-12", due: 3 },
  { key: "no_shelf", label: "有货没货位", action: "补货位", assignee: "PET-01", due: 3 },
  { key: "stock_mismatch", label: "库存对不上", action: "对账", assignee: "PET-22", due: 3 },
  { key: "status_unknown", label: "无上下架状态", action: "补状态", assignee: "PET-12", due: 3 },
  { key: "data_gap", label: "档案缺口", action: "补档案", assignee: "PET-12", due: 3 },
  { key: "d90", label: "61-90天", action: "观察", assignee: "", due: 3 },
];

function json(res, code, body) { return res.status(code).json(body); }
function trunc(s, n) { return Array.from(String(s || "")).slice(0, n).join(""); }
function ymd(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
}
function evidence(row) {
  return [
    "货位:" + (row.shelf_code || "—"),
    "库存:" + (row.stk == null ? "—" : row.stk),
    "状态:" + (row.product_status || "—"),
    "生产:" + (row.produce_date || "—"),
    "到期:" + (row.expiration_date || "—"),
    "剩余天数:" + (row.days_to_expire == null ? "—" : row.days_to_expire),
    "按售价金额:" + (row.amount_by_price == null ? "—" : row.amount_by_price),
  ].join("；");
}
function dod(problem) {
  const base = ["处理后回写task_events附照片或回读结果"];
  if (problem.key === "expired_onsale") return ["店员核实实物日期确认是否过期", "确认过期先下架,不直接报损", ...base];
  if (problem.key === "expired") return ["店员核实实物日期确认是否过期", "确认过期后等待Damon批准报损", ...base];
  if (problem.key === "price_zero") return ["核实售价是否误置为0", "修正售价或确认下架", ...base];
  if (problem.key === "negative_stock") return ["现场盘点实物数量", "查明负库存来源并回写结果", ...base];
  if (problem.key === "onsale_no_stock") return ["确认是否实物缺货", "补货或下架后回读状态", ...base];
  if (problem.key === "no_date") return ["读取实物生产日期/到期日", "回填日期或说明无法读取原因", ...base];
  if (problem.key === "no_shelf") return ["现场确认商品位置", "补齐货位编码", ...base];
  if (problem.key === "stock_mismatch") return ["对比两库存源和现场数量", "说明差异来源并回写结果", ...base];
  return ["核实商品档案/状态字段", "补齐或说明无法补齐原因", ...base];
}
async function newId(client) {
  const prefix = "rk-" + ymd(new Date()) + "-";
  for (let i = 0; i < 20; i++) {
    const id = prefix + crypto.randomBytes(3).toString("hex");
    const r = await client.query("SELECT 1 FROM public.tasks WHERE id=$1", [id]);
    if (!r.rowCount) return id;
  }
  throw new Error("id_exhausted");
}
async function insertTask(client, row, problem, dedupeKey, titlePrefix, nextHolder, criteriaDod) {
  const id = await newId(client);
  const due = new Date(Date.now() + problem.due * 86400000);
  const title = titlePrefix + ":" + trunc(row.product_name || row.product_code, 60);
  const criteria = { dod: criteriaDod, problem_key: problem.key, product_code: row.product_code };
  const reason = problem.label + "；" + evidence(row);
  await client.query(
    `INSERT INTO public.tasks
      (id,title,status,source,dispatched_by,reason,for_role,current_holder,next_holder,verifier,acceptance_criteria,due_at,domain,dedupe_key)
     VALUES ($1,$2,'open','dataops','human_request',$3,'PET','',$4,'PET-01',$5::jsonb,$6,'petstore',$7)`,
    [id, title, reason, nextHolder, JSON.stringify(criteria), due, dedupeKey]);
  await client.query(
    `INSERT INTO public.task_events(task_id,event_type,actor_type,actor_id,note,metadata)
     VALUES ($1,'created','human','damon',$2,$3::jsonb)`,
    [id, reason, JSON.stringify({ problem_key: problem.key, product_code: row.product_code })]);
  return id;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") return json(res, 401, { ok: false, error: "gateway_auth_required" });
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const body = req.body || {};
  const problem = PROBLEMS.find((p) => p.key === body.problem_key);
  if (!problem || !problem.assignee) return json(res, 400, { ok: false, error: "bad_problem_key" });
  const codes = Array.from(new Set((body.product_codes || []).map((x) => String(x || "").trim()).filter(Boolean))).slice(0, 100);
  if (!codes.length) return json(res, 400, { ok: false, error: "empty_product_codes" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const center = await buildRiskCenter(client);
    const byCode = new Map((center.rows || []).map((r) => [String(r.product_code), r]));
    const cap = await client.query(
      `SELECT count(*)::int AS n FROM public.tasks
        WHERE dedupe_key LIKE $1
          AND created_at >= (timezone('Asia/Shanghai', now())::date AT TIME ZONE 'Asia/Shanghai')
          AND created_at < ((timezone('Asia/Shanghai', now())::date + 1) AT TIME ZONE 'Asia/Shanghai')`,
      ["risk:" + problem.key + ":%"]);

    let madeToday = cap.rows[0].n;
    const created = [];
    const skipped = [];

    for (const code of codes) {
      const row = byCode.get(code);
      if (!row || !(row.problems || []).some((p) => p.key === problem.key)) {
        skipped.push({ product_code: code, reason: "NOT_CURRENT" });
        continue;
      }
      const dedupeKey = "risk:" + problem.key + ":" + code;
      const dup = await client.query(
        `SELECT id FROM public.tasks WHERE dedupe_key=$1 AND status NOT IN ('done','cancelled') LIMIT 1`, [dedupeKey]);
      if (dup.rowCount) {
        skipped.push({ product_code: code, reason: "DUPLICATE" });
        continue;
      }
      if (madeToday >= 20) {
        skipped.push({ product_code: code, reason: "DAILY_CAP_20" });
        continue;
      }
      const taskId = await insertTask(client, row, problem, dedupeKey, problem.action, problem.assignee, dod(problem));
      madeToday++;
      const rec = { product_code: code, task_id: taskId };

      if (problem.key === "expired" || problem.key === "expired_onsale") {
        const wdKey = "risk:writeoff:" + code;
        const wdDup = await client.query(
          `SELECT id FROM public.tasks WHERE dedupe_key=$1 AND status NOT IN ('done','cancelled') LIMIT 1`, [wdKey]);
        if (!wdDup.rowCount) {
          const wdProblem = { ...problem, key: "writeoff", due: 1 };
          rec.writeoff_task_id = await insertTask(client, row, wdProblem, wdKey, "报损待批", "Damon",
            ["店员核实物日期确认过期", "Damon批准后在果冻橙建损益单"]);
        }
      }
      created.push(rec);
    }

    const ids = created.flatMap((x) => [x.task_id, x.writeoff_task_id].filter(Boolean));
    const back = ids.length ? await client.query("SELECT id FROM public.tasks WHERE id = ANY($1::text[])", [ids]) : { rowCount: 0 };
    if (back.rowCount !== ids.length) throw new Error("created_readback_failed");
    await client.query("COMMIT");
    return json(res, 200, { ok: true, created, skipped });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[petstore-risk-act]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  } finally {
    client.release();
  }
}
