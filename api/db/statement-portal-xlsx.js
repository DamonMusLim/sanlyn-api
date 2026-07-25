// Customer statement → clean Excel (no token, no internal refs, no Chinese in EN).
// 2026-07-20 Damon: excel也要干净。复用 fetchStatementRows;只输出客户面列;本地化表头+海运费/港杂费标签。
import ExcelJS from "exceljs";
import { getPool } from "./db.js";
import { applyStatementFilters, buildSummary, clean, fetchStatementRows, filters } from "./statement-portal-helpers.js";
import { resolveCustomerScope } from "./statement-portal-data.js";

const L = {
  en: { title: "Statement of Account", order: "Order", type: "Type", item: "Item / charge", bl: "B/L",
        date: "Order date", etd: "ETD", qty: "Qty", unit: "Unit price", amount: "Amount", cur: "Currency",
        prepaid: "Prepaid", due: "Due", status: "Status", other: "Port charges",
        products: "Products", logistics: "Logistics", freight: "Ocean freight", unpaid: "Unpaid", paid: "Paid",
        sum_prod: "Products receivable", sum_freight: "Ocean freight", sum_port: "Port charges", orders: "Orders" },
  zh: { title: "对账单", order: "订单号", type: "类别", item: "货品/费用", bl: "提单 BL",
        date: "下单时间", etd: "ETD", qty: "柜数", unit: "单价", amount: "金额", cur: "币种",
        prepaid: "已预付", due: "未付", status: "状态", other: "港杂费",
        products: "产品", logistics: "物流", freight: "海运费", unpaid: "未付", paid: "已付",
        sum_prod: "产品应收", sum_freight: "海运费", sum_port: "港杂费", orders: "订单数" },
  ms: { title: "Penyata Akaun", order: "Pesanan", type: "Jenis", item: "Item / caj", bl: "B/L",
        date: "Tarikh pesanan", etd: "ETD", qty: "Kuantiti", unit: "Harga seunit", amount: "Jumlah", cur: "Mata wang",
        prepaid: "Prabayar", due: "Perlu bayar", status: "Status", other: "Caj pelabuhan",
        products: "Produk", logistics: "Logistik", freight: "Tambang laut", unpaid: "Belum bayar", paid: "Dibayar",
        sum_prod: "Belum terima produk", sum_freight: "Tambang laut", sum_port: "Caj pelabuhan", orders: "Pesanan" },
};
const money = (cur, n) => `${cur || "CNY"} ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function statementPortalXlsx(req, res) {
  const pool = getPool();
  const scope = await resolveCustomerScope(req, res, pool);
  if (!scope) return;
  const lang = (["en", "zh", "ms"].includes(clean(req.query?.lang)) ? clean(req.query.lang) : "en");
  const t = L[lang];
  try {
    const rows = applyStatementFilters(await fetchStatementRows(pool, scope), filters(req));
    const summary = buildSummary(rows);
    const wb = new ExcelJS.Workbook();
    wb.creator = "Sanlyn";
    const ws = wb.addWorksheet(t.title);
    ws.columns = [
      { header: t.order, key: "order", width: 20 },
      { header: t.type, key: "type", width: 11 },
      { header: t.item, key: "item", width: 26 },
      { header: t.bl, key: "bl", width: 20 },
      { header: t.date, key: "date", width: 13 },
      { header: t.qty, key: "qty", width: 11 },
      { header: t.unit, key: "unit", width: 16 },
      { header: t.amount, key: "amount", width: 16 },
      { header: t.prepaid, key: "prepaid", width: 14 },
      { header: t.due, key: "due", width: 16 },
      { header: t.other, key: "other", width: 16 },
      { header: t.status, key: "status", width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A1A" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    for (const r of rows) {
      const isLog = r.category === "logistics";
      const orders = (r.order_nos && r.order_nos.length ? r.order_nos.join(" + ") : (r.order_no || ""));
      const qty = isLog && r.ctn_qty ? `${r.ctn_qty}×${r.ctn_type || ""}`.trim() : "";
      const unit = isLog && r.ctn_qty && r.amount ? money(r.currency, Number(r.amount) / r.ctn_qty) : "";
      ws.addRow({
        order: orders,
        type: isLog ? t.logistics : t.products,
        item: isLog ? t.freight : (r.item_desc || ""),
        bl: r.bl_no || "",
        date: r.shipped_date || "",
        qty, unit,
        amount: money(r.currency, r.amount),
        prepaid: r.prepaid ? money(r.currency, r.prepaid) : "—",
        due: money(r.currency, r.due),
        other: r.other_amount ? money("CNY", r.other_amount) : "",
        status: r.status === "paid" ? t.paid : t.unpaid,
      });
    }
    // 汇总区(空行分隔)
    ws.addRow({});
    const g = summary._groups || {};
    if (g.product) ws.addRow({ order: t.sum_prod, amount: money(g.product.currency, g.product.receivable_total), due: money(g.product.currency, g.product.outstanding), status: `${summary._order_count} ${t.orders}` });
    if (g.logistics) {
      ws.addRow({ order: t.sum_freight, amount: money(g.logistics.currency, g.logistics.receivable_total), due: money(g.logistics.currency, g.logistics.outstanding) });
      if (g.logistics.port_charges_cny > 0) ws.addRow({ order: t.sum_port, amount: money("CNY", g.logistics.port_charges_cny) });
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="statement.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    return res.end(Buffer.from(buf));
  } catch (e) {
    console.error("[statement-portal-xlsx]", e && e.message);
    return res.status(500).json({ error: "xlsx_failed" });
  }
}
