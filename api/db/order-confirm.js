// /api/db/order-confirm — two-stage order confirmation state machine
// Per damon 2026-05-18: pending orders need explicit factory→customer chain,
// not silent waiting. Replaces the misleading "Pending Sanlyn confirmation" flow.
//
// State machine (all in raw JSONB — no schema change):
//   raw.factoryConfirmedAt     null →  set when factory clicks Confirm
//   raw.factoryConfirmedBy     username
//   raw.factoryConfirmedNote   optional note from factory
//   raw.factoryCounterProposal { price?, qty?, deliveryDate?, note? } — if factory countered
//   raw.customerConfirmedAt    null → set when customer clicks Approve
//   raw.customerConfirmedBy    username
//
// Derived lifecycle (frontend resolver reads these timestamps):
//   status=pending + no factoryConfirmedAt        → AWAITING_FACTORY
//   status=pending + factoryConfirmedAt + no customerConfirmedAt → AWAITING_CUSTOMER
//   status=pending + both confirmed               → auto-advance to status=confirmed (CONFIRMED)
//
// POST /api/db/order-confirm
//   body: { id, side: 'factory'|'customer', action: 'confirm'|'cancel'|'counter', note?, counter? }
//
// Auth:
//   side=factory: req.user.role MUST be 'factory' or admin, AND if role=factory
//     their factoryCode (raw.factoryCode) MUST match order.raw.factoryCode
//   side=customer: req.user.company_code MUST match order.company_code
//     OR be in req.user.company_codes[] (HQ scope)
//
// Effects:
//   action=confirm   → set raw.{side}ConfirmedAt + ConfirmedBy
//                     → if both sides confirmed, set status='confirmed'
//   action=cancel    → set status='cancelled', raw.cancelledBy + cancelledAt + cancelReason
//   action=counter   → side MUST be 'factory'; sets raw.factoryCounterProposal + factoryConfirmedAt
//                      (customer then sees counter on their approve screen)

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const { id, side, action, note, counter, cancelReason } = req.body || {};
  if (!id)     return res.status(400).json({ error: "id required" });
  if (!["factory", "customer"].includes(side))   return res.status(400).json({ error: "side must be factory|customer" });
  if (!["confirm", "cancel", "counter"].includes(action)) return res.status(400).json({ error: "action must be confirm|cancel|counter" });
  if (action === "counter" && side !== "factory") return res.status(400).json({ error: "only factory can counter-propose" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT id, status, company_code, raw FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!r.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "order_not_found" }); }
    const o = r.rows[0];
    const raw = (o.raw && typeof o.raw === "object") ? o.raw : {};

    // ── AUTH gate ──
    const myRole = req.user.role;
    const myCode = req.user.companyCode || req.user.company_code;
    const myCodes = Array.isArray(req.user.companyCodes || req.user.company_codes) ? (req.user.companyCodes || req.user.company_codes) : [];
    const isAdmin = myRole === "admin" || myRole === "super_admin";

    if (side === "factory" && !isAdmin) {
      // Factory user — role must be 'factory' AND factoryCode match
      if (myRole !== "factory") {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "factory_role_required" });
      }
      // Match on raw.factoryCode (orders) vs user's company_code or raw.factoryCode
      const orderFactoryCode = raw.factoryCode || raw.factory_code;
      const userFactoryCode = myCode || req.user.raw?.factoryCode;
      if (orderFactoryCode && userFactoryCode && orderFactoryCode !== userFactoryCode) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "factory_scope_mismatch", message: `Order is for ${orderFactoryCode}, you are ${userFactoryCode}` });
      }
    }
    if (side === "customer" && !isAdmin) {
      // Customer user — company_code must match order, or be in HQ scope
      const allowed = new Set([myCode, ...myCodes]);
      if (!allowed.has(o.company_code)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "customer_scope_mismatch" });
      }
    }

    // ── State guards ──
    if (o.status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_cancelled" });
    }
    if (action === "confirm" && raw[side + "ConfirmedAt"]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_confirmed_by_this_side" });
    }

    // ── Compose raw patch ──
    const now = new Date().toISOString();
    const username = req.user.email || req.user.username || "unknown";
    const patch = {};

    if (action === "cancel") {
      // Customer can cancel anytime pre-production; factory cannot cancel (must counter)
      if (side !== "customer" && !isAdmin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "only_customer_can_cancel" });
      }
      patch.cancelledAt = now;
      patch.cancelledBy = username;
      if (cancelReason) patch.cancelReason = String(cancelReason).slice(0, 500);
    } else if (action === "counter") {
      // Factory counter-proposes; also sets factoryConfirmedAt so the ball moves to customer
      if (!counter || typeof counter !== "object") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "counter_payload_required", message: "counter:{price?,qty?,deliveryDate?,note?}" });
      }
      patch.factoryConfirmedAt = now;
      patch.factoryConfirmedBy = username;
      patch.factoryCounterProposal = {
        ...(counter.price       != null ? { price:        Number(counter.price) }       : {}),
        ...(counter.qty         != null ? { qty:          Number(counter.qty) }         : {}),
        ...(counter.deliveryDate     ? { deliveryDate: String(counter.deliveryDate) }  : {}),
        ...(counter.note             ? { note:         String(counter.note).slice(0, 500) } : {}),
        proposedAt: now,
        proposedBy: username,
      };
      if (note) patch.factoryConfirmedNote = String(note).slice(0, 500);
    } else {
      // action=confirm
      patch[side + "ConfirmedAt"] = now;
      patch[side + "ConfirmedBy"] = username;
      if (note) patch[side + "ConfirmedNote"] = String(note).slice(0, 500);
    }

    // ── Apply ──
    let newStatus = o.status;
    if (action === "cancel") {
      newStatus = "cancelled";
    } else {
      // Auto-advance status to 'confirmed' once both sides have confirmed
      const merged = { ...raw, ...patch };
      if (merged.factoryConfirmedAt && merged.customerConfirmedAt) {
        newStatus = "confirmed";
      }
    }

    await client.query(
      `UPDATE orders SET status = $1, raw = COALESCE(raw,'{}') || $2::jsonb, updated_at = NOW() WHERE id = $3`,
      [newStatus, JSON.stringify(patch), id]
    );

    await client.query("COMMIT");
    return res.status(200).json({
      ok: true,
      id,
      status: newStatus,
      side,
      action,
      raw_patch: patch,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}
