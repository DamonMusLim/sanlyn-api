import { getPool, setCors } from "../db.js";
import { invalidateProductAnalysisCache } from "./petstore-product-analysis.js";

const ACTIONS = new Set(["人工复核", "补资质", "下架核查"]);

function json(res, code, body) { return res.status(code).json(body); }
function s(v) { return String(v == null ? "" : v).trim(); }
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function sixHex() {
  return Math.random().toString(16).slice(2, 8).padEnd(6, "0");
}
function cut(v, n) {
  return s(v).slice(0, n);
}
function holderOf(action) {
  if (action === "人工复核") return "PET-01";
  if (action === "补资质") return "Damon";
  return "PET-12";
}
function dodOf(action) {
  if (action === "人工复核") return ["确认AI分类是否正确", "填写复核结论并关闭"];
  if (action === "补资质") return ["核对处方药资质材料", "补齐记录后关闭"];
  return ["核查在货实物与效期", "过期商品下架处理后关闭"];
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const bufs = [];
  for await (const c of req) bufs.push(c);
  if (!bufs.length) return {};
  return JSON.parse(Buffer.concat(bufs).toString("utf8"));
}

async function loadProduct(client, code) {
  const r = await client.query(
    `WITH latest AS (
       SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna WHERE store_code='63350001'
     ), exp_latest AS (
       SELECT max(capture_date) AS capture_date FROM public.petstore_offline_expiry_snapshot
     ), exp AS (
       SELECT e.product_code, e.expiration_date, e.days_to_expire
         FROM public.petstore_offline_expiry_snapshot e
         JOIN exp_latest l ON l.capture_date=e.capture_date
     )
     SELECT d.product_code, d.product_name, d.spec, d.category_name, d.cur_stock,
            c.rx_type, c.confidence, c.reason,
            e.expiration_date, e.days_to_expire
       FROM public.petstore_sku_sales_dna d
       JOIN latest l ON l.as_of=d.as_of
       LEFT JOIN public.petstore_med_classify c ON c.product_code=d.product_code
       LEFT JOIN exp e ON e.product_code=d.product_code
      WHERE d.store_code='63350001' AND d.product_code=$1
      LIMIT 1`,
    [code]
  );
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") return json(res, 403, { ok: false, error: "gateway_auth_required" });
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { ok: false, error: "bad_json" });
  }

  const productCode = cut(body.product_code, 80);
  const action = s(body.action);
  if (!productCode || !ACTIONS.has(action)) return json(res, 400, { ok: false, error: "bad_request" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dedupeKey = `pa:${action}:${productCode}`;
    const exists = await client.query(
      `SELECT id, title, status, next_holder, due_at
         FROM public.tasks
        WHERE dedupe_key=$1 AND status NOT IN ('done','cancelled')
        LIMIT 1
        FOR UPDATE`,
      [dedupeKey]
    );
    if (exists.rows[0]) {
      await client.query("ROLLBACK");
      return json(res, 409, { ok: false, error: "open_task_exists", task: exists.rows[0] });
    }

    const p = await loadProduct(client, productCode);
    if (!p) {
      await client.query("ROLLBACK");
      return json(res, 404, { ok: false, error: "product_not_found" });
    }

    const id = `pa-${ymd(new Date())}-${sixHex()}`;
    const title = `${action}:${cut(p.product_name, 60)}`;
    const nextHolder = holderOf(action);
    const dueAt = new Date(Date.now() + 3 * 86400000);
    const reason = [
      `rx_type=${p.rx_type || "未分类"}`,
      `confidence=${p.confidence == null ? "—" : p.confidence}`,
      `reason=${p.reason || "—"}`,
      `类目=${p.category_name || "—"}`,
      `库存=${p.cur_stock == null || Number(p.cur_stock) < 0 ? "—" : p.cur_stock}`,
      `效期=${p.expiration_date || "—"}`,
      `剩余天=${p.days_to_expire == null ? "—" : p.days_to_expire}`
    ].join("；");
    const dod = dodOf(action);

    const verifier = nextHolder === "PET-01" ? "Damon" : "PET-01";
    const ins = await client.query(
      `INSERT INTO public.tasks
        (id,title,status,source,dispatched_by,reason,for_role,current_holder,next_holder,verifier,acceptance_criteria,due_at,domain,dedupe_key)
       VALUES ($1,$2,'open','dataops','human_request',$3,'PET','',$4,$5,$6::jsonb,$7,'petstore',$8)
       RETURNING id, title, status, next_holder, due_at, dedupe_key`,
      [id, title, reason, nextHolder, verifier, JSON.stringify(dod), dueAt, dedupeKey]
    );

    await client.query(
      `INSERT INTO public.task_events(task_id,event_type,actor_type,actor_id,note,metadata)
       VALUES ($1,'created','human','damon',$2,$3::jsonb)`,
      [id, reason, JSON.stringify({ source: "petstore-product-analysis", action, product_code: productCode })]
    );

    await client.query("COMMIT");
    invalidateProductAnalysisCache();
    return json(res, 200, { ok: true, task: ins.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[petstore-product-analysis-act]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  } finally {
    client.release();
  }
}
