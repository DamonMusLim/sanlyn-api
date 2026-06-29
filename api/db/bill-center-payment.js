import { getPool, setCors } from "../db.js";
import { actor, bad, requireFinance } from "./bill-center-auth.js";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function side(direction) {
  if (direction === "payable") return { total: "amount", status: "ap_status", paid: "ap_paid_amount", at: "ap_paid_at" };
  if (direction === "receivable") return { total: "sale_amount", status: "ar_status", paid: "ar_paid_amount", at: "ar_paid_at" };
  return null;
}

export async function markPayment(req, res) {
  setCors(req, res, "POST, PATCH, OPTIONS");
  if (!requireFinance(req, res)) return;
  const body = req.body || {};
  const s = side(body.direction);
  const id = Number(body.id);
  const paidAmount = toNum(body.paid_amount);
  if (!s) return bad(res, 400, "bad_direction", "direction must be payable or receivable");
  if (!Number.isInteger(id) || id <= 0) return bad(res, 400, "bad_id", "id required");
  if (paidAmount === null || paidAmount < 0) return bad(res, 400, "bad_paid_amount", "paid_amount must be >= 0");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT id, ${s.total} AS total FROM freight_supplier_bills WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return bad(res, 404, "not_found", "bill row not found");
    }
    const total = Number(cur.rows[0].total || 0);
    const status = paidAmount <= 0 ? "unpaid" : paidAmount < total ? "partial" : "paid";
    const paidAtSql = status === "paid" ? "COALESCE($4::timestamptz, NOW())" : "NULL";
    const r = await client.query(
      `UPDATE freight_supplier_bills
          SET ${s.status} = $1,
              ${s.paid} = $2,
              ${s.at} = ${paidAtSql},
              payment_note = $5,
              payment_updated_by = $6,
              payment_updated_at = NOW(),
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, bl_no, amount, sale_amount, ap_status, ap_paid_amount, ap_paid_at,
                  ar_status, ar_paid_amount, ar_paid_at, payment_note, payment_updated_by`,
      [status, paidAmount, id, body.paid_at || null, body.note || null, actor(req)]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
