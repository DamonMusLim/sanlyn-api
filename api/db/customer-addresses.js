// /api/db/customer-addresses.js
// Sub-table for delivery addresses per company.
//
// GET  ?companyCode=X              → list addresses
// POST action=create               → add address
// POST action=migrate              → one-time migration from customers table (admin)
// POST action=set_default          → set one address as default
// PUT  { id, ...fields }           → update address
// DELETE ?id=X                     → delete address
//
// Table: customer_addresses(id, company_code, label, country, city, address, phone, email, is_default, created_at)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id           SERIAL PRIMARY KEY,
      company_code TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT 'Office',
      country      TEXT,
      city         TEXT,
      address      TEXT,
      phone        TEXT,
      email        TEXT,
      is_default   BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_custaddr_code ON customer_addresses(company_code);
  `);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  await ensureTable(pool);

  // ── GET: list ─────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const code = (req.query.companyCode || "").trim();
    if (!code) return res.status(400).json({ error: "companyCode required" });
    const r = await pool.query(
      `SELECT id, company_code, label, country, city, address, phone, email, is_default, created_at
         FROM customer_addresses
        WHERE company_code = $1
        ORDER BY is_default DESC, created_at ASC`,
      [code]
    );
    return res.status(200).json({ success: true, data: r.rows, count: r.rows.length });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    await pool.query("DELETE FROM customer_addresses WHERE id = $1", [id]);
    return res.status(200).json({ success: true });
  }

  // ── PUT: update ───────────────────────────────────────────────────────────
  if (req.method === "PUT") {
    const { id, label, country, city, address, phone, email, is_default } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const r = await pool.query(
      `UPDATE customer_addresses
          SET label=$2, country=$3, city=$4, address=$5, phone=$6, email=$7,
              is_default=$8, updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id, label||"Office", country||"", city||"", address||"", phone||"", email||"", !!is_default]
    );
    return res.status(200).json({ success: true, data: r.rows[0] });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const action = body.action || "create";

    // ── create ──
    if (action === "create") {
      const { company_code, label, country, city, address, phone, email, is_default } = body;
      if (!company_code) return res.status(400).json({ error: "company_code required" });
      if (is_default) {
        await pool.query(
          "UPDATE customer_addresses SET is_default=false WHERE company_code=$1",
          [company_code]
        );
      }
      const r = await pool.query(
        `INSERT INTO customer_addresses (company_code, label, country, city, address, phone, email, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [company_code, label||"Office", country||"", city||"", address||"", phone||"", email||"", !!is_default]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    }

    // ── set_default ──
    if (action === "set_default") {
      const { id, company_code } = body;
      if (!id || !company_code) return res.status(400).json({ error: "id and company_code required" });
      await pool.query("UPDATE customer_addresses SET is_default=false WHERE company_code=$1", [company_code]);
      await pool.query("UPDATE customer_addresses SET is_default=true  WHERE id=$1", [id]);
      return res.status(200).json({ success: true });
    }

    // ── migrate: pull data from customers.address + customers.addresses ──
    if (action === "migrate") {
      if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin only" });
      }
      const customers = await pool.query(
        `SELECT company_code, name_en, country, address, address_en, addresses,
                contact_phone, contact_email
           FROM customers
          WHERE address IS NOT NULL AND address <> ''`
      );
      let inserted = 0;
      for (const c of customers.rows) {
        const code = c.company_code;
        const existing = await pool.query(
          "SELECT COUNT(*) FROM customer_addresses WHERE company_code=$1", [code]
        );
        if (Number(existing.rows[0].count) > 0) continue; // already migrated

        // Primary address from customers.address column
        const primaryAddr = (c.address_en || c.address || "").trim();
        if (primaryAddr) {
          await pool.query(
            `INSERT INTO customer_addresses (company_code, label, country, address, phone, email, is_default)
             VALUES ($1,'Main Office',$2,$3,$4,$5,true)`,
            [code, c.country||"", primaryAddr, c.contact_phone||"", c.contact_email||""]
          );
          inserted++;
        }

        // Extra addresses from customers.addresses jsonb
        const extras = Array.isArray(c.addresses) ? c.addresses : [];
        for (const a of extras) {
          const addr = typeof a === "string" ? a : (a.full || a.address || "");
          const label = typeof a === "object" ? (a.label || a.type || "Address") : "Address";
          if (addr && addr !== primaryAddr) {
            await pool.query(
              `INSERT INTO customer_addresses (company_code, label, country, address, is_default)
               VALUES ($1,$2,$3,$4,false)`,
              [code, label, c.country||"", addr]
            );
            inserted++;
          }
        }
      }
      return res.status(200).json({ success: true, migrated: inserted });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
