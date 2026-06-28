const {Pool} = require("pg");
const p = new Pool({connectionString: process.env.DATABASE_URL});
async function run() {
  // 48-CL-5 factory_subtotal investigation
  const r1 = await p.query(`
    SELECT r.customs_no, r.order_nos, r.declaration_names,
           oli.declaration_name, SUM(oli.factory_subtotal) as fs_total
    FROM finance_export_rebates r
    JOIN orders o ON o.contract_no = r.contract_no
    JOIN order_line_items oli ON oli.order_id = o.id
    WHERE r.order_nos ILIKE '%48-CL-5%'
    GROUP BY r.customs_no, r.order_nos, r.declaration_names, oli.declaration_name
    LIMIT 10
  `);
  console.log("48-CL-5 OLI factory_subtotal:", JSON.stringify(r1.rows, null, 2));

  // 连云港中砂 00171960 - what order links to it?
  const r2 = await p.query(`
    SELECT r.customs_no, r.order_nos, r.declaration_names, r.factory_names
    FROM finance_export_rebates r
    WHERE r.customs_no LIKE '%00171960%'
    LIMIT 5
  `);
  console.log("连云港 00171960:", JSON.stringify(r2.rows, null, 2));
  p.end();
}
run().catch(e => { console.error(e.message); p.end(); });
