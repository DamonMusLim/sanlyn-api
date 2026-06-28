// /api/factory-confirm.js  v1.0  2026-06-22
// Public (token-auth) endpoint for factory order confirmation.
// Separate from factory-fill.js to avoid touching the existing fill flow.
//
//   GET  ?token=<tok>
//     → { ok, status:'pending|confirmed|expired|invalid',
//         order:{order_no,buyer_name,products,total_qty,etd,delivery_date},
//         confirmation?:{confirmed_lines,confirmed_ship_date,note,confirmed_at} }
//
//   POST { token, confirmed_lines:[{idx,name,confirmed_qty}], etd, note? }
//     → { ok, confirmation:{order_no,confirmed_at,confirmed_ship_date} }
//     → 409 already_confirmed  (row-lock, not index trick)
//     → 410 token_expired
//     → 404 token_not_found

import { getPool, setCors } from "./db.js";

const WECOM_URL = process.env.WECOM_WEBHOOK_URL;

async function sendWecom(text) {
  if (!WECOM_URL) return;
  try {
    await fetch(WECOM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
  } catch (e) {
    console.warn("[factory-confirm] wecom push failed:", e.message);
  }
}

async function resolveToken(pool, token) {
  const tr = await pool.query(
    `SELECT it.company_code, it.purpose, it.expires_at,
            c.name_cn AS factory_name, c.raw AS factory_raw
       FROM _idx_tokens it
       LEFT JOIN customers c ON c.company_code = it.company_code
      WHERE it.token = $1`,
    [token]
  );
  if (!tr.rows.length) return { status: "invalid" };
  const row = tr.rows[0];
  if (new Date(row.expires_at) < new Date()) return { status: "expired", row };

  // Find the token record inside customers.raw.activeTokens to get order_no
  const activeTokens = row.factory_raw?.activeTokens || [];
  const trec = activeTokens.find((t) => t.token === token) || null;
  const orderNo = trec?.orderNo || null;

  return { status: "ok", row, trec, orderNo };
}

// Fields the factory is allowed to see — no cost/margin/factory pricing
function cropOrder(o) {
  if (!o) return null;
  const raw = o.raw || {};
  const products = (raw.products || o.products || []).map((p, idx) => ({
    idx,
    name: p.productName || p.name || p.desc || `产品${idx + 1}`,
    qty:  p.qty ?? p.quantity ?? p.boxes ?? null,
    unit: p.unit || "箱",
  }));
  return {
    order_no:      o.order_no,
    buyer_name:    o.company_name_cn || o.company_name_en || o.company_code || "",
    total_qty:     o.total_qty || null,
    etd:           o.etd || null,
    delivery_date: o.delivery_date || null,
    status:        o.status || null,
    products,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const token = (req.query.token || req.query.t || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const ctx = await resolveToken(pool, token);
    if (ctx.status === "invalid") return res.status(404).json({ ok: false, status: "invalid", error: "token_not_found" });
    if (ctx.status === "expired") return res.status(410).json({ ok: false, status: "expired", error: "token_expired" });

    let order = null;
    let confirmation = null;

    if (ctx.orderNo) {
      const or = await pool.query(
        `SELECT order_no, company_code, company_name_cn, company_name_en,
                total_qty, etd, delivery_date, status,
                confirmed_ship_date, confirmed_qty, factory_confirmed_at,
                factory_confirmed_by, factory_confirmation_id,
                products, raw
           FROM orders WHERE order_no = $1`,
        [ctx.orderNo]
      );
      if (or.rows.length) {
        const o = or.rows[0];
        order = cropOrder(o);

        // Return existing confirmation if present
        if (o.factory_confirmed_at) {
          confirmation = {
            confirmed_lines:     o.confirmed_qty || [],
            confirmed_ship_date: o.confirmed_ship_date,
            note:                null,
            confirmed_at:        o.factory_confirmed_at,
            confirmed_by:        o.factory_confirmed_by,
          };
          // Fetch note from factory_confirmations
          if (o.factory_confirmation_id) {
            const cr = await pool.query(
              "SELECT note FROM factory_confirmations WHERE id = $1",
              [o.factory_confirmation_id]
            );
            if (cr.rows.length) confirmation.note = cr.rows[0].note;
          }
        }
      }
    }

    const confirmStatus = confirmation ? "confirmed" : "pending";
    return res.status(200).json({
      ok: true,
      status: confirmStatus,
      factory_name: ctx.row.factory_name || null,
      order,
      confirmation,
      expires_at: ctx.row.expires_at,
    });
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const token = (body.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const ctx = await resolveToken(pool, token);
    if (ctx.status === "invalid") return res.status(404).json({ ok: false, error: "token_not_found" });
    if (ctx.status === "expired") return res.status(410).json({ ok: false, error: "token_expired" });
    if (!ctx.orderNo)             return res.status(400).json({ ok: false, error: "token has no associated order" });

    const etd = (body.etd || "").trim();
    if (!etd || !/^\d{4}-\d{2}-\d{2}$/.test(etd)) {
      return res.status(400).json({ ok: false, error: "etd is required (YYYY-MM-DD)" });
    }

    const confirmedLines = Array.isArray(body.confirmed_lines) ? body.confirmed_lines : [];
    const note = (body.note || "").trim() || null;
    const confirmedBy = ctx.row.factory_name || ctx.row.company_code || "factory";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Row-lock on the order to prevent race
      const lockRes = await client.query(
        `SELECT order_no, factory_confirmed_at FROM orders WHERE order_no = $1 FOR UPDATE`,
        [ctx.orderNo]
      );
      if (!lockRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "order not found" });
      }
      if (lockRes.rows[0].factory_confirmed_at) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "already_confirmed",
          message: "此订单已确认过，如需修改请联系 Sanlyn。",
          confirmed_at: lockRes.rows[0].factory_confirmed_at,
        });
      }

      // Write confirmation record
      const insRes = await client.query(
        `INSERT INTO factory_confirmations
           (order_no, token_id, company_code, confirmed_lines, confirmed_ship_date, note, confirmed_by, source, version)
         VALUES ($1, $2, $3, $4::jsonb, $5::date, $6, $7, 'token', 1)
         RETURNING id`,
        [
          ctx.orderNo,
          token,
          ctx.row.company_code,
          JSON.stringify(confirmedLines),
          etd,
          note,
          confirmedBy,
        ]
      );
      const confirmId = insRes.rows[0].id;

      // Update orders snapshot
      const now = new Date().toISOString();
      await client.query(
        `UPDATE orders SET
           confirmed_ship_date      = $1::date,
           confirmed_qty            = $2::jsonb,
           factory_confirmed_at     = NOW(),
           factory_confirmed_by     = $3,
           factory_confirmation_id  = $4,
           updated_at               = NOW()
         WHERE order_no = $5`,
        [etd, JSON.stringify(confirmedLines), confirmedBy, confirmId, ctx.orderNo]
      );

      await client.query("COMMIT");

      // WeChat push (fire-and-forget, outside transaction)
      const pushText = `📦 工厂确认发货\n订单：${ctx.orderNo}\n工厂：${confirmedBy}\nETD：${etd}${note ? `\n备注：${note}` : ""}`;
      sendWecom(pushText);

      return res.status(200).json({
        ok: true,
        confirmation: {
          order_no:            ctx.orderNo,
          confirmed_at:        now,
          confirmed_ship_date: etd,
          confirmed_lines:     confirmedLines,
          note,
        },
      });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[factory-confirm] POST error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ ok: false, error: "method not allowed" });
}
