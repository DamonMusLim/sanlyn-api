import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

const STORE_ID = "63350001";
const CHANNELS = new Set(["wecom", "cash", "other"]);

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
  return raw.trim() ? JSON.parse(raw) : {};
}

function ymd(value) {
  const s = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function text(value, fallback = null) {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}

function operatorFrom(req) {
  const u = req.user || {};
  return text(u.username) || text(u.name) || text(u.email) || text(u.id) || "未知操作人";
}

async function expectedCashInBox(client, periodFrom, periodTo) {
  const { rows } = await client.query(
    `
      WITH e AS (
        -- 🔴 0904 修两处:
        --   ① 原来按 created_at(录入时间)框范围 —— 应该按 biz_date(业务日期)。
        --      店员可能隔天补录昨天的单,按录入时间会把它算进今天,对账永远对不上。
        --   ② period 传 '2026-09-04' 会被当成 00:00:00,把当天所有记录全切在外面
        --      (实测:投币记在 09:30,应有算成 0,长短款反而变成 +95)。
        --      biz_date 是 DATE 类型,直接按日期比,不存在时分秒问题。
        SELECT id, cash_received
          FROM petstore_cash_entries
         WHERE store_id = $1
           AND biz_date >= COALESCE($2::date, '-infinity'::date)
           AND biz_date <= COALESCE($3::date, 'infinity'::date)
      ),
      cash_change AS (
        SELECT COALESCE(sum(ch.amount), 0) AS amount
          FROM petstore_cash_changes ch
          JOIN e ON e.id = ch.entry_id
         WHERE ch.channel = 'cash'
      )
      SELECT (COALESCE(sum(e.cash_received), 0) - (SELECT amount FROM cash_change))::numeric(12,2) AS expected_amount
        FROM e
    `,
    [STORE_ID, periodFrom, periodTo]
  );
  return rows[0]?.expected_amount || "0.00";
}

async function saveEntry(client, body, operator) {
  const bizDate = ymd(body.biz_date);
  const orderAmount = parseAmount(body.order_amount);
  const cashReceived = parseAmount(body.cash_received);

  if (!bizDate) throw new Error("业务日期要填成 YYYY-MM-DD。");
  if (orderAmount === null) throw new Error("订单金额要填大于等于 0 的数字，最多两位小数。");
  if (cashReceived === null) throw new Error("顾客实投金额要填大于等于 0 的数字，最多两位小数。");

  const { rows } = await client.query(
    `
      INSERT INTO petstore_cash_entries
        (store_id, order_no, biz_date, order_amount, cash_received, operator, note)
      VALUES
        ($1, $2, $3::date, $4::numeric, $5::numeric, $6, $7)
      RETURNING id, store_id, order_no, biz_date, order_amount, cash_received,
                change_due, change_paid, status, operator, note, created_at, updated_at
    `,
    [STORE_ID, text(body.order_no), bizDate, orderAmount, cashReceived, operator, text(body.note)]
  );

  await client.query("SELECT petstore_cash_refresh_entry($1)", [rows[0].id]);
  const refreshed = await client.query(
    `
      SELECT id, store_id, order_no, biz_date, order_amount, cash_received,
             change_due, change_paid, status, operator, note, created_at, updated_at
        FROM petstore_cash_entries
       WHERE id = $1
    `,
    [rows[0].id]
  );
  return refreshed.rows[0];
}

async function saveChange(client, body, operator) {
  const entryId = Number(body.entry_id);
  const amount = parseAmount(body.amount);
  const channel = text(body.channel);

  if (!Number.isInteger(entryId) || entryId <= 0) throw new Error("请选择要登记找零的现金记录。");
  if (amount === null || Number(amount) <= 0) throw new Error("找零金额要填大于 0 的数字，最多两位小数。");
  if (!CHANNELS.has(channel)) throw new Error("找零方式只能选企业微信、现金或其他。");

  const entry = await client.query(
    "SELECT id FROM petstore_cash_entries WHERE id = $1 AND store_id = $2 FOR UPDATE",
    [entryId, STORE_ID]
  );
  if (entry.rowCount === 0) throw new Error("没有找到这笔金枋店现金记录。");

  const { rows } = await client.query(
    `
      INSERT INTO petstore_cash_changes
        (entry_id, amount, channel, wecom_ref, operator)
      VALUES
        ($1, $2::numeric, $3, $4, $5)
      RETURNING id, entry_id, amount, channel, wecom_ref, operator, created_at
    `,
    [entryId, amount, channel, text(body.wecom_ref), operator]
  );

  const refreshed = await client.query(
    `
      SELECT id, order_no, biz_date, order_amount, cash_received,
             change_due, change_paid, status, updated_at
        FROM petstore_cash_entries
       WHERE id = $1
    `,
    [entryId]
  );

  return { change: rows[0], entry: refreshed.rows[0] };
}

async function saveCount(client, body, operator) {
  const countedAmount = parseAmount(body.counted_amount);
  if (countedAmount === null) throw new Error("实点金额要填大于等于 0 的数字，最多两位小数。");

  const countedAt = text(body.counted_at) || new Date().toISOString();
  const periodFrom = text(body.period_from);
  const periodTo = text(body.period_to) || countedAt;
  const expectedAmount = await expectedCashInBox(client, periodFrom, periodTo);

  const { rows } = await client.query(
    `
      INSERT INTO petstore_cash_box_counts
        (store_id, counted_at, counted_amount, expected_amount, period_from, period_to, operator, note)
      VALUES
        ($1, $2::timestamptz, $3::numeric, $4::numeric, $5::timestamptz, $6::timestamptz, $7, $8)
      RETURNING id, store_id, counted_at, counted_amount, expected_amount,
                diff, period_from, period_to, operator, note, created_at
    `,
    [STORE_ID, countedAt, countedAmount, expectedAmount, periodFrom, periodTo, operator, text(body.note)]
  );

  return rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, message: "这个接口只负责登记现金箱记录，请用 POST。" });
  }

  if (!requireAuth(req, res)) return;

  const writable = await requireWritable(req, res, "cost");
  if (!writable) return;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, message: "提交内容不是有效 JSON，请检查后再保存。" });
  }

  const action = text(body.action);
  const operator = operatorFrom(req);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    let data;
    if (action === "entry") {
      data = await saveEntry(client, body, operator);
    } else if (action === "change") {
      data = await saveChange(client, body, operator);
    } else if (action === "count") {
      data = await saveCount(client, body, operator);
    } else {
      throw new Error("请选择要做的事：记投币、记找零或记点钞。");
    }

    await client.query("COMMIT");
    return sendJson(res, 200, {
      ok: true,
      message: action === "change"
        ? "已登记找零。注意：系统只记账，没有发起企业微信转账。"
        : "已保存。",
      data,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return sendJson(res, 400, { ok: false, message: error.message || "保存失败，请检查金额和日期。" });
  } finally {
    client.release();
  }
}