import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

const MODULE = "membership_card";

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveInt(value) {
  const n = Number(value ?? 1);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

function ymd(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function validateInput(body) {
  const cardId = Number.parseInt(body?.cardId ?? "", 10);
  const usedTimes = positiveInt(body?.usedTimes);
  if (!Number.isInteger(cardId) || cardId <= 0) badRequest("cardId 必填");
  if (!usedTimes) badRequest("usedTimes 必须是正整数");
  return {
    cardId,
    usedTimes,
    petId: cleanText(body?.petId, 80),
    revenue: optionalNumber(body?.revenue),
    operator: cleanText(body?.operator, 80),
    remark: cleanText(body?.remark, 500),
  };
}

async function loadCard(client, cardId) {
  const { rows } = await client.query(
    `SELECT id, store_code, card_no, pet_id, status, expires_at::date AS expires_on,
            remaining_times, (expires_at >= CURRENT_DATE) AS unexpired
       FROM member_cards
      WHERE id = $1`,
    [cardId],
  );
  return rows[0] || null;
}

function assertUsableCard(card, storeCode, usedTimes) {
  if (!card) badRequest("这张卡不存在");
  if (card.store_code !== storeCode) badRequest("不许核销别的店的卡");
  if (card.status !== "active") badRequest(`这张卡状态是 ${card.status || "空"},不能核销`);
  if (!card.expires_on) badRequest("这张卡未设置有效期,不能核销");
  if (!card.unexpired) badRequest(`这张卡 ${ymd(card.expires_on)} 已过期`);
  const remaining = Number(card.remaining_times || 0);
  if (remaining < usedTimes) badRequest(`只剩 ${remaining} 次,核销不了 ${usedTimes} 次`);
}

async function useCard(req, gate) {
  const storeCode = cleanText(gate?.storeCode, 32);
  if (!storeCode) {
    const err = new Error("门店权限缺失");
    err.statusCode = 403;
    throw err;
  }
  const input = validateInput(req.body || {});
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const card = await loadCard(client, input.cardId);
    assertUsableCard(card, storeCode, input.usedTimes);
    await client.query(
      `INSERT INTO card_usages
        (store_code, card_id, pet_id, used_times, revenue, operator, used_at, remark)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [
        storeCode,
        input.cardId,
        input.petId || card.pet_id || null,
        input.usedTimes,
        input.revenue,
        input.operator,
        input.remark,
      ],
    );
    const updated = await client.query(
      `UPDATE member_cards
          SET used_times = used_times + $1,
              remaining_times = remaining_times - $1
        WHERE id = $2
          AND store_code = $3
          AND remaining_times >= $1
      RETURNING card_no, remaining_times`,
      [input.usedTimes, input.cardId, storeCode],
    );
    if (updated.rowCount === 0) badRequest("次数不足,请刷新重试");
    await client.query("COMMIT");
    return {
      ok: true,
      cardNo: updated.rows[0].card_no,
      usedTimes: input.usedTimes,
      remainingAfter: updated.rows[0].remaining_times,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;
  const gate = await requireWritable(req, res, MODULE);
  if (!gate) return;
  try {
    return json(res, 200, await useCard(req, gate));
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "server_error" });
  }
}
