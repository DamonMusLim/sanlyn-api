import { getPool, setCors } from "../db.js";
import bcrypt from "bcryptjs";

const ALLOWED_ROLES = new Set(["customer", "factory", "logistics"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const {
      company,
      taxId,
      contact,
      phone,
      email,
      password,
      role,
      address,
      licenseUrl,
    } = req.body || {};

    if (!company || !contact || !email || !password || !role) {
      return res.status(400).json({ error: "missing required fields" });
    }

    const username = String(email).trim().toLowerCase();

    if (!EMAIL_RE.test(username)) {
      return res.status(400).json({ error: "invalid email" });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }

    if (!ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: "role is not allowed for self registration" });
    }

    const pool = getPool();
    const existing = await pool.query("SELECT id FROM accounts WHERE username = $1", [username]);

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "email exists" });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const supplierRole = role === "logistics" ? "ocean" : null;
    const raw = {
      status: "pending",
      firstLogin: true,
      name: contact,
      email: username,
      phone: phone || null,
      taxId: taxId || null,
      address: address || null,
      licenseUrl: licenseUrl || null,
      registeredAt: new Date().toISOString(),
      selfRegistered: true,
    };

    await pool.query(
      `INSERT INTO accounts
       (username, password, role, company, supplier_role, raw, is_active, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, false, NOW(), NOW())`,
      [username, passwordHash, role, company, supplierRole, raw],
    );

    return res.status(200).json({ success: true, pending: true });
  } catch (error) {
    console.error("register failed", error);
    return res.status(500).json({ error: "registration failed" });
  }
}
