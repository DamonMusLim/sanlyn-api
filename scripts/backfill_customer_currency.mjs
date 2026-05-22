import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

// Phase 1 of the customers master overhaul: set settlement currency to CNY for
// real BUYERS (role_type='customer'). History shows ~all orders are CNY; the
// blanket 'USD' default was wrong. USD exceptions (if any) are flipped back
// individually afterward. Reversible via migrations/021_customers_currency_backup.sql.

const before = await pool.query(
  `SELECT currency, COUNT(*)::int n FROM customers WHERE role_type='customer' GROUP BY currency ORDER BY currency`
);
console.log("BEFORE (role_type=customer):", JSON.stringify(before.rows));

const r = await pool.query(
  `UPDATE customers
     SET currency='CNY', default_currency='CNY', updated_at=NOW()
   WHERE role_type='customer'
     AND (currency IS DISTINCT FROM 'CNY')
   RETURNING company_code, name_en`
);
console.log("rows flipped to CNY:", r.rowCount);
console.log("flipped:", r.rows.map((x) => x.company_code).join(", "));

const after = await pool.query(
  `SELECT currency, COUNT(*)::int n FROM customers WHERE role_type='customer' GROUP BY currency ORDER BY currency`
);
console.log("AFTER  (role_type=customer):", JSON.stringify(after.rows));

await pool.end();
