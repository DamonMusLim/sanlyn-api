// /api/db/bank-accounts.js — bank_accounts 子表 CRUD
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const isAdmin = req.user?.role === "admin";
  if (!isAdmin && req.method !== "GET") {
    return res.status(403).json({ error: "Admin only" });
  }

  const pool = getPool();

  try {
    // ── GET ?company_code=xxx ───────────────────────────────
    if (req.method === "GET") {
      const { company_code, id } = req.query;
      if (id) {
        const r = await pool.query("SELECT * FROM bank_accounts WHERE id = $1", [id]);
        return res.status(200).json({ success: true, data: r.rows[0] || null });
      }
      if (!company_code) return res.status(400).json({ error: "company_code required" });
      const r = await pool.query(
        "SELECT * FROM bank_accounts WHERE company_code = $1 AND active = TRUE ORDER BY is_default DESC, id ASC",
        [company_code]
      );
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    }

    // ── POST — create ───────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.company_code || !b.currency) return res.status(400).json({ error: "company_code + currency required" });
      // If marking as default, clear other defaults for same company+currency first
      if (b.is_default) {
        await pool.query(
          "UPDATE bank_accounts SET is_default = FALSE WHERE company_code = $1 AND currency = $2",
          [b.company_code, b.currency]
        );
      }
      const r = await pool.query(`
        INSERT INTO bank_accounts
          (company_code, currency, bank_name, bank_name_en, account_no, account_holder,
           swift, iban, routing, bank_address, is_default, active, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
        [b.company_code, b.currency, b.bank_name||null, b.bank_name_en||null,
         b.account_no||null, b.account_holder||null, b.swift||null,
         b.iban||null, b.routing||null, b.bank_address||null,
         b.is_default||false, b.active!==false, b.raw ? JSON.stringify(b.raw) : null]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // ── PATCH — update ──────────────────────────────────────
    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id required" });
      // Clear other defaults if setting this one as default
      if (b.is_default) {
        const existing = await pool.query("SELECT company_code, currency FROM bank_accounts WHERE id = $1", [b.id]);
        if (existing.rows[0]) {
          const { company_code, currency } = existing.rows[0];
          await pool.query(
            "UPDATE bank_accounts SET is_default = FALSE WHERE company_code = $1 AND currency = $2 AND id != $3",
            [company_code, currency, b.id]
          );
        }
      }
      const sets = [], vals = [];
      const allowed = ["bank_name","bank_name_en","account_no","account_holder","swift","iban","routing","bank_address","is_default","active","currency"];
      for (const k of allowed) {
        if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "No fields to update" });
      vals.push(new Date().toISOString()); sets.push(`updated_at = $${vals.length}`);
      vals.push(b.id);
      const r = await pool.query(
        `UPDATE bank_accounts SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // ── DELETE ──────────────────────────────────────────────
    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      await pool.query("UPDATE bank_accounts SET active = FALSE, updated_at = NOW() WHERE id = $1", [id]);
      return res.status(200).json({ success: true, deleted: id });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
