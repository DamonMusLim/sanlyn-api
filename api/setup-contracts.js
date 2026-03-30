export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.query.key !== "sanlyn2026") return res.status(403).json({ error: "forbidden" });
  const { Pool } = require("pg");
  const pool = new Pool({ host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT || "5432"), database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: false });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS contracts (id SERIAL PRIMARY KEY, contract_no VARCHAR(50) NOT NULL UNIQUE, type VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', party_a VARCHAR(200), party_a_code VARCHAR(50), party_b VARCHAR(200), party_b_code VARCHAR(50), sign_date DATE, start_date DATE, end_date DATE, file_url TEXT, file_name VARCHAR(200), raw JSONB DEFAULT '{}', created_by VARCHAR(100), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_contracts_type ON contracts(type); CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status); CREATE INDEX IF NOT EXISTS idx_contracts_party_a_code ON contracts(party_a_code); CREATE INDEX IF NOT EXISTS idx_contracts_party_b_code ON contracts(party_b_code); CREATE INDEX IF NOT EXISTS idx_contracts_contract_no ON contracts(contract_no);`);
    await pool.end();
    return res.status(200).json({ success: true, message: "contracts table created" });
  } catch (err) { await pool.end(); return res.status(500).json({ success: false, error: err.message }); }
}
