// doc-sends.js — /api/db/doc-sends/*
// Document send/receive/confirm loop for PI/PO.
// Routes: /send  /view  /download  /reply  /list  /access-log
import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const APP_BASE   = process.env.APP_BASE || "https://admin.sanlyn.cn";
const MINI_PUSH  = "http://100.87.134.113:3799/api/push";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function wxPush(msg) {
  fetch(MINI_PUSH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "damon", msg }),
    signal: AbortSignal.timeout(6000),
  }).catch(() => {});
}

// Validate token → return doc_sends row or send error response.
// Returns null if error was already sent.
async function resolveToken(token, res) {
  if (!token) { res.status(400).json({ error: "缺少 token" }); return null; }
  const pool = getPool();
  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT * FROM doc_sends WHERE token_hash=$1 AND expires_at > NOW() AND status != 'revoked'`,
    [hash]
  );
  if (!rows.length) { res.status(404).json({ error: "链接无效或已过期" }); return null; }
  return rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const fullPath = (req.path || req.url || "").replace(/\?.*/, "");
  const seg = fullPath.split("/").filter(Boolean).pop() || "";

  // ── POST /send ────────────────────────────────────────────────
  if (req.method === "POST" && seg === "send") {
    if (!requireAuth(req, res)) return;
    const { order_id, doc_type, recipient, note, expires_hours } = req.body || {};
    if (!order_id || !doc_type || !recipient) {
      return res.status(400).json({ error: "order_id, doc_type, recipient 必填" });
    }

    const orderRes = await pool.query(
      `SELECT id, order_no, company_name_cn FROM orders WHERE id=$1`,
      [order_id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: "订单不存在" });
    const order = orderRes.rows[0];

    const raw  = crypto.randomBytes(32).toString("hex");
    const hash = rawToHash(raw);
    const ttl  = parseInt(expires_hours) || 72;
    const meta = {
      order_no:     order.order_no,
      doc_type,
      recipient,
      company_name: order.company_name_cn || "",
      sent_by:      (req.user && (req.user.account || req.user.sub)) || "unknown",
      note:         note || null,
    };

    const ins = await pool.query(
      `INSERT INTO doc_sends (order_id, doc_type, recipient, token_hash, meta, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' hours')::interval, $7)
       RETURNING id`,
      [order_id, doc_type, recipient, hash, JSON.stringify(meta), ttl, meta.sent_by]
    );

    return res.json({
      token:         raw,
      url:           APP_BASE + "/doc-view/" + raw,
      doc_sends_id:  ins.rows[0].id,
    });
  }

  // ── GET /view?token=RAW ───────────────────────────────────────
  if (req.method === "GET" && seg === "view") {
    const token = req.query.token;
    const row   = await resolveToken(token, res);
    if (!row) return;

    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
    const ua = req.headers["user-agent"] || "";
    const entry = { at: new Date().toISOString(), ip, ua, action: "open" };

    const newStatus = row.status === "sent" ? "opened" : row.status;
    await pool.query(
      `UPDATE doc_sends
         SET access_log = access_log || $1::jsonb,
             status     = CASE WHEN status='sent' THEN 'opened' ELSE status END
       WHERE id=$2`,
      [JSON.stringify(entry), row.id]
    );

    return res.json({
      ok:         true,
      meta:       row.meta,
      reply_data: row.reply_data,
      status:     newStatus,
      doc_type:   row.doc_type,
      order_id:   row.order_id,
      expires_at: row.expires_at,
    });
  }

  // ── POST /download?token=RAW ──────────────────────────────────
  // Streams the PDF directly — no secondary auth needed.
  if (req.method === "POST" && seg === "download") {
    const token = req.query.token;
    const row   = await resolveToken(token, res);
    if (!row) return;

    const ip    = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
    const ua    = req.headers["user-agent"] || "";
    const entry = { at: new Date().toISOString(), ip, ua, action: "download" };

    const STATUS_ORDER = ["sent", "opened", "downloaded", "replied", "confirmed"];
    const curIdx = STATUS_ORDER.indexOf(row.status);
    const newStatus = curIdx < STATUS_ORDER.indexOf("downloaded") ? "downloaded" : row.status;

    await pool.query(
      `UPDATE doc_sends
         SET access_log = access_log || $1::jsonb,
             status     = $2
       WHERE id=$3`,
      [JSON.stringify(entry), newStatus, row.id]
    );

    // Return redirect URL; front-end calls window.open(pdf_url).
    // documents.js uses a doc-view-key bypass (see auth.js line ~281) so no user token needed
    // when called with the internal header.
    return res.json({
      pdf_url: `/api/db/documents?type=${row.doc_type}&id=${row.order_id}`,
    });
  }

  // ── POST /reply ───────────────────────────────────────────────
  if (req.method === "POST" && seg === "reply") {
    const body  = req.body || {};
    const token = body.token || req.query.token;
    const row   = await resolveToken(token, res);
    if (!row) return;

    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";

    if (row.doc_type === "po") {
      // PO reply: delivery_date required
      const { delivery_date, note } = body;
      if (!delivery_date || !/^\d{4}-\d{2}-\d{2}$/.test(delivery_date)) {
        return res.status(400).json({ error: "delivery_date 格式应为 YYYY-MM-DD" });
      }

      const replyData = {
        delivery_date,
        note:             note || null,
        confirmed_at:     new Date().toISOString(),
        confirmed_by_ip:  ip,
      };

      await pool.query(
        `UPDATE doc_sends SET reply_data=$1, status='replied' WHERE id=$2`,
        [JSON.stringify(replyData), row.id]
      );

      // Sync delivery_date into orders.raw
      await pool.query(
        `UPDATE orders
           SET raw = jsonb_set(COALESCE(raw,'{}'), '{delivery_date}', to_jsonb($1::text))
         WHERE id=$2`,
        [delivery_date, row.order_id]
      );

      wxPush(`📦 PO已确认：${row.meta?.order_no || row.order_id} 交货日期 ${delivery_date}`);
      return res.json({ ok: true });
    }

    if (row.doc_type === "pi") {
      // PI reply: action = 'confirm' | 'reject'
      const { action, note } = body;
      if (!action || !["confirm", "reject"].includes(action)) {
        return res.status(400).json({ error: "action 必须是 confirm 或 reject" });
      }

      const replyData = {
        action,
        note:             note || null,
        confirmed_at:     new Date().toISOString(),
        confirmed_by_ip:  ip,
      };

      const newStatus = action === "confirm" ? "confirmed" : "replied";
      await pool.query(
        `UPDATE doc_sends SET reply_data=$1, status=$2 WHERE id=$3`,
        [JSON.stringify(replyData), newStatus, row.id]
      );

      if (action === "confirm") {
        await pool.query(
          `UPDATE orders SET status='confirmed' WHERE id=$1`,
          [row.order_id]
        );
        wxPush(`✅ PI已确认：${row.meta?.order_no || row.order_id}`);
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "不支持的 doc_type: " + row.doc_type });
  }

  // ── GET /list?order_id=X ──────────────────────────────────────
  if (req.method === "GET" && seg === "list") {
    if (!requireAuth(req, res)) return;
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ error: "缺少 order_id" });
    const { rows } = await pool.query(
      `SELECT id, doc_type, recipient, status, sent_at, reply_data, meta, expires_at
         FROM doc_sends WHERE order_id=$1 ORDER BY sent_at DESC`,
      [order_id]
    );
    return res.json({ ok: true, rows });
  }

  // ── GET /access-log?id=X ──────────────────────────────────────
  if (req.method === "GET" && seg === "access-log") {
    if (!requireAuth(req, res)) return;
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "缺少 id" });
    const { rows } = await pool.query(
      `SELECT access_log FROM doc_sends WHERE id=$1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: "记录不存在" });
    return res.json({ ok: true, access_log: rows[0].access_log });
  }

  return res.status(404).json({ error: "未知路由: " + seg });
}
