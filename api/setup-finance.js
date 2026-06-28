// api/setup-finance.js — One-time setup to create finance_records table
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.query.key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { Pool } = require("pg");
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: false,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_records (
        id              SERIAL PRIMARY KEY,
        record_no       VARCHAR(50) NOT NULL UNIQUE,
        direction       VARCHAR(5) NOT NULL CHECK (direction IN ('AP', 'AR')),
        category        VARCHAR(30) NOT NULL,
        status          VARCHAR(20) DEFAULT 'pending',
        currency        VARCHAR(10) DEFAULT 'USD',
        amount          DECIMAL(14,2) NOT NULL,
        paid_amount     DECIMAL(14,2) DEFAULT 0,
        counterparty    VARCHAR(200),
        counterparty_code VARCHAR(50),
        issuing_company VARCHAR(200),
        issuing_code    VARCHAR(50),
        shipment_no     VARCHAR(50),
        contract_no     VARCHAR(50),
        order_nos       TEXT,
        invoice_no      VARCHAR(100),
        due_date        DATE,
        paid_date       DATE,
        raw             JSONB DEFAULT '{}',
        created_by      VARCHAR(100),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_direction ON finance_records(direction);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_category ON finance_records(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_status ON finance_records(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_counterparty_code ON finance_records(counterparty_code);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_issuing_code ON finance_records(issuing_code);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_shipment_no ON finance_records(shipment_no);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_due_date ON finance_records(due_date);`);

    // Verify
    const check = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'finance_records' ORDER BY ordinal_position`);

    await pool.end();
    return res.status(200).json({
      success: true,
      message: "finance_records table created with 7 indexes",
      columns: check.rows
    });
  } catch (err) {
    try { await pool.end(); } catch(e) {}
    return res.status(500).json({ error: err.message });
  }
}
