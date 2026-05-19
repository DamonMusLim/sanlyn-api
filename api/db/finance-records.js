// api/db/finance-records.js — Unified Finance Records CRUD API
// GET: list records (with filters: direction, category, status, counterparty_code, shipment_no, date range)
// POST: create or update a finance record

import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
import pg from "pg"; // ESM-safe — was `require("pg")` which throws under ESM

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: false,
  });

  try {
    /* ═══ GET: list finance records ═══ */
    if (req.method === "GET") {
      let {
        direction, category, status, counterparty_code,
        issuing_code, shipment_no, order_nos,
        date_from, date_to, company_code,
        // factory_code: intentionally ignored — scope is derived from JWT
        // companyCodes, not from any client-supplied param (FAIL-CLOSED-2026-05-19)
      } = req.query;

      let where = [];
      let params = [];
      let idx = 1;

      // ── Tenant scoping (fail-closed) — FAIL-CLOSED-2026-05-19 ──────────────
      // Non-admin: force scope to user's JWT company codes, regardless of
      // what the client sent.  factory role: also match raw JSONB factory_code
      // because finance records tag factory via raw->>'factory_code' /
      // raw->>'factoryCompanyCode', not always via counterparty_code.
      if (req.user && req.user.role !== "admin") {
        const userCodes = req.user.companyCodes
          || (req.user.companyCode ? [req.user.companyCode] : null);
        if (!userCodes || userCodes.length === 0) {
          return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
        }

        const isFactory = req.user.role === 'factory' || req.user.role === 'supplier';

        // Base scope: counterparty_code OR issuing_code IN (JWT codes).
        // Existing factory records and workflow-engine-created payment requests
        // identify the factory via counterparty_code, so we MUST keep this
        // predicate for factories too — additive, not replacement.
        const cpPh = userCodes.map(() => "$" + (idx++)).join(",");
        userCodes.forEach((c) => params.push(c));
        const isPh = userCodes.map(() => "$" + (idx++)).join(",");
        userCodes.forEach((c) => params.push(c));
        const baseScope = "counterparty_code IN (" + cpPh + ") OR issuing_code IN (" + isPh + ")";

        if (isFactory) {
          // Factory: ALSO match raw->>'factory_code' / 'factoryCompanyCode'
          // for records that tag factory in raw JSONB instead of the column.
          const fcPh = userCodes.map(() => "$" + (idx++)).join(",");
          userCodes.forEach((c) => params.push(c));
          const fccPh = userCodes.map(() => "$" + (idx++)).join(",");
          userCodes.forEach((c) => params.push(c));
          where.push(
            "(" + baseScope +
            " OR raw->>'factory_code' IN (" + fcPh + ")" +
            " OR raw->>'factoryCompanyCode' IN (" + fccPh + "))"
          );
        } else {
          where.push("(" + baseScope + ")");
        }
        company_code = undefined; // ignore client-supplied
      }

      if (direction) { where.push("direction = $" + idx); params.push(direction.toUpperCase()); idx++; }
      if (category) { where.push("category = $" + idx); params.push(category); idx++; }
      if (status) { where.push("status = $" + idx); params.push(status); idx++; }
      if (counterparty_code) { where.push("counterparty_code = $" + idx); params.push(counterparty_code); idx++; }
      if (issuing_code) { where.push("issuing_code = $" + idx); params.push(issuing_code); idx++; }
      if (shipment_no) { where.push("shipment_no = $" + idx); params.push(shipment_no); idx++; }
      if (order_nos) { where.push("order_nos ILIKE $" + idx); params.push("%" + order_nos + "%"); idx++; }

      // company_code (admin only — non-admin already scoped above)
      if (company_code) {
        where.push("(counterparty_code = $" + idx + " OR issuing_code = $" + (idx + 1) + ")");
        params.push(company_code, company_code);
        idx += 2;
      }

      // Date range filter (on due_date)
      if (date_from) { where.push("due_date >= $" + idx); params.push(date_from); idx++; }
      if (date_to) { where.push("due_date <= $" + idx); params.push(date_to); idx++; }

      const whereClause = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
      const sql = "SELECT * FROM finance_records" + whereClause + " ORDER BY created_at DESC";
      const result = await pool.query(sql, params);

      // Parse raw JSONB
      const data = result.rows.map(function(r) {
        if (r.raw && typeof r.raw === "string") {
          try { r.raw = JSON.parse(r.raw); } catch(e) {}
        }
        return r;
      });

      // Summary stats
      let total_ap = 0, total_ar = 0, paid_ap = 0, paid_ar = 0;
      data.forEach(function(r) {
        const amt = parseFloat(r.amount) || 0;
        const paidAmt = parseFloat(r.paid_amount) || 0;
        if (r.direction === "AP") { total_ap += amt; paid_ap += paidAmt; }
        if (r.direction === "AR") { total_ar += amt; paid_ar += paidAmt; }
      });

      await pool.end();
      return res.status(200).json({
        success: true,
        data: data,
        count: data.length,
        summary: {
          total_ap: Math.round(total_ap * 100) / 100,
          total_ar: Math.round(total_ar * 100) / 100,
          paid_ap: Math.round(paid_ap * 100) / 100,
          paid_ar: Math.round(paid_ar * 100) / 100,
          unpaid_ap: Math.round((total_ap - paid_ap) * 100) / 100,
          unpaid_ar: Math.round((total_ar - paid_ar) * 100) / 100,
        }
      });
    }

    /* ═══ POST: create or update finance record ═══ */
    if (req.method === "POST") {
      // Finance writes: restricted to internal roles only (FAIL-CLOSED-2026-05-19)
      const _writeRole = req.user?.role || 'customer';
      if (_writeRole !== 'admin' && _writeRole !== 'finance') {
        await pool.end();
        return res.status(403).json({
          error: "Forbidden: finance record writes require admin or finance role",
          code:  "FINANCE_WRITE_FORBIDDEN",
        });
      }
      const body = req.body || {};
      const {
        id, record_no, direction, category, status,
        currency, amount, paid_amount,
        counterparty, counterparty_code,
        issuing_company, issuing_code,
        shipment_no, contract_no, order_nos, invoice_no,
        due_date, paid_date,
        raw, created_by,
      } = body;

      /* ── Update existing record ── */
      if (id) {
        const fields = [];
        const params = [];
        let idx = 1;

        const addField = function(col, val) {
          if (val !== undefined) {
            fields.push(col + " = $" + idx);
            params.push(col === "raw" && typeof val === "object" ? JSON.stringify(val) : val);
            idx++;
          }
        };

        addField("record_no", record_no);
        addField("direction", direction ? direction.toUpperCase() : undefined);
        addField("category", category);
        addField("status", status);
        addField("currency", currency);
        addField("amount", amount);
        addField("paid_amount", paid_amount);
        addField("counterparty", counterparty);
        addField("counterparty_code", counterparty_code);
        addField("issuing_company", issuing_company);
        addField("issuing_code", issuing_code);
        addField("shipment_no", shipment_no);
        addField("contract_no", contract_no);
        addField("order_nos", order_nos);
        addField("invoice_no", invoice_no);
        addField("due_date", due_date || null);
        addField("paid_date", paid_date || null);
        addField("raw", raw);

        fields.push("updated_at = NOW()");

        if (fields.length === 1) {
          await pool.end();
          return res.status(400).json({ error: "No fields to update" });
        }

        params.push(id);
        const sql = "UPDATE finance_records SET " + fields.join(", ") + " WHERE id = $" + idx + " RETURNING *";
        const result = await pool.query(sql, params);
        await pool.end();

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Record not found" });
        }
        return res.status(200).json({ success: true, data: result.rows[0] });
      }

      /* ── Create new record ── */
      if (!direction || !category || !amount) {
        await pool.end();
        return res.status(400).json({ error: "direction, category, and amount are required" });
      }

      // Auto-generate record_no if not provided
      let finalRecordNo = record_no;
      if (!finalRecordNo) {
        const dir = direction.toUpperCase();
        const year = new Date().getFullYear();
        const prefix = "FR-" + dir + "-" + year + "-";
        const countResult = await pool.query(
          "SELECT COUNT(*) as cnt FROM finance_records WHERE record_no LIKE $1",
          [prefix + "%"]
        );
        const seq = String((parseInt(countResult.rows[0].cnt) || 0) + 1).padStart(4, "0");
        finalRecordNo = prefix + seq;
      }

      const rawStr = raw && typeof raw === "object" ? JSON.stringify(raw) : (raw || "{}");

      const sql = `INSERT INTO finance_records 
        (record_no, direction, category, status,
         currency, amount, paid_amount,
         counterparty, counterparty_code,
         issuing_company, issuing_code,
         shipment_no, contract_no, order_nos, invoice_no,
         due_date, paid_date,
         raw, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING *`;

      const result = await pool.query(sql, [
        finalRecordNo,
        direction.toUpperCase(),
        category,
        status || "pending",
        currency || "USD",
        amount,
        paid_amount || 0,
        counterparty || null,
        counterparty_code || null,
        issuing_company || null,
        issuing_code || null,
        shipment_no || null,
        contract_no || null,
        order_nos || null,
        invoice_no || null,
        due_date || null,
        paid_date || null,
        rawStr,
        created_by || null,
      ]);

      await pool.end();
      return res.status(201).json({ success: true, data: result.rows[0] });
    }

    await pool.end();
    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    try { await pool.end(); } catch(e) {}
    console.error("finance-records API error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ success: false, error: "记录编号已存在", detail: err.detail });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}
