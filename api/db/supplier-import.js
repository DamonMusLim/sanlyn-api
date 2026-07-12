// /api/db/supplier-import.js - 供应商款式 Excel 一次性导入(数据 + 嵌入图片按行提取传OSS)
import { getPool } from "./db.js";
import { extractUser } from "../auth.js";
import { ossUploadBuffer } from "../oss-direct.js";
import { IncomingForm } from "formidable";
import ExcelJS from "exceljs";
import fs from "fs";

export const config = { api: { bodyParser: false } };

function clean(v, n = 300) { return String(v == null ? "" : v).trim().slice(0, n); }
function nnum(v) { if (v === "" || v == null) return null; const x = Number(String(v).replace(/[^\d.\-]/g, "")); return Number.isFinite(x) ? x : null; }
function cv(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.hyperlink) return String(v.hyperlink);
    return "";
  }
  return String(v).trim();
}
function fieldFor(h) {
  h = String(h || "").trim();
  if (/品名|名称|产品名/.test(h)) return "name";
  if (/品牌/.test(h)) return "brand";
  if (/条形?码|条码|barcode/i.test(h)) return "barcode";
  if (/货号|编号|编码/.test(h)) return "supplier_item_code";
  if (/材质/.test(h)) return "material";
  if (/规格|尺寸/.test(h)) return "spec";
  if (/单位/.test(h)) return "unit";
  if (/未含税|未税|单价/.test(h)) return "price_ex_tax";
  if (/点数|税点|开票点/.test(h)) return "tax_point";
  if (/起订|moq/i.test(h)) return "moq";
  if (/交期|交货/.test(h)) return "lead_time_days";
  if (/退版费/.test(h)) return "plate_fee";
  if (/报价日期/.test(h)) return "quote_date";
  if (/有效期/.test(h)) return "quote_valid_until";
  if (/备注/.test(h)) return "notes";
  return null;
}
const NUMF = new Set(["price_ex_tax", "tax_point", "moq", "lead_time_days", "plate_fee"]);
const DATEF = new Set(["quote_date", "quote_valid_until"]);

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
  if (!(role === "supplier" || isInternal)) return res.status(403).json({ success: false, error: "forbidden" });
  const codes = (Array.isArray(req.user?.companyCodes) && req.user.companyCodes.length ? req.user.companyCodes : (req.user?.companyCode ? [req.user.companyCode] : [])).map(c => clean(c, 80));
  const pool = getPool();
  let filepath;
  try {
    const { fields, files } = await parseForm(req);
    let sc = isInternal ? clean(fields.supplier_code || "", 80) : (codes[0] || "");
    if (!sc) return res.status(400).json({ success: false, error: "supplier_code required" });
    if (!isInternal && !codes.includes(sc)) return res.status(403).json({ success: false, error: "supplier scope" });
    const f = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!f) return res.status(400).json({ success: false, error: "file required" });
    filepath = f.filepath || f.path;
    const buffer = fs.readFileSync(filepath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ success: false, error: "空表" });

    // 表头 → 字段
    const colField = {};
    ws.getRow(1).eachCell((cell, col) => { const fld = fieldFor(cv(cell.value)); if (fld) colField[col] = fld; });
    if (!Object.values(colField).includes("name")) return res.status(400).json({ success: false, error: "首行需有 品名 列" });

    // 图片按行锚点
    const rowImg = {};
    for (const im of (ws.getImages() || [])) {
      const r = Math.round((im.range?.tl?.nativeRow ?? im.range?.tl?.row ?? 0)) + 1;
      if (rowImg[r] == null) rowImg[r] = im.imageId;
    }

    let imported = 0, imgN = 0, created = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rec = {};
      for (const [col, fld] of Object.entries(colField)) rec[fld] = cv(row.getCell(Number(col)).value);
      const name = clean(rec.name, 300);
      if (!name) continue;
      // 图片
      let image_url = null;
      if (rowImg[r] != null) {
        try {
          const media = wb.getImage(rowImg[r]);
          const ext = (media.extension || "png").replace("jpeg", "jpg");
          const url = await ossUploadBuffer(`supplier-catalog/${sc}-${name.replace(/[^\w]/g, "").slice(0, 12)}-${r}.${ext}`, media.buffer, `image/${media.extension || "png"}`);
          if (url) { image_url = url; imgN++; }
        } catch (_) {}
      }
      // upsert by (supplier_code, name)
      const ex = await pool.query("SELECT sku_code FROM packaging_materials WHERE supplier_code=$1 AND name=$2 LIMIT 1", [sc, name]);
      const set = { material: clean(rec.material, 300), spec: clean(rec.spec, 120), brand: clean(rec.brand, 80), barcode: clean(rec.barcode, 80), supplier_item_code: clean(rec.supplier_item_code, 80), unit: clean(rec.unit, 20) || "个", notes: clean(rec.notes, 300) };
      for (const nf of NUMF) if (rec[nf] !== undefined) set[nf] = nnum(rec[nf]);
      for (const df of DATEF) { const d = clean(rec[df], 20); if (d && /\d{4}-\d{2}-\d{2}/.test(d)) set[df] = d.slice(0, 10); }
      if (image_url) set.image_url = image_url;
      const cols = Object.keys(set), ph = cols.map((_, i) => `$${i + 5}`);
      if (ex.rows.length) {
        await pool.query(`UPDATE packaging_materials SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")}, updated_at=NOW() WHERE sku_code=$${cols.length + 1}`,
          [...cols.map(c => set[c]), ex.rows[0].sku_code]);
      } else {
        const sku = `${sc}-U${Date.now().toString(36)}${r}`;
        await pool.query(`INSERT INTO packaging_materials(sku_code, name, supplier, supplier_code, product_skus, ${cols.join(",")}) VALUES($1,$2,$3,$4,'[]'::jsonb,${ph.join(",")})`,
          [sku, name, req.user?.company || sc, sc, ...cols.map(c => set[c])]);
        created++;
      }
      imported++;
    }
    return res.status(200).json({ success: true, imported, created, updated: imported - created, images: imgN });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (filepath) { try { fs.unlinkSync(filepath); } catch (_) {} }
  }
}
