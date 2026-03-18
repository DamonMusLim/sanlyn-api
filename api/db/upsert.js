import { getPool, setCors } from "../db.js";
const TABLES = ["orders","finance_payments","shipping_plans","accounts"];
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { table, record } = req.body;
    if (!TABLES.includes(table)) return res.status(400).json({ success: false, error: "Invalid table" });
    let sql, vals;
    if (table === "accounts") {
      sql = `INSERT INTO accounts (username,password,role,company,supplier_role,permissions,department,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (username) DO UPDATE SET password=$2,role=$3,company=$4,supplier_role=$5,permissions=$6,department=$7,raw=$8,updated_at=NOW() RETURNING *`;
      vals = [record.username,record.password,record.role,record.company,record.supplierRole||record.supplier_role,record.permissions,record.department,JSON.stringify(record)];
    } else if (table === "orders") {
      // 提取products子表，补全barcode字段
      const rawProducts = (record.products||record._widget_1764396068557||[]).map(p => ({
        name:     p.name    || p._widget_1764396068574 || "",
        qty:      p.qty     || p._widget_1764396068583 || 0,
        barcode:  p.barcode || p._widget_1764396068578 || "",
        category: p.category|| p._widget_1764396068580 || "",
        factory:  p.factory || p._widget_1764396068576 || "",
      }));
      const enrichedRecord = { ...record, products: rawProducts };
      sql = `INSERT INTO orders (_id,contract_no,customer_po,customer,destination,etd,eta,status,production_status,total_amount,currency,plan_id,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (_id) DO UPDATE SET contract_no=$2,customer_po=$3,customer=$4,destination=$5,etd=$6,eta=$7,status=$8,production_status=$9,total_amount=$10,currency=$11,plan_id=$12,raw=$13,updated_at=NOW() RETURNING *`;
      vals = [record._id,record.contractNo||record.contract_no,record.customerPO||record.customer_po,record.customer,record.destination,record.etd||null,record.eta||null,record.status,record.productionStatus||record.production_status,record.totalAmount||record.total_amount||null,record.currency||"USD",record.planId||record.plan_id,JSON.stringify(enrichedRecord)];
    } else if (table === "finance_payments") {
      sql = `INSERT INTO finance_payments (_id,plan_id,customer,amount,currency,paid_date,status,tt_slip_url,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT (_id) DO UPDATE SET plan_id=$2,customer=$3,amount=$4,currency=$5,paid_date=$6,status=$7,tt_slip_url=$8,raw=$9,updated_at=NOW() RETURNING *`;
      vals = [record._id,record.planId||record.plan_id,record.customer,record.amount||null,record.currency||"USD",record.paidDate||record.paid_date||null,record.status,record.ttSlipUrl||record.tt_slip_url,JSON.stringify(record)];
    } else {
      sql = `INSERT INTO shipping_plans (_id,bl_no,vessel,voyage,etd,eta,cutoff_date,container_no,customs_cn,trucking_cn,customer,created_by,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (_id) DO UPDATE SET bl_no=$2,vessel=$3,voyage=$4,etd=$5,eta=$6,cutoff_date=$7,container_no=$8,customs_cn=$9,trucking_cn=$10,customer=$11,created_by=$12,raw=$13,updated_at=NOW() RETURNING *`;
      vals = [record._id,record.blNo||record.bl_no,record.vessel,record.voyage,record.etd||null,record.eta||null,record.cutoffDate||record.cutoff_date||null,record.containerNo||record.container_no,record.customsCN||record.customs_cn,record.truckingCN||record.trucking_cn,record.customer,record.createdBy||record.created_by,JSON.stringify(record)];
    }
    const result = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
