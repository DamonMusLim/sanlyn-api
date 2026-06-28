/**
 * factory-orders.js — Factory Purchase Order (FPO) CRUD API
 *
 * Routes:
 *   GET    /api/db/factory-orders              list FPOs (scoped)
 *   POST   /api/db/factory-orders              create FPO + auto event
 *   GET    /api/db/factory-orders/:fpo         get one FPO
 *   PATCH  /api/db/factory-orders/:fpo         update FPO
 *   GET    /api/db/factory-orders/:fpo/events  list events
 *   POST   /api/db/factory-orders/:fpo/events  add event
 *
 * Tenant security (FAIL-CLOSED-2026-05-19):
 *   admin  — sees all FPOs
 *   BABI/trader — sees FPOs where buyer_code = own company_code
 *   factory     — sees FPOs where factory_code = own company_code
 *   customer    — 403 always (FPOs are BABI internal procurement data)
 */

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

function fpoId() {
  return `fpo_${Date.now()}`;
}

// Auto-increment FPO sequence number
async function nextFpoNo(pool) {
  const r = await pool.query(
    `SELECT fpo_no FROM factory_orders WHERE fpo_no LIKE 'BABI-PO-2026-%' ORDER BY id DESC LIMIT 1`
  );
  if (r.rows.length === 0) return "BABI-PO-2026-001";
  const last = r.rows[0].fpo_no;
  const seq  = parseInt(last.split("-").pop(), 10) || 0;
  return `BABI-PO-2026-${String(seq + 1).padStart(3, "0")}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const role        = req.user?.role || "customer";
  const companyCode = req.user?.companyCode || (req.user?.companyCodes?.[0]);
  const isAdmin     = role === "admin";
  const isBABI      = role === "trader" && companyCode === "BABI";
  const isFactory   = role === "factory" || role === "supplier";

  // Customers cannot access FPOs
  if (role === "customer") {
    return res.status(403).json({
      error: "Forbidden: FPOs are internal procurement records",
      code:  "FPO_ACCESS_FORBIDDEN",
    });
  }

  const pool = getPool();
  const fpoParam = req.url?.split("/").find((s, i, a) => {
    const prev = a[i - 1];
    return prev === "factory-orders" && !["events"].includes(s);
  });

  // ── GET list ────────────────────────────────────────────────────────────
  if (req.method === "GET" && !fpoParam) {
    try {
      const { status, factory_code, limit = 100 } = req.query;
      let q = `SELECT fo.*,
                 (SELECT json_agg(e ORDER BY e.created_at DESC)
                  FROM factory_order_events e WHERE e.fpo_no = fo.fpo_no) AS events
               FROM factory_orders fo`, params = [], conds = [];

      // Tenant scoping
      if (!isAdmin) {
        if (isBABI) {
          params.push(companyCode);
          conds.push(`fo.buyer_code = $${params.length}`);
        } else if (isFactory) {
          params.push(companyCode);
          conds.push(`fo.factory_code = $${params.length}`);
        }
      }
      if (status)       { params.push(status);       conds.push(`fo.status = $${params.length}`); }
      if (factory_code) { params.push(factory_code); conds.push(`fo.factory_code = $${params.length}`); }

      if (conds.length) q += " WHERE " + conds.join(" AND ");
      q += ` ORDER BY fo.created_at DESC LIMIT $${params.length + 1}`;
      params.push(Number(limit));

      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST create ─────────────────────────────────────────────────────────
  if (req.method === "POST" && !fpoParam) {
    if (!isAdmin && !isBABI) {
      return res.status(403).json({ error: "Forbidden: only BABI or admin can create FPOs" });
    }
    try {
      const {
        factory_code, factory_company_id, factory_invoice_no,
        buyer_code = "BABI",
        customer_order_contract_nos = [],
        customer_po_refs = [],
        payment_terms = "30/70",
        incoterms = "EXW Qingdao",
        currency = "CNY",
        status = "draft",
        gross_amount, discount = 0, net_amount,
        deposit_paid = 0, balance_paid = 0,
        po_date, expected_ready_date,
        raw = {},
      } = req.body || {};

      if (!factory_code) return res.status(400).json({ error: "factory_code required" });

      const fpo_no = await nextFpoNo(pool);
      const _id    = fpoId();

      const r = await pool.query(
        `INSERT INTO factory_orders
           (_id, fpo_no, factory_code, factory_company_id, factory_invoice_no,
            buyer_code, customer_order_contract_nos, customer_po_refs,
            payment_terms, incoterms, currency, status,
            gross_amount, discount, net_amount, deposit_paid, balance_paid,
            po_date, expected_ready_date, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          _id, fpo_no, factory_code,
          factory_company_id || null, factory_invoice_no || null,
          buyer_code,
          JSON.stringify(customer_order_contract_nos),
          JSON.stringify(customer_po_refs),
          payment_terms, incoterms, currency, status,
          gross_amount != null ? Number(gross_amount) : null,
          Number(discount),
          net_amount != null ? Number(net_amount) : null,
          Number(deposit_paid), Number(balance_paid),
          po_date || null, expected_ready_date || null,
          JSON.stringify(raw),
        ]
      );

      // Auto-event: po_created
      await pool.query(
        `INSERT INTO factory_order_events (fpo_no, event_type, actor, notes, payload)
         VALUES ($1, 'po_created', $2, $3, $4)`,
        [
          fpo_no,
          `${buyer_code}:${req.user?.username || "system"}`,
          "FPO auto-created by system",
          JSON.stringify({ customer_contracts: customer_order_contract_nos }),
        ]
      );

      return res.status(201).json({ success: true, data: r.rows[0], fpo_no });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Routes with :fpo param ───────────────────────────────────────────────
  if (fpoParam) {
    const fpoNo = decodeURIComponent(fpoParam);

    // Verify access
    async function checkAccess() {
      if (isAdmin) return true;
      const r = await pool.query(
        `SELECT buyer_code, factory_code FROM factory_orders WHERE fpo_no = $1`, [fpoNo]
      );
      if (!r.rows.length) return false;
      const f = r.rows[0];
      if (isBABI && f.buyer_code === companyCode) return true;
      if (isFactory && f.factory_code === companyCode) return true;
      return false;
    }

    // GET /events
    if (req.method === "GET" && req.url?.includes("/events")) {
      if (!(await checkAccess())) return res.status(403).json({ error: "Forbidden" });
      try {
        const r = await pool.query(
          `SELECT * FROM factory_order_events WHERE fpo_no = $1 ORDER BY created_at ASC`, [fpoNo]
        );
        return res.status(200).json({ success: true, data: r.rows });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // POST /events
    if (req.method === "POST" && req.url?.includes("/events")) {
      if (!isAdmin && !isBABI) return res.status(403).json({ error: "Forbidden" });
      try {
        const { event_type, actor, notes, payload = {} } = req.body || {};
        if (!event_type) return res.status(400).json({ error: "event_type required" });
        const r = await pool.query(
          `INSERT INTO factory_order_events (fpo_no, event_type, actor, notes, payload)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [fpoNo, event_type, actor || `${companyCode}:${req.user?.username}`, notes || null, JSON.stringify(payload)]
        );
        return res.status(201).json({ success: true, data: r.rows[0] });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // GET detail
    if (req.method === "GET") {
      if (!(await checkAccess())) return res.status(404).json({ error: "FPO not found" });
      try {
        const r = await pool.query(
          `SELECT fo.*,
             (SELECT json_agg(e ORDER BY e.created_at) FROM factory_order_events e WHERE e.fpo_no = fo.fpo_no) AS events
           FROM factory_orders fo WHERE fo.fpo_no = $1`, [fpoNo]
        );
        if (!r.rows.length) return res.status(404).json({ error: "Not found" });
        return res.status(200).json({ success: true, data: r.rows[0] });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // PATCH update
    if (req.method === "PATCH") {
      if (!isAdmin && !isBABI) return res.status(403).json({ error: "Forbidden" });
      if (!(await checkAccess())) return res.status(404).json({ error: "FPO not found" });
      try {
        const ALLOWED = [
          "factory_invoice_no","status","gross_amount","discount","net_amount",
          "deposit_paid","balance_paid","po_date","factory_confirmed_at",
          "expected_ready_date","actual_ready_date","payment_terms","incoterms",
          "currency","customer_order_contract_nos","customer_po_refs","raw",
        ];
        const body = req.body || {};
        const sets = [], vals = [];
        for (const k of ALLOWED) {
          if (body[k] === undefined) continue;
          const v = (k === "raw" || k.endsWith("_nos") || k.endsWith("_refs"))
            ? JSON.stringify(body[k])
            : body[k];
          vals.push(v);
          sets.push(`${k} = $${vals.length}`);
        }
        if (!sets.length) return res.status(400).json({ error: "No fields to update" });
        sets.push("updated_at = NOW()");
        // If confirming, write factory_confirmed_at
        if (body.status === "confirmed" && !body.factory_confirmed_at) {
          sets.push("factory_confirmed_at = NOW()");
        }
        vals.push(fpoNo);
        const r = await pool.query(
          `UPDATE factory_orders SET ${sets.join(", ")} WHERE fpo_no = $${vals.length} RETURNING *`,
          vals
        );
        // Auto-event for status change
        if (body.status) {
          await pool.query(
            `INSERT INTO factory_order_events (fpo_no, event_type, actor, notes, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              fpoNo,
              body.status === "confirmed" ? "factory_confirmed" : `status_changed_${body.status}`,
              `${companyCode}:${req.user?.username || "system"}`,
              body._event_notes || null,
              JSON.stringify({ new_status: body.status, factory_invoice_no: body.factory_invoice_no }),
            ]
          );
        }
        return res.status(200).json({ success: true, data: r.rows[0] });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
