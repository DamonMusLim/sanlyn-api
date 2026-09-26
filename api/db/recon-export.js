import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { loadReconMaster } from "./recon-master.js";
import { callerCompanyScope } from "../lib/viewmodel-adapter.js";

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

// ── 调用方是不是我方主体（可跨公司看对账）──────────────────
// ⚖️ 判公司归属只看 companies 表，⛔不按 role/公司名猜。
//    实测只有 6 个账号属于我方主体(BABI/LUVSOME/VEN-LL)，其余 31 个是外部。
// 60 秒进程内缓存，别每次导出都打一次库。
const sanlynEntityCache = new Map();
const SANLYN_ENTITY_CACHE_TTL_MS = 60 * 1000;

async function callerIsSanlynEntity(pool, req) {
  const code = clean(req.user && req.user.companyCode);
  if (!code) return false;
  const cached = sanlynEntityCache.get(code);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const result = await pool.query(
    `SELECT COALESCE(is_sanlyn_entity, false) AS is_sanlyn_entity
       FROM companies WHERE code=$1 LIMIT 1`, [code]);
  const value = Boolean(result.rows[0] && result.rows[0].is_sanlyn_entity);
  sanlynEntityCache.set(code, { value, expiresAt: now + SANLYN_ENTITY_CACHE_TTL_MS });
  return value;
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
    // 🔴 2026-09-11 堵越权：原来 ?company= 直接进 WHERE，零校验。
    //    实证：外部货代账号(万汇恒通 CN-00028)能下载任意公司的对账单，
    //    含成本价/销售价/供应商。照 partner-relationships.js 的写法加范围校验。
    const isAdmin = req.user && req.user.role === "admin";
    if (!isAdmin && !(await callerIsSanlynEntity(pool, req))) {
      const scope = callerCompanyScope(req);
      const allowed = scope.all || [];
      if (allowed.length === 0) return res.status(403).json({ error: "Account scope missing" });
      if (!allowed.includes(company)) {
        return res.status(403).json({ error: "Out of scope", requested: company, allowed: allowed });
      }
    }
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
