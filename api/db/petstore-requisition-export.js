import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 把【已批准】的补货导成果冻橙的「批量要货」Excel。
//
// 🩸 为什么是 Excel:0831 探遍果冻橙的写口 —— 购物车(insertShopCar)和智能补货(autoPurchase)
//    这个租户都没开(404),采购单要上游单号。唯一能从外部灌单的只剩 importPurchaseSheetV2,
//    而它是 multipart 上传。所以闭环只能是「我们导出 → 人工导入果冻橙 → 回来标已执行」。
//
// 🔴 这个口【会写库】—— 导出即【领批次】。codex 0831 审出的洞:
//    原来导出是纯读,导 100 条却只勾 20 条标已执行,剩下 80 条下次会被再导一遍 = 重复下单。
//    现在:导出在一个事务里把这批行盖上 export_batch,导过的就不会再进下一份。
//    标记已执行也按【批次】整批标,人不用再去勾。
//
// ⛔ 不导【要货价】——那是进价(成本)。
// ⛔ 供应商编码默认【留空】,让果冻橙自己选主供应商 —— codex 审出:
//    我们那张 petstore_gdc_purchase_config 是快照,供应关系变了就会把货要给旧供应商,
//    比留空更危险。要带的话得显式 with_supplier=1。
const HEADERS = ["商品编码(必填)", "采购量(必填)", "供应商编码(选填)", "要货价(选填)"];

function json(res, s, d) { return res.status(s).json(d); }

const SELECT_COLS = `i.id, i.product_code, i.product_name, i.decided_qty,
        i.buy_unit, i.decided_cases, i.case_qty, g.supplier_code, g.supplier_name`;

async function preview(storeCode) {
  const r = await getPool().query(
    `SELECT ${SELECT_COLS}
       FROM public.petstore_restock_intents i
       LEFT JOIN public.petstore_gdc_purchase_config g
              ON g.product_code = i.product_code AND g.store_code = i.store_code
      WHERE i.status = 'approved' AND i.export_batch IS NULL AND i.decided_qty > 0
        AND ($1::text IS NULL OR i.store_code = $1)
      ORDER BY i.product_code`, [storeCode || null]);
  return r.rows;
}

// 领批次:一个事务里把这批行占住,别人再点导出就拿不到同一批了
async function claim(storeCode, who, withSupplier) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const b = await client.query(
      `SELECT 'RQ-' || to_char(now(),'YYYYMMDD') || '-' ||
              lpad((COALESCE(max(substring(export_batch from '[0-9]+$')::int),0) + 1)::text, 3, '0') AS batch
         FROM public.petstore_restock_intents
        WHERE export_batch LIKE 'RQ-' || to_char(now(),'YYYYMMDD') || '-%'`);
    const batch = b.rows[0].batch;
    const r = await client.query(
      `UPDATE public.petstore_restock_intents i
          SET export_batch = $1, exported_at = now(), exported_by = $2
         FROM public.petstore_restock_intents chk
        WHERE chk.id = i.id
          AND i.status = 'approved' AND i.export_batch IS NULL AND i.decided_qty > 0
          AND ($3::text IS NULL OR i.store_code = $3)
        RETURNING i.id, i.product_code, i.decided_qty`, [batch, who, storeCode || null]);
    if (!r.rows.length) { await client.query("ROLLBACK"); return { batch: null, rows: [] }; }
    // 供应商要单独查(UPDATE...RETURNING 拿不到 join 表的列)
    const sup = withSupplier
      ? (await client.query(
          `SELECT product_code, supplier_code FROM public.petstore_gdc_purchase_config
            WHERE product_code = ANY($1::text[])`, [r.rows.map((x) => x.product_code)])).rows
      : [];
    const map = Object.create(null);
    for (const s of sup) map[s.product_code] = s.supplier_code;
    await client.query("COMMIT");
    return { batch, rows: r.rows.map((x) => ({ ...x, supplier_code: map[x.product_code] || null })) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function build(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("批量要货");
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  ws.columns = [{ width: 22 }, { width: 12 }, { width: 18 }, { width: 12 }];
  for (const d of data) {
    ws.addRow([
      String(d.product_code),                   // 编码当文本,⛔ 别让 Excel 转成科学计数法
      Math.round(Number(d.decided_qty)),        // 采购量必须整数 —— 小数果冻橙那边会出岔
      d.supplier_code ? String(d.supplier_code) : "",
      "",                                       // 要货价留空:那是成本
    ]);
    ws.lastRow.getCell(1).numFmt = "@";
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    const who = req.user?.username || req.user?.name || "";
    if (!who) return json(res, 401, { ok: false, error: "no_identity" });
    const storeCode = String(req.query?.store_code ?? "").trim() || null;

    // GET = 只看不领。⛔ 别让人闭着眼睛下载
    if (req.method === "GET") {
      const data = await preview(storeCode);
      const noSupplier = data.filter((d) => !d.supplier_code).length;
      const nonInt = data.filter((d) => !Number.isInteger(Number(d.decided_qty))).length;
      return json(res, 200, {
        ok: true, count: data.length,
        total_qty: data.reduce((a, b) => a + Number(b.decided_qty || 0), 0),
        no_supplier: noSupplier,
        non_integer_qty: nonInt,
        non_integer_hint: nonInt ? "这些批准量不是整数,导出会四舍五入" : null,
        rows: data,
      });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

    // POST = 真导出,会领批次(把这批占住,下次导不到)
    const withSupplier = String(req.query?.with_supplier ?? "") === "1";
    const { batch, rows } = await claim(storeCode, who, withSupplier);
    if (!batch) return json(res, 200, { ok: false, error: "nothing_to_export", hint: "没有【已批准且未导出】的补货" });

    const buf = await build(rows);
    const name = `果冻橙要货单-${batch}-${rows.length}项.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("X-Row-Count", String(rows.length));
    res.setHeader("X-Export-Batch", batch);
    res.setHeader("Access-Control-Expose-Headers", "X-Row-Count, X-Export-Batch");
    return res.status(200).end(buf);
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
