// /api/db/shipping-transfer-gen.js
// POST /api/db/shipping-transfer-gen?plan_id=<sp._id>&start_date=YYYY-MM-DD
// 自动生成内转外 Excel，20GP 双拖（每2柜同一天），上传 OSS + 写 doc-uploads
import ExcelJS from "exceljs";
import OSS from "ali-oss";
import { getPool, setCors } from "../db.js";

const TARE_T = 2.2;           // 20GP 柜皮重（吨）
const EXPORT_PORT = "厦门";   // 外贸出口港口固定
const COLS = [
  { header: "进口船名航次",  key: "vesselVoyage",  width: 24 },
  { header: "内贸船到港时间", key: "eta",           width: 18 },
  { header: "进口内贸提单号", key: "inlandBl",      width: 20 },
  { header: "柜型柜量",       key: "ctnType",       width: 12 },
  { header: "柜号",           key: "ctnNo",         width: 20 },
  { header: "封铅",           key: "sealNo",        width: 18 },
  { header: "外贸出口港口",   key: "exportPort",    width: 14 },
  { header: "对应外贸提单号", key: "exportBl",      width: 22 },
  { header: "对应船名航次",   key: "exportVoyage",  width: 24 },
  { header: "件数",           key: "totalCtn",      width: 10 },
  { header: "重量(t)",        key: "weightT",       width: 12 },
  { header: "体积(m³)",       key: "cbm",           width: 12 },
  { header: "柜重(t)",        key: "tareT",         width: 10 },
  { header: "VGM(t)",         key: "vgm",           width: 10 },
  { header: "内转外时间",     key: "transferDate",  width: 16 },
];

function fmt3(n) { return Math.round(Number(n || 0) * 1000) / 1000; }
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}
function tomorrow() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return fmtDate(d);
}

async function queryRows(pool, planId) {
  const sql = `
    SELECT
      sp._id           AS sp_id,
      sp.bl_no         AS export_bl,
      sp.vessel,
      sp.voyage,
      sp.etd,
      sp.shipment_no,
      cb.id            AS cb_id,
      cb.container_no,
      cb.seal_no,
      cb.contract_no,
      cb.container_type,
      COALESCE(cb.cargo_weight_kg, o.gross_weight, 0)::numeric AS gw_kg,
      COALESCE(o.net_weight,  0)::numeric AS nw_kg,
      COALESCE(o.total_cbm,  0)::numeric AS cbm,
      COALESCE(o.qty_ctn,  0)::int     AS total_ctn
    FROM shipping_plans sp
    JOIN container_bookings cb ON cb.shipping_plan_id = sp.id
    LEFT JOIN orders o ON o.contract_no = cb.contract_no
    WHERE sp._id = $1
    ORDER BY cb.id ASC
  `;
  const { rows } = await pool.query(sql, [planId]);
  return rows;
}

async function buildExcel(rows, startDate, inlandBl) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sanlyn";
  const ws = wb.addWorksheet("内转外");
  ws.columns = COLS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dayOffset = Math.floor(i / 2);   // 双拖：每2柜同一天
    const transferDate = addDays(startDate, dayOffset);
    const vesselVoyage = [r.vessel, r.voyage].filter(Boolean).join(" ");
    const gwT = fmt3(Number(r.gw_kg) / 1000);
    const vgm = fmt3(gwT + TARE_T);

    const dataRow = ws.addRow({
      vesselVoyage,
      eta:          fmtDate(r.etd),
      inlandBl:     inlandBl || r.shipment_no || "",
      ctnType:      r.container_type || "20GP",
      ctnNo:        r.container_no,
      sealNo:       r.seal_no,
      exportPort:   EXPORT_PORT,
      exportBl:     r.export_bl,
      exportVoyage: vesselVoyage,
      totalCtn:     r.total_ctn,
      weightT:      gwT,
      cbm:          fmt3(r.cbm),
      tareT:        TARE_T,
      vgm,
      transferDate,
    });
    dataRow.eachCell(cell => {
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = { top:{style:"thin"}, left:{style:"thin"}, bottom:{style:"thin"}, right:{style:"thin"} };
    });
  }

  return wb.xlsx.writeBuffer();
}

async function uploadOSS(buffer, blNo) {
  const client = new OSS({
    region:          process.env.OSS_REGION,
    accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket:          process.env.OSS_BUCKET,
  });
  const ts = Date.now();
  const safe = String(blNo).replace(/[^a-zA-Z0-9_-]/g, "_");
  const ossPath = `shipping/neizhuanwai/${ts}_${safe}_内转外.xlsx`;
  await client.put(ossPath, buffer, { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return {
    ossPath,
    ossUrl: `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossPath}`,
  };
}

async function saveDocUpload(req, { planId, contractNo, ossUrl, ossPath, size, startDate }) {
  const port = process.env.PORT || 3721;
  const resp = await fetch(`http://localhost:${port}/api/db/doc-uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.authorization || "",
    },
    body: JSON.stringify({
      docId:      planId,
      docType:    "shipping_transfer",
      contractNo: contractNo || "",
      url:        ossUrl,
      name:       ossPath.split("/").pop(),
      size,
      note:       `内转外自动生成 双拖2柜/天 start=${startDate}`,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  return j.id || null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const planId    = req.query?.plan_id  || req.body?.plan_id;
  const startDate = req.query?.start_date || req.body?.start_date || tomorrow();
  const inlandBl  = req.query?.inland_bl  || req.body?.inland_bl  || "";

  if (!planId) return res.status(400).json({ error: "plan_id required" });

  // Validate date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: "start_date must be YYYY-MM-DD" });
  }

  try {
    const pool = getPool();
    const rows = await queryRows(pool, planId);
    if (!rows.length) return res.status(404).json({ error: "No containers found for plan_id: " + planId });

    const buffer = await buildExcel(rows, startDate, inlandBl);
    const blNo = rows[0].export_bl || planId;
    const { ossUrl, ossPath } = await uploadOSS(Buffer.from(buffer), blNo);

    const docUploadId = await saveDocUpload(req, {
      planId,
      contractNo: rows[0].contract_no,
      ossUrl,
      ossPath,
      size: buffer.byteLength,
      startDate,
    });

    return res.json({
      ossUrl,
      docUploadId,
      rowCount: rows.length,
      startDate,
      days: Math.ceil(rows.length / 2),
    });
  } catch (err) {
    console.error("[shipping-transfer-gen]", err);
    return res.status(500).json({ error: err.message });
  }
}
