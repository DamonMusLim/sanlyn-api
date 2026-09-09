import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  return JSON.parse(raw);
}

function parseCostMonth(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;

  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;

  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function getOperator(user) {
  return (
    user?.username ||
    user?.name ||
    user?.email ||
    user?.id ||
    "unknown"
  );
}

async function ensureAuth(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  return user;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const user = await ensureAuth(req, res);
  if (!user) return;

  // 🔴 requireWritable 失败时返回 null,不是 false。写 `=== false` 等于闸没装:
  //    实测返回了 403「模块没开通」,数据照样写进库里。用 !result 才对。
  const writableResult = await requireWritable(req, res, "cost");
  if (!writableResult) return;

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "invalid_json", message: error.message });
    return;
  }

  const subjectId = Number(body.subject_id);
  const categoryCode = typeof body.category_code === "string" ? body.category_code.trim() : "";
  const costMonth = parseCostMonth(body.cost_month);
  const amount = parseAmount(body.amount);
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim();

  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    sendJson(res, 400, { ok: false, error: "invalid_subject_id" });
    return;
  }

  if (!categoryCode) {
    sendJson(res, 400, { ok: false, error: "invalid_category_code" });
    return;
  }

  if (!costMonth) {
    sendJson(res, 400, { ok: false, error: "invalid_cost_month", message: "cost_month must be YYYY-MM" });
    return;
  }

  if (amount === null) {
    sendJson(res, 400, { ok: false, error: "invalid_amount", message: "amount must be a non-negative number" });
    return;
  }

  const operator = String(getOperator(user));
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const subjectResult = await client.query(
      `
        SELECT id, subject_type, subject_code, subject_name, store_code
        FROM petstore_cost_subjects
        WHERE id = $1
          AND is_active = TRUE
        FOR SHARE
      `,
      [subjectId]
    );

    if (subjectResult.rowCount === 0) {
      await client.query("ROLLBACK");
      sendJson(res, 404, { ok: false, error: "subject_not_found" });
      return;
    }

    const categoryResult = await client.query(
      `
        SELECT code, name
        FROM petstore_cost_categories
        WHERE code = $1
          AND is_active = TRUE
        FOR SHARE
      `,
      [categoryCode]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");
      sendJson(res, 404, { ok: false, error: "category_not_found" });
      return;
    }

    const oldResult = await client.query(
      `
        SELECT id, amount, note, updated_by, updated_at
        FROM petstore_monthly_cost_entries
        WHERE subject_id = $1
          AND category_code = $2
          AND cost_month = $3::date
        FOR UPDATE
      `,
      [subjectId, categoryCode, costMonth]
    );

    const oldEntry = oldResult.rows[0] || null;
    const action = oldEntry ? "update" : "create";

    const saveResult = await client.query(
      `
        INSERT INTO petstore_monthly_cost_entries (
          subject_id,
          category_code,
          cost_month,
          amount,
          note,
          updated_by,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3::date, $4::numeric, $5, $6, now(), now())
        ON CONFLICT (subject_id, category_code, cost_month)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          note = EXCLUDED.note,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        RETURNING
          id,
          subject_id,
          category_code,
          cost_month,
          amount,
          note,
          updated_by,
          created_at,
          updated_at
      `,
      [subjectId, categoryCode, costMonth, amount, note, operator]
    );

    const savedEntry = saveResult.rows[0];

    await client.query(
      `
        INSERT INTO petstore_cost_audit_logs (
          entry_id,
          action,
          subject_id,
          category_code,
          cost_month,
          old_amount,
          new_amount,
          old_note,
          new_note,
          operator,
          request_payload,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::date,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::jsonb,
          now()
        )
      `,
      [
        savedEntry.id,
        action,
        subjectId,
        categoryCode,
        costMonth,
        oldEntry?.amount ?? null,
        savedEntry.amount,
        oldEntry?.note ?? null,
        savedEntry.note,
        operator,
        JSON.stringify({
          subject_id: subjectId,
          category_code: categoryCode,
          cost_month: body.cost_month,
          amount,
          note
        })
      ]
    );

    await client.query("COMMIT");

    sendJson(res, 200, {
      ok: true,
      action,
      entry: {
        id: savedEntry.id,
        subject_id: savedEntry.subject_id,
        category_code: savedEntry.category_code,
        cost_month: savedEntry.cost_month,
        amount: Number(savedEntry.amount),
        note: savedEntry.note,
        source: "手工录入",
        source_month: costMonth.slice(0, 7),
        updated_by: savedEntry.updated_by,
        updated_at: savedEntry.updated_at
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[petstore-cost-save] POST failed", error);
    sendJson(res, 500, {
      ok: false,
      error: "save_failed",
      message: error.message
    });
  } finally {
    client.release();
  }
}