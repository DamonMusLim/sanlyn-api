import ExcelJS from "exceljs";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 反方向:把要货单 Excel 导进【我们的】补货意图。
// 认的就是果冻橙那份模板的列(templateDownloadPurchaseV2):
//   商品编码(必填) | 采购量(必填) | 供应商编码(选填) | 要货价(选填)
// 所以「果冻橙导出的」和「我们导出的」两种表都能直接喂进来。
//
// 🔴 铁律:导进来的一律 status='proposed' 走 Damon 审核。
//    ⛔ 绝不允许 Excel 里带个字段就能直接变成「已批准」——
//    「智能补货和建议补货要给我审核」是他 0831 定的。
//
// 🔴 这个口会写库(只往 petstore_restock_intents 插 proposed 行),已在部署门禁里明示放行。
//
// 用法:POST,body = xlsx 的原始字节(服务端留了 req.rawBody)
//      默认 dry_run —— 先看解析结果,带 ?dry_run=0 才真写库
const STORE = "63350001";

function json(res, s, d) { return res.status(s).json(d); }

function cell(row, i) {
  const v = row.getCell(i).value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const t = v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map((r) => r.text).join("") : "");
    return String(t ?? "").trim();
  }
  return String(v).trim();
}

// 表头按关键字认,⛔ 别写死列序 —— 果冻橙导出的和我们导出的列顺序不一定一样
function findCols(ws) {
  const head = ws.getRow(1);
  const idx = { code: 0, qty: 0, supplier: 0 };
  const n = Math.max(head.cellCount || 0, 10);
  for (let i = 1; i <= n; i++) {
    const t = cell(head, i);
    if (!t) continue;
    if (!idx.code && /商品编码|编码|productCode/i.test(t)) idx.code = i;
    else if (!idx.qty && /采购量|要货量|数量|qty/i.test(t)) idx.qty = i;
    else if (!idx.supplier && /供应商编码|供货商编码/i.test(t)) idx.supplier = i;
  }
  return idx;
}

async function parse(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return { error: "没有工作表" };
  const idx = findCols(ws);
  if (!idx.code || !idx.qty) {
    return {
      error: "认不出表头",
      hint: "第一行要有「商品编码」和「采购量」两列",
      head_seen: [1, 2, 3, 4, 5].map((i) => cell(ws.getRow(1), i)),
    };
  }
  const rows = [];
  const bad = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const code = cell(row, idx.code);
    const qtyRaw = cell(row, idx.qty);
    if (!code && !qtyRaw) continue;                     // 空行跳过
    if (!code) { bad.push({ row: r, reason: "没有商品编码" }); continue; }
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) { bad.push({ row: r, code, reason: "采购量「" + qtyRaw + "」不是正数" }); continue; }
    if (!Number.isInteger(qty)) { bad.push({ row: r, code, reason: "采购量 " + qty + " 不是整数" }); continue; }
    rows.push({ row: r, product_code: code, qty, supplier_code: idx.supplier ? cell(row, idx.supplier) : "" });
  }
  return { rows, bad };
}

// 这个编码我们认不认得、是不是已经有一条待审的
async function enrich(rows) {
  if (!rows.length) return rows;
  const codes = rows.map((r) => r.product_code);
  const known = await getPool().query(
    `SELECT g.product_code, g.product_name, g.spec, g.stock_num
       FROM public.petstore_gdc_purchase_config g
      WHERE g.product_code = ANY($1::text[]) AND g.store_code = $2`, [codes, STORE]);
  const dup = await getPool().query(
    `SELECT product_code FROM public.petstore_restock_intents
      WHERE product_code = ANY($1::text[]) AND status = 'proposed'`, [codes]);
  const kmap = Object.create(null);
  for (const k of known.rows) kmap[k.product_code] = k;
  const dset = new Set(dup.rows.map((d) => d.product_code));
  return rows.map((r) => {
    const k = Object.hasOwn(kmap, r.product_code) ? kmap[r.product_code] : null;
    return {
      ...r,
      product_name: k ? k.product_name : null,
      spec: k ? k.spec : null,
      cur_stock: k ? k.stock_num : null,
      known: !!k,
      already_proposed: dset.has(r.product_code),
    };
  });
}

async function insert(rows, who, batchNo) {
  const ok = rows.filter((r) => r.known && !r.already_proposed);
  if (!ok.length) return [];
  const r = await getPool().query(
    `INSERT INTO public.petstore_restock_intents
       (batch_no, store_code, product_code, product_name, spec, cur_stock,
        suggest_qty, verdict_reason, source, status)
     SELECT $1, $2, x.code, x.name, x.spec, x.stock, x.qty,
            $3::text, 'excel_import', 'proposed'
       FROM unnest($4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[])
            AS x(code, name, spec, stock, qty)
     RETURNING id, product_code, suggest_qty, status`,
    [batchNo, STORE, "Excel 导入 · " + who,
      ok.map((r) => r.product_code), ok.map((r) => r.product_name), ok.map((r) => r.spec),
      ok.map((r) => (r.cur_stock === null || r.cur_stock === undefined) ? 0 : r.cur_stock),
      ok.map((r) => r.qty)]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const who = req.user?.username || req.user?.name || "";
    if (!who) return json(res, 401, { ok: false, error: "no_identity" });

    const buf = req.rawBody;
    if (!buf || !buf.length) return json(res, 400, { ok: false, error: "no_file", hint: "把 xlsx 当请求体发过来" });
    if (buf.length > 4 * 1024 * 1024) return json(res, 400, { ok: false, error: "too_big", hint: "4M 以内" });
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) return json(res, 400, { ok: false, error: "not_xlsx", hint: "这不是 xlsx(开头不是 PK)" });

    const p = await parse(buf);
    if (p.error) return json(res, 400, { ok: false, error: p.error, hint: p.hint, head_seen: p.head_seen });
    const rows = await enrich(p.rows);

    const summary = {
      parsed: rows.length,
      bad_rows: p.bad.length,
      unknown: rows.filter((r) => !r.known).length,
      already: rows.filter((r) => r.already_proposed).length,
      importable: rows.filter((r) => r.known && !r.already_proposed).length,
    };

    // 默认先只看不写 —— ⛔ 别让人闭着眼睛往库里灌
    if (String(req.query?.dry_run ?? "1") !== "0") {
      return json(res, 200, {
        ok: true, dry_run: true, ...summary, rows, bad: p.bad,
        hint: "确认没问题后带 ?dry_run=0 再发一次才会真写库",
      });
    }

    const batchNo = "IMP-" + new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const ins = await insert(rows, who, batchNo);
    // 🔴 回读:把库里真实状态查回来,⛔ 不返回"我以为写进去了什么"
    const back = await getPool().query(
      `SELECT id, product_code, suggest_qty, status, source, batch_no
         FROM public.petstore_restock_intents WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ins.map((x) => x.id)]);
    return json(res, 200, {
      ok: true, dry_run: false, batch_no: batchNo, ...summary,
      inserted: ins.length, readback: back.rows, bad: p.bad,
      note: "导进来的都是【待审】,要在补货审核里批准才算数",
    });
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
