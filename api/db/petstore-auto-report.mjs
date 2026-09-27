// 「今天系统自己做了什么」—— 0927 Damon:「该打折就打折,该卖就卖,不用通知我;只要给我看今天系统自动做了什么,让我看下对不对」
// 只读汇总当天(北京时间)系统自动动作 + 老板一键撤回自动改价。
// 数据:petstore_price_intents(decided_note 以 [system-auto] 开头,见 mini ~/bin/pricing-auto-approve.py)、
//       petstore_stock_reports.gdc_writeoff_*(确认丢失自动报损)、petstore_restock_intents / tasks 自动过期(approval-refresh.sql)
const BOSS_IDS = String(process.env.BOSS_EMPLOYEE_IDS || "35").split(",").map((x) => x.trim()).filter(Boolean);

function json(res, status, data) { return res.status(status).json(data); }
function isBoss(empId) { return BOSS_IDS.includes(String(empId || "")); }

async function defaultPoolFactory() {
  const { getPool } = await import("./db.js");
  return getPool();
}

async function defaultSetCors(req, res, methods) {
  const { setCors } = await import("./db.js");
  return setCors(req, res, methods);
}

async function requireStaff(req, pool) {
  const { verifyToken } = await import("./auth.js");
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) return { error: "unauthorized" };
  const r = await pool.query(
    `SELECT id, name, role, company_code, employment_status FROM hr_employees WHERE id=$1`, [claims.employee_id]);
  const me = r.rows[0];
  if (!me || me.employment_status !== "active") return { error: "forbidden" };
  return { empId: claims.employee_id, me };
}

const TODAY = `(now() AT TIME ZONE 'Asia/Shanghai')::date`;

export async function todayReport(pool) {
  const price = await pool.query(
    `SELECT id, product_code, product_name, channel, old_price, target_price, status, result, decided_note
       FROM petstore_price_intents
      WHERE decided_note LIKE '[system-auto]%' AND (decided_at AT TIME ZONE 'Asia/Shanghai')::date = ${TODAY}
      ORDER BY (status='stale'), id`);
  const did = [], skipped = [];
  for (const r of price.rows) {
    const note = String(r.decided_note || "").replace(/^\[system-auto\]/, "").replace(/ \| 已撤回.*/, "");
    const row = {
      id: r.id, product_code: r.product_code, name: r.product_name, channel: r.channel,
      old_price: Number(r.old_price), new_price: Number(r.target_price), note,
      undone: /已撤回/.test(String(r.decided_note || "")),
      state: r.status === "applied" ? "已改好" : r.status === "failed" ? "没改成" : r.status === "stale" ? "没做" : "排队改价中",
      result: r.result || "",
    };
    (r.status === "stale" ? skipped : did).push(row);
  }
  // 外卖渠道「没做」数量大且都是同一个原因,合成一行,别刷屏
  const skippedTakeout = skipped.filter((x) => /外卖渠道/.test(x.note)).length;
  const skippedOther = skipped.filter((x) => !/外卖渠道/.test(x.note));

  const writeoff = await pool.query(
    `SELECT id, product_name, confirmed_loss_qty, gdc_writeoff_result, gdc_writeoff_order_no
       FROM petstore_stock_reports
      WHERE gdc_writeoff_at IS NOT NULL AND (gdc_writeoff_at AT TIME ZONE 'Asia/Shanghai')::date = ${TODAY}
      ORDER BY id`);
  const restock = await pool.query(
    `SELECT product_name, decided_note FROM petstore_restock_intents
      WHERE status='expired' AND decided_by='system-refresh' AND (decided_at AT TIME ZONE 'Asia/Shanghai')::date = ${TODAY}
      ORDER BY id`);
  const tasks = await pool.query(
    `SELECT title FROM tasks
      WHERE status='cancelled' AND source='dataops' AND dedupe_key ~ '^risk:'
        AND (closed_at AT TIME ZONE 'Asia/Shanghai')::date = ${TODAY}
      ORDER BY id`);
  // 外卖拣货完成 → 自动同步果冻橙(pickedV2)的结果,没同步上的要看见
  const takeout = await pool.query(
    `SELECT order_no, bool_or(gdc_synced_at IS NOT NULL) AS ok, max(gdc_result) AS result
       FROM petstore_takeout_picks
      WHERE completed_at IS NOT NULL AND (completed_at AT TIME ZONE 'Asia/Shanghai')::date = ${TODAY}
      GROUP BY order_no ORDER BY max(completed_at)`);
  return {
    takeout: takeout.rows.map((r) => ({ order_no: r.order_no, ok: !!r.ok, result: r.result || "" })),
    price_done: did,
    price_skipped: skippedOther,
    price_skipped_takeout: skippedTakeout,
    writeoff: writeoff.rows.map((r) => ({
      id: r.id, name: r.product_name, qty: Number(r.confirmed_loss_qty || 0),
      ok: r.gdc_writeoff_result === "ok", result: r.gdc_writeoff_result || "", order_no: r.gdc_writeoff_order_no || "",
    })),
    expired: [
      ...restock.rows.map((r) => ({ kind: "补货", name: r.product_name, note: r.decided_note })),
      ...tasks.rows.map((r) => ({ kind: "报损/下架", name: r.title, note: "系统里已经没货了,自动关掉" })),
    ],
  };
}

// 撤回 = 反向下一条「老板直通」改价指令(status=pending,Studio 执行器 5 分钟内认领),原价改回去
export async function undoPrice(pool, me, id) {
  const r = await pool.query(
    `SELECT id, product_code, product_name, channel, old_price, target_price, status, decided_note
       FROM petstore_price_intents WHERE id=$1`, [id]);
  const row = r.rows[0];
  if (!row || !String(row.decided_note || "").startsWith("[system-auto]")) return { status: 404, body: { success: false, error: "not_auto_change" } };
  if (/已撤回/.test(String(row.decided_note || ""))) return { status: 400, body: { success: false, error: "already_undone" } };
  if (!["applied", "approved", "applying"].includes(row.status)) return { status: 400, body: { success: false, error: "nothing_to_undo" } };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (row.status === "approved") {
      // 还没执行:直接取消,不用反向改价
      await client.query(`UPDATE petstore_price_intents SET status='stale', decided_note=decided_note || ' | 已撤回(未执行)' WHERE id=$1`, [id]);
    } else {
      await client.query(
        `INSERT INTO petstore_price_intents (product_code, product_name, channel, old_price, target_price, reason, author, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',now())`,
        [row.product_code, row.product_name, row.channel || "门店", row.target_price, row.old_price,
          `撤回系统自动改价#${row.id}`, me?.name || "Damon"]);
      await client.query(`UPDATE petstore_price_intents SET decided_note=decided_note || ' | 已撤回' WHERE id=$1`, [id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { status: 200, body: { success: true } };
}

export function makeHandler({ poolFactory = defaultPoolFactory, setCorsFn = defaultSetCors, verifyStaff = requireStaff } = {}) {
  return async function handler(req, res) {
    await setCorsFn(req, res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    const pool = await poolFactory();
    const auth = await verifyStaff(req, pool);
    if (auth.error) return json(res, auth.error === "unauthorized" ? 401 : 403, { success: false, error: auth.error });
    if (!isBoss(auth.empId)) return json(res, 403, { success: false, error: "boss_only" });
    const b = req.method === "GET" ? req.query || {} : req.body || {};
    const action = String(b.action || "today").slice(0, 40);
    try {
      if (action === "today") return json(res, 200, { success: true, data: await todayReport(pool) });
      if (action === "undo_price" && req.method === "POST") {
        const out = await undoPrice(pool, auth.me, Number(b.id));
        return json(res, out.status, out.body);
      }
      return json(res, 400, { success: false, error: "bad_action" });
    } catch (e) {
      return json(res, 500, { success: false, error: e.message || "server_error" });
    }
  };
}

export default makeHandler();
