// 待办表导出 Excel（列同国动橙导出模板，按货位顺序，可直接打印）
import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { loadPetstoreTodo } from "./petstore-todo.js";

const HEADS = ["待办","货架号","商品名称","规格","保质期状态","生产日期","到期日",
               "库存","门店售价","月销","商品编码","条码","一级分类","供应商","完成"];
const KEYS  = ["todo_type","shelf","product_name","spec","warn_status","production_date",
               "expire_date","stock","out_price","month_sale","product_code","barcode",
               "category","supplier"];
const FILL = { "已过期":"FFC7CE", "无货位":"FFE699", "快过期":"FFF2CC", "无生产日期":"DDEBF7" };

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadPetstoreTodo(getPool(), req.query);
    const day = rows.length ? rows[0].snapshot_date : new Date().toISOString().slice(0, 10);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("店员待办");
    ws.addRow(HEADS);
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    rows.forEach(r => {
      const row = ws.addRow([...KEYS.map(k => r[k] ?? ""), ""]);
      const c = FILL[r.todo_type];
      if (c) row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + c } };
    });
    [9,9,42,14,12,12,12,7,10,7,13,15,12,10,7].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADS.length } };
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="petstore-todo-${day}.xlsx"`);
    res.status(200).end(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
