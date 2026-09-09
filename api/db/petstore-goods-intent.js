import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

// 门店商品「操作列」的动作入口。
// 🔴 本接口【只写意图,永不直接调果冻橙】。执行走 Studio 的 intents 执行器,
//    它那边才有果冻橙 token。这样:①凭证不多放一处 ②每次动作都留痕 ③危险动作能卡审批。
// 🔴 本接口永不返回成本类字段。

const ACTIONS = {
  DELETE:        { label: "删除商品",   needApprove: true,  payload: [] },
  COPY:          { label: "复制商品",   needApprove: false, payload: [] },
  LOWER:         { label: "下架",       needApprove: false, payload: [] },
  UP:            { label: "上架",       needApprove: false, payload: [] },
  SET_STOCK:     { label: "改库存",     needApprove: false, payload: ["stock_num"] },
  SET_SHELF:     { label: "改货位",     needApprove: false, payload: ["shelf"] },
  SET_PRICE:     { label: "改售价",     needApprove: true,  payload: ["out_price"] },
  COLLECT_RIVAL: { label: "竞品采集",   needApprove: false, payload: [] },
};

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function clean(v, max = 200) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
}

// 校验并归一化 payload。缺必填 / 类型不对 → 返回错误串。
function buildPayload(action, body) {
  const spec = ACTIONS[action];
  const out = {};
  for (const key of spec.payload) {
    const v = body[key];
    if (v === undefined || v === null || v === "") return { err: `缺少参数 ${key}` };
    if (key === "stock_num") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return { err: "库存必须是不小于 0 的整数" };
      out[key] = n;
    } else if (key === "out_price") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { err: "售价必须大于 0" };
      out[key] = Math.round(n * 100) / 100;
    } else {
      const s = clean(v, 60);
      if (!s) return { err: `${key} 不能为空` };
      out[key] = s;
    }
  }
  return { payload: out };
}

async function listIntents(pool, productCode) {
  const sql = `
    SELECT id, product_code, product_name, action, status, payload,
           reason, created_at, approved_at, applied_at, result
      FROM public.petstore_shelf_action_intents
     WHERE ($1::text IS NULL OR product_code = $1)
     ORDER BY created_at DESC
     LIMIT 100`;
  const r = await pool.query(sql, [productCode]);
  return { ok: true, rows: r.rows, total: r.rowCount };
}

async function createIntent(pool, body, actor) {
  const action = clean(body.action, 32);
  if (!action || !ACTIONS[action]) {
    return { status: 400, data: { ok: false, error: "unknown_action", allow: Object.keys(ACTIONS) } };
  }
  const productCode = clean(body.product_code, 64);
  if (!productCode) return { status: 400, data: { ok: false, error: "missing_product_code" } };

  const built = buildPayload(action, body);
  if (built.err) return { status: 400, data: { ok: false, error: built.err } };

  const spec = ACTIONS[action];

  // 🔴 降价必须 Damon 同意(他 0828 定的,无例外)。这里只做提示,
  //    真正的闸是 status='proposed' —— 执行器只吃 approved。
  let reason = clean(body.reason, 500) || `${spec.label}(来自门店商品页)`;
  if (spec.needApprove) reason = `[待人工批准] ${reason}`;

  const sql = `
    INSERT INTO public.petstore_shelf_action_intents
      (product_code, product_name, action, payload, reason, status, source)
    VALUES ($1, $2, $3, $4::jsonb, $5, 'proposed', $6)
    ON CONFLICT (product_code) WHERE status IN ('proposed','approved','applying')
    DO NOTHING
    RETURNING id, product_code, action, status, payload, reason, created_at`;
  const r = await pool.query(sql, [
    productCode, clean(body.product_name, 200), action,
    JSON.stringify(built.payload), reason, `jdc-ui:${actor || "unknown"}`,
  ]);

  if (!r.rowCount) {
    return {
      status: 409,
      data: { ok: false, error: "already_pending",
              message: "这个商品已经有一条没执行完的动作,先处理掉那条" },
    };
  }
  return {
    status: 200,
    data: { ok: true, intent: r.rows[0], need_approve: spec.needApprove,
            message: spec.needApprove
              ? `已提交「${spec.label}」,等人工批准后才会执行`
              : `已提交「${spec.label}」,执行器最迟 5 分钟内处理` },
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const user = requireAuth(req, res);
    if (!user) return;

    if (req.method === "GET") {
      const pool = getPool();
      return sendJson(res, 200, await listIntents(pool, clean(req.query?.product_code, 64)));
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }

    // 模块闸。⚠️ requireWritable 失败时返回 null 不是 false —— 必须 if (!r) return;
    const w = await requireWritable(req, res, "inventory");
    if (!w) return;

    const body = await readBody(req);
    const out = await createIntent(getPool(), body, user?.sub || user?.account);
    return sendJson(res, out.status, out.data);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
