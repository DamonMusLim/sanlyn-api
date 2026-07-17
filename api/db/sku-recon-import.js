// /api/db/sku-recon-import.js - 库存比对表 批量导入(工厂传Excel: SKU+成品库存/安全值/柜容量/供应商 + 嵌入图)
import { getPool } from "./db.js";
import { extractUser } from "../auth.js";
import { ossUploadBuffer } from "../oss-direct.js";
import { IncomingForm } from "formidable";
import ExcelJS from "exceljs";
import fs from "fs";

export const config = { api: { bodyParser: false } };

function clean(v, n = 200) { return String(v == null ? "" : v).trim().slice(0, n); }
function nnum(v) { if (v === "" || v == null) return null; const x = Number(String(v).replace(/[^\d.\-]/g, "")); return Number.isFinite(x) ? x : null; }
function cv(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    return "";
  }
  return String(v).trim();
}
function fieldFor(h) {
  h = clean(h, 40);
  if (/^sku$|编码|货号|产品编号/i.test(h)) return "sku";
  if (/成品库存|^库存$|现货/.test(h)) return "finished_stock";
  if (/安全值|安全库存/.test(h)) return "safety_stock";
  if (/柜容量|一柜|装柜/.test(h)) return "container_capacity";
  if (/供应商|供应链/.test(h)) return "supplier_name";
  return null;
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    new IncomingForm({ maxFileSize: 30 * 1024 * 1024 }).parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });
  if (!req.user) extractUser(req);
  const role = clean(req.user?.role || "", 40).toLowerCase();
  const isInternal = role === "sanlyn" || role === "admin";
  if (!(role === "factory" || isInternal)) return res.status(403).json({ success: false, error: "forbidden" });
  const scope = (Array.isArray(req.user?.companyCodes) && req.user.companyCodes.length ? req.user.companyCodes : (req.user?.companyCode ? [req.user.companyCode] : [])).map(c => clean(c, 80));
  if (!isInternal && !scope.length) return res.status(403).json({ success: false, error: "scope missing" });
  const pool = getPool();
  let filepath;
  try {
    const { files } = await parseForm(req);
    const f = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!f) return res.status(400).json({ success: false, error: "file required" });
    filepath = f.filepath || f.path;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(filepath));
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ success: false, error: "空表" });

    const colField = {};
    ws.getRow(1).eachCell((cell, col) => { const fld = fieldFor(cv(cell.value)); if (fld) colField[col] = fld; });
    if (!Object.values(colField).includes("sku")) return res.status(400).json({ success: false, error: "首行需有 SKU 列" });

    const rowImg = {};
    for (const im of (ws.getImages() || [])) {
      const r = Math.round((im.range?.tl?.nativeRow ?? 0)) + 1;
      if (rowImg[r] == null) rowImg[r] = im.imageId;
    }

    let updated = 0, imgN = 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const rec = {};
        for (const [col, fld] of Object.entries(colField)) rec[fld] = cv(row.getCell(Number(col)).value);
        const sku = clean(rec.sku, 80);
        if (!sku) continue;
        // 作用域: 工厂只能导自己厂的SKU
        const pv = [sku];
        let pw = "sku = $1";
        if (!isInternal) { pv.push(scope); pw += " AND factory_code = ANY($2::text[])"; }
        const prod = await client.query(`SELECT id, unit, factory_code FROM products WHERE ${pw} LIMIT 1`, pv);
        if (!prod.rows.length) continue;
        const p = prod.rows[0];
        // 图片
        let image_url = null;
        if (rowImg[r] != null) {
          try {
            const media = wb.getImage(rowImg[r]);
            const url = await ossUploadBuffer(`sku-recon/${sku}-${r}.${media.extension || "png"}`, media.buffer, `image/${media.extension || "png"}`);
            if (url) { image_url = url; imgN++; }
          } catch (_) {}
        }
        // upsert fg
        let fg = (await client.query("SELECT id FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=1 FOR UPDATE", [sku])).rows[0];
        if (!fg) {
          await client.query(`INSERT INTO finished_goods_inventory(product_id, sku, unit, current_stock, safety_stock, factory_code, warehouse_id)
             VALUES($1,$2,$3,0,0,$4,1) ON CONFLICT (sku, warehouse_id) DO NOTHING`, [p.id, sku, p.unit || null, p.factory_code || null]);
          fg = (await client.query("SELECT id FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=1 FOR UPDATE", [sku])).rows[0];
        }
        const sets = [], sv = [];
        const cs = nnum(rec.finished_stock); if (cs != null) { sv.push(cs); sets.push(`current_stock=$${sv.length}`); }
        const ss = nnum(rec.safety_stock); if (ss != null) { sv.push(ss); sets.push(`safety_stock=$${sv.length}`); }
        const cc = nnum(rec.container_capacity); if (cc != null) { sv.push(cc); sets.push(`container_capacity=$${sv.length}`); }
        const sp = clean(rec.supplier_name, 120); if (sp) { sv.push(sp); sets.push(`supplier_name=$${sv.length}`); }
        if (image_url) { sv.push(image_url); sets.push(`image_url=$${sv.length}`); }
        if (sets.length) {
          sv.push(fg.id);
          await client.query(`UPDATE finished_goods_inventory SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${sv.length}`, sv);
          updated++;
        }
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    return res.status(200).json({ success: true, updated, images: imgN });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (filepath) { try { fs.unlinkSync(filepath); } catch (_) {} }
  }
}
