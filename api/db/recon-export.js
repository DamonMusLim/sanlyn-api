import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { loadReconMaster } from "./recon-master.js";

function clean(v) { return String(v ?? "").trim(); }
function title(ws, text, width) {
  ws.mergeCells(1, 1, 1, width);
  ws.getCell(1, 1).value = text;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
}
function addSheet(wb, name, heads, rows) {
  const ws = wb.addWorksheet(name);
  title(ws, name, heads.length);
  ws.addRow(heads);
  ws.getRow(2).font = { bold: true };
  rows.forEach(r => ws.addRow(r));
  ws.columns.forEach(c => { c.width = 16; });
  return ws;
}

async function detailRows(pool, company) {
  const bills = await pool.query(
    `SELECT b.bl_no, b.cost_category, b.amount, b.sale_amount, b.currency, b.qty, b.unit_price, b.charge_basis, b.supplier
       FROM active_freight_supplier_bills b
       JOIN shipping_plans sp ON sp.bl_no=b.bl_no
      WHERE sp.company_code=$1
      ORDER BY b.bl_no, b.id`, [company]);
  const official = await pool.query(
    `SELECT carrier, port, container_type, charge_item_name, amount_cny, unit_basis
       FROM carrier_tariff_standards
      WHERE port ILIKE '青岛' AND review_status IN ('confirmed','pending')
      ORDER BY carrier, container_type, charge_item_code, valid_from DESC`);
  const local = await pool.query(
    `SELECT carrier, pol, pod, company_name, container_type, cost_total, sell_total, fees
       FROM local_charges
      WHERE COALESCE(is_active,true)
      ORDER BY carrier, pol, container_type, company_name`);
  return { bills: bills.rows, official: official.rows, local: local.rows };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const company = clean(req.query.company);
    if (!company) return res.status(400).json({ success: false, error: "company required" });
    const pool = getPool();
    const master = await loadReconMaster(pool, req.query);
    const d = await detailRows(pool, company);
    const wb = new ExcelJS.Workbook();
    wb.creator = "sanlyn-reconcile";
    addSheet(wb, "对账主表", ["日期", "出货人(工厂)", "收货人(客户)", "PO号", "BL", "条款", "货品成本", "货品销售", "报关额", "海运成本USD", "拖车CNY", "驳船CNY", "海运销售USD", "港杂销售CNY", "缺口"],
      master.map(r => [r.etd, r.factory, r.customer, r.po_nos, r.bl_no, r.trade_terms, r.goods_cost, r.goods_sale, r.declared_amount, r.ocean_cost_usd, r.truck_cost_cny, r.barge_cost_cny, r.ocean_sale_usd, r.port_sale_cny, (r.gap_flags || []).join("/")]));
    addSheet(wb, "港杂明细", ["BL", "标准费目名", "成本", "销售", "币种", "数量", "单价", "单位", "供应商"],
      d.bills.map(r => [r.bl_no, r.cost_category, r.amount, r.sale_amount, r.currency, r.qty, r.unit_price, r.charge_basis, r.supplier]));
    addSheet(wb, "官方标准", ["船司", "港口", "柜型", "标准费目", "金额CNY", "单位"],
      d.official.map(r => [r.carrier, r.port, r.container_type, r.charge_item_name, r.amount_cny, r.unit_basis]));
    addSheet(wb, "货代价卡", ["船司", "起运港", "目的港", "货代", "柜型", "成本合计", "销售合计", "明细"],
      d.local.map(r => [r.carrier, r.pol, r.pod, r.company_name, r.container_type, r.cost_total, r.sell_total, JSON.stringify(r.fees || {})]));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="recon-${company}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
