// orders-status.js
// Order state-machine + factory editing + forward-to-factory.
// One endpoint, multiple actions via body.action.
//
// POST /api/db/orders-status
//   body.action = 'forward'         { orderId, mode: 'confirm'|'quote', channels: [...], recipients: [...] }
//   body.action = 'set_status'      { orderId, status, byUser? }
//   body.action = 'factory_update'  { orderId, products: [...] }   // factory edits unit_price/trade_terms
//
// All transitions append to orders.status_history JSONB.
// Forward writes orders.forward_meta JSONB and notifies channels (placeholder).

import { getPool, setCors } from "../db.js";

// State machine
var ALLOWED_TRANSITIONS = {
  draft:              ["pending_confirm", "pending_quote", "submitted"],
  pending_confirm:    ["factory_confirmed", "draft"],
  pending_quote:      ["factory_confirmed", "draft"],
  factory_confirmed:  ["submitted", "draft"],
  submitted:          ["shipped"],
  shipped:            ["delivered"],
  delivered:          [],
};

function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.includes(to);
}

async function appendHistory(pool, orderId, fromStatus, toStatus, byUser, extra) {
  var entry = {
    from: fromStatus,
    to: toStatus,
    at: new Date().toISOString(),
    by: byUser || "system",
  };
  if (extra) entry.extra = extra;
  await pool.query(
    "UPDATE orders SET status = $1, status_history = COALESCE(status_history,'[]'::jsonb) || $2::jsonb WHERE id = $3",
    [toStatus, JSON.stringify(entry), orderId]
  );
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  var pool = getPool();
  var body = req.body || {};
  var action = body.action;
  var orderId = body.orderId;
  if (!action || !orderId) return res.status(400).json({ error: "action + orderId required" });

  try {
    // Load current order
    var cur = await pool.query("SELECT id, status, factory_code, export_mode, products FROM orders WHERE id = $1", [orderId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: "order not found" });
    var order = cur.rows[0];

    // ─── action: forward ───
    if (action === "forward") {
      var mode = body.mode || "confirm";          // 'confirm' | 'quote'
      var channels   = Array.isArray(body.channels)   ? body.channels   : ["email"];
      var recipients = Array.isArray(body.recipients) ? body.recipients : [];
      if (!["confirm", "quote"].includes(mode)) return res.status(400).json({ error: "mode must be 'confirm' or 'quote'" });

      var nextStatus = mode === "quote" ? "pending_quote" : "pending_confirm";
      if (!canTransition(order.status, nextStatus)) {
        return res.status(409).json({ error: "cannot forward from status " + order.status });
      }

      var meta = {
        mode,
        channels,
        recipients,
        sent_at: new Date().toISOString(),
        sent_by: body.byUser || "system",
        factory_response_at: null,
        alerted_sanlyn: order.export_mode === "agent",
      };

      await pool.query(
        "UPDATE orders SET forward_meta = $1::jsonb WHERE id = $2",
        [JSON.stringify(meta), orderId]
      );
      await appendHistory(pool, orderId, order.status, nextStatus, body.byUser, { mode, channels });

      // TODO: fire actual notifications (email / WeChat / portal push)
      // queueEmail({ to: recipients, ... })
      // wecomNotify({ ... })

      return res.status(200).json({ success: true, status: nextStatus, forward_meta: meta });
    }

    // ─── action: set_status ───
    if (action === "set_status") {
      var to = body.status;
      if (!to) return res.status(400).json({ error: "status required" });
      if (!canTransition(order.status, to)) {
        return res.status(409).json({ error: "illegal transition " + order.status + " → " + to });
      }
      await appendHistory(pool, orderId, order.status, to, body.byUser);
      return res.status(200).json({ success: true, status: to });
    }

    // ─── action: factory_update ───
    // Factory fills/edits unit_price + trade_terms in products[].
    // Auto-transitions to factory_confirmed when complete.
    if (action === "factory_update") {
      var newProducts = body.products;
      if (!Array.isArray(newProducts)) return res.status(400).json({ error: "products array required" });

      // Whitelist: factory can only set unit_price + trade_terms (others rejected)
      var existing = (typeof order.products === "string" ? JSON.parse(order.products) : order.products) || [];
      var merged = existing.map(function(p, i) {
        var f = newProducts[i] || {};
        return Object.assign({}, p, {
          unit_price:  f.unit_price !== undefined ? Number(f.unit_price) : p.unit_price,
          trade_terms: f.trade_terms || p.trade_terms,
          subtotal:    (f.unit_price !== undefined ? Number(f.unit_price) : p.unit_price) * (p.qty || 0),
        });
      });

      await pool.query(
        "UPDATE orders SET products = $1::jsonb WHERE id = $2",
        [JSON.stringify(merged), orderId]
      );

      // Auto-advance status if was pending_quote/pending_confirm
      var canAdvance = order.status === "pending_quote" || order.status === "pending_confirm";
      if (canAdvance) {
        await appendHistory(pool, orderId, order.status, "factory_confirmed", body.byUser, { reason: "factory_update" });
      }

      return res.status(200).json({
        success: true,
        status: canAdvance ? "factory_confirmed" : order.status,
        products: merged,
      });
    }

    return res.status(400).json({ error: "unknown action: " + action });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
