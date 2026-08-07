// api/db/customs-decl-xlsx.js — 报关单草单 Excel 导出 (2026-08-08)
//
// 为什么：报关行和船东更喜欢 Excel —— 他们要把数字【复制】进自己的报关/舱单系统，
//         PDF 复制出来是乱的。Damon 2026-08-08：「报关单草单要 excel」。
//
// 🔒 唯一真源 = 报关单 PDF 的那份渲染结果（renderCustomsDeclaration）。
//    这里只做「同一份 HTML → Excel」的转换，不重新取一遍数、不重算。
//    好处：PDF 改了 Excel 自动跟着改，两者永远不会打架；
//         也不会出现"Excel 一套数、PDF 另一套数"这种最难查的事故。
//    字段一个不删（Damon：「你都保留，我们现在都有的」）。
import { renderCustomsDeclaration } from "./customs-declaration-form.js";

const strip = s => String(s == null ? "" : s)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .trim();

// 数字格样式的单元格：能被 Excel 当数字用（报关行要直接加总）
const asNum = v => {
  const t = String(v).replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
};

export function parseDeclHtml(html) {
  const head = [];
  const reCell = /<div class="cell[^"]*">\s*<div class="lbl">([\s\S]*?)<\/div>\s*<div class="val"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = reCell.exec(html))) {
    const label = strip(m[1]), value = strip(m[2]);
    if (label) head.push([label, value === "—" ? "" : value]);
  }
  // 顶部预录入/海关编号那一条
  const topline = strip((/<div class="topline"[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1] || "");

  // 货物表
  const tbl = (/<table[\s\S]*?<\/table>/.exec(html) || [])[0] || "";
  const cols = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => strip(x[1]));
  const rows = [];
  for (const tr of [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(x => x[1])) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
    if (tds.length) rows.push(tds);
  }

  // 底部确认项（特殊关系确认/价格影响/自报自缴/水运中转 …）
  const foot = [];
  const cl = (/<div class="confirm-line">([\s\S]*?)<\/div>\s*<\/div>/.exec(html)
           || /<div class="confirm-line">([\s\S]*?)<div class="bottom">/.exec(html) || [])[1] || "";
  for (const x of [...cl.matchAll(/<div>([\s\S]*?)<\/div>/g)]) {
    const t = strip(x[1]); if (t) foot.push(t);
  }
  // 底部三格：报关人员/证号/电话/申明/签章 —— Damon: 现在有的都要保留
  const bottom = [];
  const bm = /<div class="bottom">([\s\S]*?)<\/div>\s*<\/div>\s*<div style="text-align:right/.exec(html)
          || /<div class="bottom">([\s\S]*)$/.exec(html);
  if (bm) {
    for (const b of [...bm[1].matchAll(/<div class="box">([\s\S]*?)<\/div>\s*(?=<div class="box">|$)/g)]) {
      const inner = [...b[1].matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)].map(x => strip(x[1])).filter(Boolean);
      if (inner.length) bottom.push(inner);
    }
    if (!bottom.length) {
      const flat = [...bm[1].matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)]
        .map(x => strip(x[1])).filter(t => t && t !== "—");
      if (flat.length) bottom.push(flat);
    }
  }
  return { topline, head, cols, rows, foot, bottom };
}

export async function buildDeclWorkbook(pool, shipmentId, opts) {
  const html = await renderCustomsDeclaration(pool, shipmentId, opts || {});
  const d = parseDeclHtml(html);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sanlyn";
  const ws = wb.addWorksheet("出口货物报关单");

  const B = { top:{style:"thin"}, left:{style:"thin"}, bottom:{style:"thin"}, right:{style:"thin"} };
  const put = (r, c, v, o) => {
    const cell = ws.getRow(r).getCell(c);
    cell.value = v;
    cell.border = B;
    cell.alignment = Object.assign({ vertical:"middle", wrapText:true }, (o||{}).align);
    if ((o||{}).bold) cell.font = { bold:true };
    if ((o||{}).fill) cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:o.fill } };
    return cell;
  };

  // 版式：整张表统一 9 列（= 商品明细的列数），表头区每行 3 组
  //       「标签(1列) + 值(合并2列)」= 3×3 = 9 列，和下面商品表严丝合缝对齐。
  //       2026-08-08 修正：原来表头按 6 列排、商品表 9 列，两块错位（Damon:「模版没做好」）。
  const COLS = 9;
  let r = 1;
  ws.mergeCells(r, 1, r, COLS);
  put(r, 1, "中华人民共和国海关出口货物报关单", { bold:true, align:{ horizontal:"center" } })
    .font = { bold:true, size:15 };
  ws.getRow(r).height = 30; r++;

  if (d.topline) {
    ws.mergeCells(r, 1, r, COLS);
    put(r, 1, d.topline, { align:{ horizontal:"center" } }).font = { size:9, color:{ argb:"FF666666" } };
    r++;
  }
  ws.mergeCells(r, 1, r, COLS);
  put(r, 1, "仅供核对用 —— 与我方报关单 PDF 同一份数据生成", { align:{ horizontal:"center" } })
    .font = { italic:true, size:9, color:{ argb:"FF888888" } };
  r++;

  // ── 表头字段：3 组/行，标签占1列、值合并2列 ──
  const PER_ROW = 3;
  for (let i = 0; i < d.head.length; i += PER_ROW) {
    const grp = d.head.slice(i, i + PER_ROW);
    for (let k = 0; k < PER_ROW; k++) {
      const c0 = k * 3 + 1;
      const [lbl, val] = grp[k] || ["", ""];
      put(r, c0, lbl, { bold:true, fill:"FFF2F2F2", align:{ horizontal:"left" } });
      // ⚠️ ExcelJS：合并之后再往「从格」写值，会把值写回主格（曾把整列值清空）。
      //    所以顺序必须是：先给两格画边框、主格写值 → 最后才 merge。
      put(r, c0 + 1, val, { align:{ horizontal:"left" } });
      put(r, c0 + 2, "",  { align:{ horizontal:"left" } });
      ws.mergeCells(r, c0 + 1, r, c0 + 2);
    }
    ws.getRow(r).height = 28;
    r++;
  }
  r++;

  // ── 货物明细 ──
  ws.mergeCells(r, 1, r, COLS);
  put(r, 1, "商品明细", { bold:true, fill:"FFEAEAEA" }); r++;
  d.cols.forEach((c, i) => put(r, i+1, c, { bold:true, fill:"FFF2F2F2", align:{ horizontal:"center" } }));
  ws.getRow(r).height = 22; r++;
  d.rows.forEach(row => {
    row.forEach((v, i) => put(r, i+1, asNum(v)));
    ws.getRow(r).height = Math.min(90, 16 + 12 * (String(row[2]||"").split("\n").length));
    r++;
  });
  r++;

  const WIDE = COLS;
  if (d.foot.length) {
    ws.mergeCells(r, 1, r, WIDE);
    put(r, 1, d.foot.join("　　"), { align:{ horizontal:"left" } });
    ws.getRow(r).height = 20; r++;
  }
  (d.bottom || []).forEach(function(box){
    ws.mergeCells(r, 1, r, WIDE);
    put(r, 1, box.join("　　"), { align:{ horizontal:"left" } });
    r++;
  });

  // 列宽：第 3 列（商品名称及规格型号 / 申报要素）最宽
  // 9 列共用：1/4/7 = 标签列（也是商品表的 项号/单价/最终目的国）
  //           2-3、5-6、8-9 = 值（合并）；商品表的 商品名称 落在第3列，给最宽
  const widths = [14, 20, 34, 15, 17, 15, 15, 16, 12];
  widths.forEach((w, i) => { ws.getColumn(i+1).width = w; });

  return wb;
}

export default async function xlsxResponder(pool, res, shipmentId, opts, filename) {
  const wb = await buildDeclWorkbook(pool, shipmentId, opts);
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    'attachment; filename="' + String(filename || "customs-declaration").replace(/[^A-Za-z0-9._-]/g, "_") + '.xlsx"');
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(Buffer.from(buf));
}
