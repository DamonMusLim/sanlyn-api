import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 把【已批准】的补货意图导成果冻橙的「批量要货」Excel。
//
// 🩸 为什么是 Excel:0831 探遍果冻橙的写口 —— 购物车(insertShopCar)和智能补货(autoPurchase)
//    这个租户都没开(404),采购单要上游单号。**唯一能从外部灌单的只剩 importPurchaseSheetV2**,
//    而它是 multipart 上传。所以闭环只能是「我们导出 → 人工导入果冻橙」。
//
// ⛔ 这是【只读】接口:一行都不写库。导完由 petstore-restock-decide 的 execute 动作去标已执行。
// ⛔ 不导【要货价】——那是进价(成本),留空果冻橙会自己用门店供货关系价。
//
// 列名一个字都不能改 —— 是从果冻橙 templateDownloadPurchaseV2 下下来的原样:
//   A 商品编码(必填)  B 采购量(必填)  C 供应商编码(选填)  D 要货价(选填)
const HEADERS = ["商品编码(必填)", "采购量(必填)", "供应商编码(选填)", "要货价(选填)"];

function json(res, s, d) { return res.status(s).json(d); }

async function rows(storeCode) {
  // 只导【已批准且还没执行】的。已执行的再导一次 = 重复下单。
  const r = await getPool().query(
    `SELECT i.product_code, i.product_name, i.decided_qty, i.buy_unit, i.decided_cases, i.case_qty,
            g.supplier_code, g.supplier_name
       FROM public.petstore_restock_intents i
       LEFT JOIN public.petstore_gdc_purchase_config g
              ON g.product_code = i.product_code AND g.store_code = i.store_code
      WHERE i.status = 'approved'          -- 标过已执行的 status 会变成 'executed',自然就不在这里了
        AND i.decided_qty > 0
        AND ($1::text IS NULL OR i.store_code = $1)
      ORDER BY g.supplier_code NULLS LAST, i.product_code`,
    [storeCode || null]);
  return r.rows;
}

async function build(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("批量要货");
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  ws.columns = [{ width: 22 }, { width: 12 }, { width: 18 }, { width: 12 }];
  for (const d of data) {
    ws.addRow([
      String(d.product_code),            // 编码当文本,⛔ 别让 Excel 转成科学计数法
      Number(d.decided_qty),             // 件数(整箱的话后端已经算成 箱数×每箱)
      d.supplier_code ? String(d.supplier_code) : "",  // 留空 = 果冻橙自己选主供应商
      "",                                // 要货价留空:那是成本,不出接口
    ]);
    ws.lastRow.getCell(1).numFmt = "@";
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const storeCode = String(req.query?.store_code ?? "").trim() || null;
    const data = await rows(storeCode);

    // 先给个"看看有什么"的模式 —— 别让人闭着眼睛下载
    if (String(req.query?.preview ?? "") === "1") {
      const noSupplier = data.filter((d) => !d.supplier_code).length;
      return json(res, 200, {
        ok: true, count: data.length,
        total_qty: data.reduce((a, b) => a + Number(b.decided_qty || 0), 0),
        no_supplier: noSupplier,
        no_supplier_hint: noSupplier ? "这些没有供应商编码,果冻橙会按主供应商下单" : null,
        rows: data,
      });
    }
    if (!data.length) return json(res, 200, { ok: false, error: "nothing_to_export", hint: "没有【已批准且未执行】的补货" });

    const buf = await build(data);
    const name = `果冻橙要货单-${data.length}项.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("X-Row-Count", String(data.length));
    return res.status(200).end(buf);
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
