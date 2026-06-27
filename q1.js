const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(`
  SELECT o.contract_no,
         sp.customs_declaration_no,
         fer.customs_no AS rebate_customs_no,
         fer.materials_ok,
         fer.declaration_names
  FROM orders o
  LEFT JOIN shipping_plan_orders spo ON spo.order_id = o.id
  LEFT JOIN shipping_plans sp ON sp.id = spo.shipping_plan_id
  LEFT JOIN finance_export_rebates fer ON fer.customs_no = sp.customs_declaration_no
  WHERE o.contract_no IN ('38-WP-62','40-CP-4','37-ZC-20')
  ORDER BY o.contract_no
`).then(r => console.log(JSON.stringify(r.rows,null,2))).catch(e=>console.error(e.message)).finally(()=>pool.end());
