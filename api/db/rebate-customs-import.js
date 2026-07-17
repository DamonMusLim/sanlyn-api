import { read, utils } from "xlsx";
import { IncomingForm } from "formidable";

const COLS = {
  no: 0, exportDate: 1, hs: 2, name: 3, contract: 4, invoice: 5,
  dealMethod: 6, dealUnit: 7, dealQty: 8, currency: 9, amount: 10,
  usdFob: 11, cnyFob: 12, legalUnit: 13, legalQty: 14, unit2: 15, qty2: 16,
};

function text(v) {
  return v == null ? "" : String(v).trim();
}

function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function excelDate(v) {
  if (!v) return null;
  // SheetJS cellDates:true builds Date objects meant to be read via LOCAL
  // getters (getFullYear/getMonth/getDate), not toISOString() (UTC) —
  // using toISOString() silently loses a day on positive-offset timezones
  // (confirmed on this Asia/Shanghai host: 2026-05-14 excel date -> Date
  // "2026-05-13T16:00:00Z" -> local getters correctly give 2026-5-14).
  if (v instanceof Date) return toYMD(v);
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return toYMD(d);
  }
  const s = text(v).replace(/[./]/g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

export function hsCode8(hs10) {
  const hs = text(hs10);
  return hs.endsWith("00") && hs.length === 10 ? hs.slice(0, 8) : hs;
}

function splitCustomsItem(v) {
  const s = text(v).replace(/\s/g, "");
  if (s.length < 21) throw new Error(`bad customs item no: ${s}`);
  return { customs_no: s.slice(0, 18), item_no: s.slice(-3) };
}

function rowToLine(row, importBatch, declareYm) {
  const ids = splitCustomsItem(row[COLS.no]);
  const exportDate = excelDate(row[COLS.exportDate]);
  const hs10 = text(row[COLS.hs]);
  return {
    ...ids,
    hs_code_10: hs10,
    hs_code_8: hsCode8(hs10),
    name_cn: text(row[COLS.name]),
    deal_method: text(row[COLS.dealMethod]),
    deal_unit: text(row[COLS.dealUnit]),
    deal_qty: num(row[COLS.dealQty]),
    deal_currency: text(row[COLS.currency]),
    deal_amount_cny: num(row[COLS.amount]),
    usd_fob: num(row[COLS.usdFob]),
    cny_fob: num(row[COLS.cnyFob]),
    legal_unit: text(row[COLS.legalUnit]),
    legal_qty: num(row[COLS.legalQty]),
    unit2: text(row[COLS.unit2]),
    qty2: num(row[COLS.qty2]),
    export_invoice_no: text(row[COLS.contract]) || text(row[COLS.invoice]),
    export_date: exportDate,
    declare_ym: declareYm || (exportDate ? exportDate.slice(0, 7).replace("-", "") : null),
    import_batch: importBatch,
  };
}

async function parseUpload(req) {
  const form = new IncomingForm({ multiples: false, maxFileSize: 20 * 1024 * 1024 });
  const [, files] = await form.parse(req);
  const f = files.file?.[0] || files.upload?.[0] || Object.values(files)[0]?.[0];
  if (!f) throw new Error("file is required");
  const fs = await import("fs/promises");
  return fs.readFile(f.filepath);
}

export async function importCustomsLines(pool, { buffer, importBatch, declareYm }) {
  const wb = read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json(ws, { header: 1, defval: "" });
  const batch = importBatch || `smart-match-${new Date().toISOString().slice(0, 10)}`;
  let imported = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    if (!text(rows[i][COLS.no])) continue;
    try {
      const line = rowToLine(rows[i], batch, declareYm);
      await pool.query(
        `INSERT INTO rebate_customs_lines
         (customs_no,item_no,hs_code_10,hs_code_8,name_cn,deal_method,deal_unit,deal_qty,
          deal_currency,deal_amount_cny,usd_fob,cny_fob,legal_unit,legal_qty,unit2,qty2,
          export_invoice_no,export_date,declare_ym,import_batch,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
         ON CONFLICT (customs_no,item_no) DO UPDATE SET
          hs_code_10=EXCLUDED.hs_code_10, hs_code_8=EXCLUDED.hs_code_8, name_cn=EXCLUDED.name_cn,
          deal_method=EXCLUDED.deal_method, deal_unit=EXCLUDED.deal_unit, deal_qty=EXCLUDED.deal_qty,
          deal_currency=EXCLUDED.deal_currency, deal_amount_cny=EXCLUDED.deal_amount_cny,
          usd_fob=EXCLUDED.usd_fob, cny_fob=EXCLUDED.cny_fob, legal_unit=EXCLUDED.legal_unit,
          legal_qty=EXCLUDED.legal_qty, unit2=EXCLUDED.unit2, qty2=EXCLUDED.qty2,
          export_invoice_no=EXCLUDED.export_invoice_no, export_date=EXCLUDED.export_date,
          declare_ym=EXCLUDED.declare_ym, import_batch=EXCLUDED.import_batch, updated_at=now()`,
        [line.customs_no, line.item_no, line.hs_code_10, line.hs_code_8, line.name_cn,
         line.deal_method, line.deal_unit, line.deal_qty, line.deal_currency, line.deal_amount_cny,
         line.usd_fob, line.cny_fob, line.legal_unit, line.legal_qty, line.unit2, line.qty2,
         line.export_invoice_no, line.export_date, line.declare_ym, line.import_batch]
      );
      imported++;
    } catch (e) {
      errors.push({ row: i + 1, error: e.message });
    }
  }
  return { import_batch: batch, imported, errors };
}

export async function handleCustomsImport(req, res, pool) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const buffer = req.body?.file_base64
    ? Buffer.from(String(req.body.file_base64).replace(/^data:.*?;base64,/, ""), "base64")
    : await parseUpload(req);
  const declareYm = String(req.query.declare_ym || req.body?.declare_ym || "").replace(/[^0-9]/g, "") || null;
  const result = await importCustomsLines(pool, { buffer, importBatch: req.query.import_batch || req.body?.import_batch, declareYm });
  return res.json({ success: true, ...result });
}
