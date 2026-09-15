// 数据加工中心 · 竞品机会池转单 · 0915
import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const STORE_CODE = "63350001";
const GATEWAY = "gw-dataops-0903";

function json(res, code, body) {
  return res.status(code).json(body);
}

function s(v) {
  return v === null || v === undefined ? "" : String(v);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function md5x(v) {
  return crypto.createHash("md5").update(v).digest("hex").slice(0, 16);
}

function ymdShanghai(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d).replaceAll("-", "");
}

function rid() {
  return crypto.randomBytes(3).toString("hex");
}

function titleFor(action, name) {
  const p = action === "new_item" ? "选品评估:" : action === "review" ? "匹配复核:" : "补货评估:";
  return (p + s(name)).slice(0, 80);
}

function holder(action) {
  return action === "review" ? "PET-12" : "PET-22";
}

function dod(action) {
  if (action === "restock") return ["复核竞品机会证据", "确认建议补货数量与单位", "给出是否补货结论"];
  // 0915 试建视图:「疑似新品」前5里有我方已在卖的(对手标题换写法没配上),所以第一步必须先查商品库
  if (action === "new_item") return ["先查商品库确认我方确实没有(同品牌不同写法可能已在卖)", "复核竞品月销与价格机制", "确认可否采购上架并给出选品结论"];
  return ["复核竞品商品与我方 SKU 匹配", "确认 match_status 与置信度", "给出可执行后续动作"];
}

function evidence(row) {
  return {
    shop: row.shop,
    product_name: row.product_name,
    month_sale: n(row.month_sale),
    hand_price: n(row.hand_price),
    tier_type: row.tier_type,
    tier_text: row.tier_text,
    match_status: row.match_status,
    confidence: row.confidence,
    our_status: row.our_status,
    is_hook: row.is_hook,
    captured_at: row.captured_at,
    view: "v_rival_opportunity"
  };
}

function reasonText(row) {
  return [
    "店:" + s(row.shop),
    "月销:" + s(row.month_sale),
    "到手价:" + s(row.hand_price),
    "机制:" + s(row.tier_text || row.tier_type),
    "匹配状态:" + s(row.match_status),
    "置信度:" + s(row.confidence),
    "引流:" + (row.is_hook ? "是" : "否"),
    "采集时间:" + s(row.captured_at),
    "视图:v_rival_opportunity"
  ].join(" / ");
}

async function authed(req, res) {
  if (req.headers["x-gateway-auth"] === GATEWAY) return true;
  if (!requireAuth(req, res)) return false;
  if (req.user && req.user.role === "admin") return true;
  json(res, 403, { ok: false, code: "ADMIN_ONLY" });
  return false;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!(await authed(req, res))) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const body = req.body || {};
    const shop = s(body.shop).trim();
    const productName = s(body.product_name).trim();
    const action = s(body.action).trim();
    const qty = n(body.qty);

    if (!shop || !productName || !["restock", "new_item", "review"].includes(action)) {
      return json(res, 400, { ok: false, code: "BAD_REQUEST" });
    }
    if (action === "restock" && (!Number.isInteger(qty) || qty <= 0)) {
      return json(res, 400, { ok: false, code: "QTY_REQUIRED" });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const found = await client.query(`
        SELECT *
          FROM public.v_rival_opportunity
         WHERE shop = $1 AND product_name = $2
         LIMIT 1`, [shop, productName]);
      const row = found.rows[0];

      if (!row || Number(row.rank_in_type) > 20) {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "TOP20_ONLY" });
      }
      if (row.is_med === true) {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "MED_RECORD_ONLY" });
      }
      if (action !== row.opp_type) {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "ACTION_MISMATCH" });
      }
      if ((row.confidence === "low" || row.our_status === "unknown") && action !== "review") {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "LOW_CONF_REVIEW_ONLY" });
      }

      const keyPart = row.product_code || md5x(row.shop + "|" + row.product_name);
      const dedupeKey = "rivalopp:" + action + ":" + keyPart;

      const dup = await client.query(`
        SELECT 1
          FROM public.tasks
         WHERE dedupe_key = $1
           AND status NOT IN ('done', 'cancelled')
         LIMIT 1`, [dedupeKey]);
      const dupIntent = await client.query(`
        SELECT 1
          FROM public.petstore_restock_intents
         WHERE source = 'rival_opportunity'
           AND product_code = $1
           AND created_at >= now() - interval '30 days'
         LIMIT 1`, [row.product_code || ""]);
      if (dup.rowCount || dupIntent.rowCount) {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "DUPLICATE" });
      }

      const cap = await client.query(`
        SELECT (
          SELECT count(*)::int
            FROM public.tasks
           WHERE next_holder IN ('PET-12', 'PET-22')
             AND created_at >= timezone('Asia/Shanghai', date_trunc('day', timezone('Asia/Shanghai', now())))
             AND created_at < timezone('Asia/Shanghai', date_trunc('day', timezone('Asia/Shanghai', now())) + interval '1 day')
             AND dedupe_key LIKE 'rivalopp:%'
        ) + (
          SELECT count(*)::int
            FROM public.petstore_restock_intents
           WHERE source = 'rival_opportunity'
             AND created_at >= timezone('Asia/Shanghai', date_trunc('day', timezone('Asia/Shanghai', now())))
             AND created_at < timezone('Asia/Shanghai', date_trunc('day', timezone('Asia/Shanghai', now())) + interval '1 day')
        ) AS c`);
      if (Number(cap.rows[0].c) >= 10) {
        await client.query("ROLLBACK");
        return json(res, 409, { ok: false, code: "DAILY_CAP_10" });
      }

      const day = ymdShanghai();
      const taskId = ("ro-" + day + "-" + rid()).slice(0, 32);
      const ev = evidence(row);
      const reason = reasonText(row);
      let intentId = null;

      if (action === "restock") {
        const dna = await client.query(`
          SELECT product_name, qty_30, cur_stock,
                 CASE WHEN qty_30 IS NULL THEN NULL ELSE qty_30::numeric / 30 END AS daily_avg_30
            FROM public.petstore_sku_sales_dna
           WHERE store_code = $1
             AND as_of = (
               SELECT max(as_of)
                 FROM public.petstore_sku_sales_dna
                WHERE store_code = $1
             )
             AND product_code = $2
           LIMIT 1`, [STORE_CODE, row.product_code]);
        const d = dna.rows[0] || {};
        const intent = await client.query(`
          INSERT INTO public.petstore_restock_intents
            (batch_no, store_code, product_code, product_name, cur_stock,
             qty_30, daily_avg_30, suggest_qty, verdict_reason, source, buy_unit)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rival_opportunity','piece')
          RETURNING id`,
          [
            "rivalopp-" + day,
            STORE_CODE,
            row.product_code,
            d.product_name || row.product_name,
            d.cur_stock,
            d.qty_30,
            d.daily_avg_30,
            qty,
            "竞品:" + row.shop + " 月销" + row.month_sale + (row.is_hook ? " ⚠引流价" : "")
          ]);
        intentId = intent.rows[0].id;
      }

      await client.query(`
        INSERT INTO public.tasks
          (id, title, status, source, dispatched_by, reason, for_role,
           current_holder, next_holder, verifier, acceptance_criteria,
           due_at, domain, dedupe_key)
        VALUES
          ($1,$2,'open','dataops','human_request',$3,'PET',
           '',$4,'PET-01',$5::jsonb,now()+interval '3 days','petstore',$6)`,
        [
          taskId,
          titleFor(action, row.product_name),
          reason,
          holder(action),
          JSON.stringify({ dod: dod(action), evidence: ev }),
          dedupeKey
        ]);

      await client.query(`
        INSERT INTO public.task_events
          (task_id, event_type, actor_type, actor_id, note, metadata)
        VALUES ($1,'created','human',$2,$3,$4::jsonb)`,
        [
          taskId,
          (req.user && req.user.username) || "gateway",
          "竞品机会池建单",
          JSON.stringify({ action, intent_id: intentId, evidence: ev })
        ]);

      const rb = await client.query(`
        SELECT id, title, status, next_holder, dedupe_key, created_at
          FROM public.tasks
         WHERE id = $1`, [taskId]);

      await client.query("COMMIT");
      return json(res, 200, {
        ok: true,
        task_id: taskId,
        intent_id: intentId,
        readback: rb.rows[0]
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[petstore-rival-opportunity-act]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
