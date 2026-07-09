// Internal-only endpoint: record AR (应收) follow-up status from a WeChat text reply.
// Auth: X-Internal-Key header must match process.env.INTERNAL_SERVICE_KEY
// POST { order_no, code } — code: 1=已催 2=客户已上传付款凭证 3=客户要求下月付款
// 纯记录状态到 order_diary_notes，不触发任何对外发送。
import { getPool } from "../db.js";
import { timingSafeEqual } from "crypto";
import { ensureOrderDiaryNotes } from "../db/order-diary-notes.js";

const CODE_TEXT = {
  "1": "催款跟进：已联系客户催款",
  "2": "催款跟进：客户已上传付款凭证",
  "3": "催款跟进：客户要求下月付款",
};

function checkKey(req) {
  const key = process.env.INTERNAL_SERVICE_KEY || "";
  if (!key) return false;
  const provided = String(req.headers["x-internal-key"] || "");
  if (provided.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(key));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!checkKey(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const { order_no, code, source } = req.body || {};
  const orderNo = String(order_no || "").trim();
  const codeStr = String(code || "").trim();
  if (!orderNo) return res.status(400).json({ ok: false, error: "order_no 必填" });
  const noteText = CODE_TEXT[codeStr];
  if (!noteText) return res.status(400).json({ ok: false, error: "code 必须是 1/2/3" });

  const pool = getPool();
  try {
    const orderRes = await pool.query(
      `SELECT id, contract_no FROM orders WHERE order_no=$1 LIMIT 1`, [orderNo]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ ok: false, error: `订单 ${orderNo} 不存在` });

    await ensureOrderDiaryNotes(pool);
    const r = await pool.query(
      `INSERT INTO order_diary_notes (order_id, contract_no, note_text, note_type, visibility, author_name, raw)
       VALUES ($1, $2, $3, 'ar_followup', 'internal', $4, $5::jsonb) RETURNING id`,
      [order.id, order.contract_no || null, noteText, source || "wechat_reply", JSON.stringify({ code: codeStr, order_no: orderNo })]
    );
    return res.status(200).json({ ok: true, note_id: r.rows[0].id, order_no: orderNo, status: noteText });
  } catch (err) {
    console.error("[ar-followup]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
