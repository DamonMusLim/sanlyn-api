import { getPool, setCors } from "../db.js";
import { loadSellerCfg, scrubCustomerFacingHtml } from "./doc-data.js";
import { htmlToPdf } from "./_html-to-pdf.js";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";

const UPLOADS_DIR = "/opt/sanlyn-uploads/ocean";
const SHARE_BASE = process.env.API_BASE || "https://api.sanlyn.cn";

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pick = (...a) => { for (const x of a) if (x !== undefined && x !== null && x !== "") return x; return ""; };
const fmtD = v => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? String(v) : d.toISOString().slice(0, 10); };
const miss = (v, label = "待填/缺") => pick(v) || label;
const cleanKind = k => ({ so: "so", sq: "sq", freight: "freight" }[String(k || "").toLowerCase()] || "");
const normRef = b => String(b.ref || b.id || b.contract_no || b.bl_no || "").trim();

function obj(v) { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return {}; } }
function overlay(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== "object") return out;
  for (const [k, v] of Object.entries(over)) {
    if (Array.isArray(v)) out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = overlay(out[k] || {}, v);
    else if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

async function loadOceanDoc(pool, ref, kind) {
  const q = await pool.query(
    `SELECT * FROM shipping_plans
      WHERE _id=$1 OR shipment_no=$1 OR contract_no=$1 OR bl_no=$1
         OR id::text=$1 OR order_contract_nos ILIKE '%'||$1||'%'
      LIMIT 1`, [ref]
  );
  if (!q.rows.length) return null;
  const sp = q.rows[0], raw = obj(sp.raw);
  const cfg = await loadSellerCfg(pool, raw, "", { shipping: true });
  const isSO = kind === "so";
  const canonKind = isSO ? "so" : kind;
  const docTitle = isSO ? "海运单" : "海运确认报价";
  const docTitleEN = isSO ? "SHIPPING ORDER" : "OCEAN FREIGHT QUOTATION";
  const docNo = (isSO ? "SO-" : "FQ-") + pick(sp.bl_no, sp.contract_no, sp.shipment_no, ref);
  const issueDate = new Date().toISOString().slice(0, 10);
  const orderRaw = {};
  const computed = {
    kind: canonKind, ref_no: ref, title_cn: docTitle, title_en: docTitleEN,
    seller_code: raw.shipping_vendor || raw.shippingVendor || "yangbaobao",
    seller: { name: pick(cfg.nameEN, raw.shipper), address: cfg.address || "", tel: cfg.tel || "", email: cfg.email || "" },
    bill_to: { name: pick(sp.customer_en, sp.customer, raw.consignee), address: pick(raw.consigneeAddress, raw.customerAddress) },
    details: [
      { label: "Doc No.", value: docNo },
      { label: "Contract", value: pick(sp.contract_no, raw.contractNo) },
      { label: "B/L No.", value: pick(sp.bl_no, raw.blNo, raw.bl_no) },
      { label: "Issue Date", value: issueDate }
    ],
    route: { pol: pick(sp.pol, raw.pol), pod: pick(sp.pod, raw.pod) },
    parties: { shipper: pick(raw.shipper, cfg.nameEN), carrier: pick(sp.carrier_code, sp.shipping_line, raw.carrier), forwarder: pick(sp.forwarder_cn, raw.forwarderCN, raw.freightForwarder) },
    shipment: [
      { no: "01", item: "Vessel / Voyage", container: pick(sp.container_type, raw.containerType, "40HQ"), value: [pick(sp.vessel, raw.vessel), pick(sp.voyage, raw.voyage)].filter(Boolean).join(" ") },
      { no: "02", item: "B/L No.", container: "", value: pick(sp.bl_no, raw.blNo, raw.bl_no) },
      { no: "03", item: "Booking No.", container: "", value: pick(sp.forwarder_booking_no, raw.bookingNo) },
      { no: "04", item: "Container No. / Seal", container: pick(sp.container_type, raw.containerType, "40HQ"), value: [pick(sp.container_no, raw.containerNo), pick(sp.seal_no, raw.sealNo)].filter(Boolean).join(" / ") },
      { no: "05", item: "ETD -> ETA", container: "", value: [fmtD(pick(sp.etd, raw.etd)), fmtD(pick(sp.eta, raw.eta))].filter(Boolean).join(" -> ") },
      { no: "06", item: "ATD", container: "", value: fmtD(pick(sp.atd, raw.atd)) }
    ],
    cargo: [
      { item: "Total Cartons", value: pick(sp.total_cartons, orderRaw.totalQty, raw.totalQty) },
      { item: "Gross Weight", value: pick(sp.gross_weight_kg, sp.gross_weight, orderRaw.grossWeight, raw.grossWeight), unit: "KG" },
      { item: "CBM", value: pick(sp.total_cbm, orderRaw.totalCBM, raw.totalCBM), unit: "m3" }
    ],
    terms: isSO
      ? ["本海运单为运输确认凭证，仅供报关、提货使用。", "本单据不含金额；如需查看商业金额请下载 Commercial Invoice (IV)。"]
      : ["本海运报价确认基于上述航次。", "本运价不含金额，仅作运输安排确认；正式账单见 Freight Debit Note (DN)。Local charges 另行结算。"],
    signatures: { left: "SHIPPER ACKNOWLEDGED", right: "CARRIER / AGENT" },
    seal_url: "", seal_name: "", has_override: false
  };
  let override = {}, sealUrl = "", sealName = "";
  try {
    const r = await pool.query("SELECT data,seal_url,seal_name FROM ocean_doc_overrides WHERE ref_no=$1 AND doc_kind=$2 LIMIT 1", [ref, canonKind]);
    if (r.rows[0]) { override = obj(r.rows[0].data); sealUrl = r.rows[0].seal_url || ""; sealName = r.rows[0].seal_name || ""; }
  } catch {}
  let defaultSeal = cfg.seal_url || "";
  try {
    const sr = await pool.query("SELECT url,name FROM customer_stamps WHERE company_code=$1 AND COALESCE(is_default,false) AND COALESCE(is_active,true) ORDER BY id DESC LIMIT 1", [computed.seller_code]);
    defaultSeal = pick(defaultSeal, sr.rows[0]?.url); if (!sealName) sealName = defaultSeal === sr.rows[0]?.url ? (sr.rows[0]?.name || "") : "";
  } catch {}
  const data = overlay(computed, override);
  data.seal_url = pick(sealUrl, cfg.seal_url, data.seal_url, defaultSeal);
  data.seal_name = sealName || data.seal_name || "";
  data.has_override = Object.keys(override).length > 0 || !!sealUrl;
  return data;
}

function renderHtml(d) {
  const red = v => pick(v) ? esc(v) : '<span style="color:#dc2626;font-weight:800">待填/缺</span>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(d.title_en)} ${esc((d.details?.[0]||{}).value)}</title><style>
*{box-sizing:border-box}body{margin:0;padding:30px 18px;background:#eef0f3;color:#111;font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}.wrap{max-width:880px;margin:0 auto}.doc{background:#fff;border:1px solid #e2e8f0;box-shadow:0 4px 18px rgba(0,0,0,.12);overflow:hidden}.hdr{padding:22px 26px;border-bottom:2px solid #111;background:#fff;display:flex;justify-content:space-between;gap:24px}.hdr h1{margin:0 0 4px;font-size:18px}.seller,.qno,.k{color:#555;font-size:11px}.qno{text-align:right}.big{font-size:16px;color:#111;font-weight:800}.meta{padding:16px 26px;background:#fff;display:grid;grid-template-columns:1fr 1fr;gap:7px 24px}.v,td{font-family:Menlo,Consolas,monospace}.v{font-weight:700;color:#111}.sec{padding:18px 26px;border-top:1px solid #e2e5e9}.ttl{font-size:11px;color:#1d4ed8;font-weight:800;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#111;color:#fff;text-align:left;font-size:10px;font-weight:800}td,th{padding:10px;border-bottom:1px solid #e2e5e9}.r{text-align:right}.c{text-align:center}.terms{padding:14px 26px;background:#fff;color:#333;border-top:1px solid #e2e5e9}.sig{padding:24px 26px;display:grid;grid-template-columns:1fr 1fr;gap:60px;background:#fff;border-top:1px solid #e2e5e9;position:relative}.sig div{border-top:1px solid #111;text-align:center;padding-top:7px;font-size:10px;color:#555}.seal{position:absolute;right:145px;top:4px;width:100px;height:100px;object-fit:contain}.foot{padding:10px 26px;text-align:center;color:#9aa1a9;font-size:10px;border-top:1px dashed #ccc}@media print{body{background:#fff;color:#000;padding:0}.doc,.hdr,.meta,.terms,.sig{background:#fff;color:#000;box-shadow:none}.seller,.qno,.k,.terms,.sig div{color:#444}.v,td,.big{color:#000}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="wrap"><div class="doc">
<div class="hdr"><div><h1>${esc(d.title_en)}</h1><div class="seller"><b>${red(d.seller?.name)}</b><br>${red(d.seller?.address)}<br>Tel: ${red(d.seller?.tel)} · Email: ${red(d.seller?.email)}</div></div><div class="qno"><div class="big">${red(d.details?.[0]?.value)}</div><div>${esc(d.title_cn)}</div><div>Issue date: ${red((d.details?.[3]||{}).value)}</div></div></div>
<div class="meta"><div class="k">SHIPPER 发货方</div><div class="k">BILL TO 客户</div><div class="v">${red(d.parties?.shipper)}</div><div class="v">${red(d.bill_to?.name)}<br>${red(d.bill_to?.address)}</div><div class="k">POL 起运港</div><div class="k">POD 目的港</div><div class="v">${red(d.route?.pol)}</div><div class="v">${red(d.route?.pod)}</div><div class="k">CARRIER 船公司</div><div class="k">FORWARDER 货代</div><div class="v">${red(d.parties?.carrier)}</div><div class="v">${red(d.parties?.forwarder)}</div></div>
<div class="sec"><div class="ttl">DETAILS / SHIPMENT</div><table><thead><tr><th style="width:40px">NO.</th><th>Detail</th><th class="c">Container</th><th class="r">Value</th></tr></thead><tbody>${(d.shipment||[]).map(r=>`<tr><td class="c">${esc(r.no)}</td><td>${red(r.item)}</td><td class="c">${red(r.container)}</td><td class="r">${red(r.value)}</td></tr>`).join("")}</tbody></table></div>
<div class="sec"><div class="ttl">CARGO 货物</div><table><tbody>${(d.cargo||[]).map(r=>`<tr><td>${red(r.item)}</td><td class="r"><b>${red(r.value)}</b> ${esc(r.unit||"")}</td></tr>`).join("")}</tbody></table></div>
<div class="terms"><b style="color:#1d4ed8">NOTE</b><ul>${(d.terms||[]).map(t=>`<li>${red(t)}</li>`).join("")}</ul></div>
<div class="sig">${d.seal_url?`<img class="seal" src="${esc(d.seal_url)}" alt="seal">`:""}<div><b>${esc(d.signatures?.left||"SHIPPER")}</b>(签字 / 盖章)</div><div><b>${esc(d.signatures?.right||"AGENT")}</b>(签字 / 盖章)</div></div>
<div class="foot">Generated &amp; Verified by Sanlyn OS · ${esc((d.details?.[3]||{}).value||"")}</div></div></div></body></html>`;
}

function sharePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const seg = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return seg(3) + "-" + seg(3) + "-" + seg(3);
}

async function createShare(pool, req, ref, kind) {
  const data = await loadOceanDoc(pool, ref, kind);
  if (!data) return { status: 404, body: { error: "shipment_not_found", ref } };
  let pdf;
  try { pdf = await htmlToPdf(scrubCustomerFacingHtml(renderHtml(data))); }
  catch (e) { return { status: 500, body: { error: "PDF render failed: " + e.message } }; }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const safeRef = String(ref).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "ocean";
  const safeKind = String(kind).replace(/[^a-zA-Z0-9._-]/g, "_") || "doc";
  const fname = safeRef + "_" + safeKind + "_" + randomBytes(6).toString("hex") + ".pdf";
  writeFileSync(path.join(UPLOADS_DIR, fname), pdf);
  const fileUrl = SHARE_BASE + "/uploads/ocean/" + encodeURIComponent(fname);
  const token = randomBytes(6).toString("hex");
  const password = sharePassword();
  const by = (req.user && (req.user.username || req.user.name)) || "admin";
  await pool.query(
    `INSERT INTO doc_share_links
       (token, contract_no, doc_key, doc_url, doc_name, password,
        created_by, expires_at, max_downloads, download_count, downloaded_log)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()+INTERVAL '7 days', 50, 0, $8::jsonb)`,
    [token, ref, "ocean:" + kind + ":" + ref, fileUrl, data.title_en + " " + ref, password, by,
     JSON.stringify([{ action: "created", by, doc: "ocean:" + kind + ":" + ref, ts: new Date().toISOString() }])]
  );
  const shareUrl = SHARE_BASE + "/api/db/doc-share?token=" + token;
  const quickUrl = shareUrl + "&password=" + encodeURIComponent(password);
  return { status: 200, body: { ok: true, quickUrl, shareUrl, password, expiresInDays: 7 } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const pool = getPool();
  if (req.method === "POST") {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {}, ref = normRef(b), kind = cleanKind(b.kind);
    if (!ref || !kind) return res.status(400).json({ error: "ref and kind required" });
    if (String(req.query?.action || "") === "share") {
      const out = await createShare(pool, req, ref, kind);
      return res.status(out.status).json(out.body);
    }
    const data = b.data && typeof b.data === "object" ? b.data : {};
    await pool.query(
      `INSERT INTO ocean_doc_overrides(ref_no,doc_kind,data,seal_url,seal_name,updated_by)
       VALUES($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT(ref_no,doc_kind) DO UPDATE SET data=EXCLUDED.data, seal_url=EXCLUDED.seal_url,
       seal_name=EXCLUDED.seal_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [ref, kind, JSON.stringify(data), b.seal_url || null, b.seal_name || null, req.user.username || "manual"]
    );
    return res.json({ success: true, ref, kind, count: Object.keys(data).length });
  }
  const q = req.query || {}, ref = normRef(q), kind = cleanKind(q.kind);
  if (!ref || !kind) return res.status(400).json({ error: "ref and kind required" });
  if (String(q.action || "") === "share") {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    const out = await createShare(pool, req, ref, kind);
    return res.status(out.status).json(out.body);
  }
  const data = await loadOceanDoc(pool, ref, kind);
  if (!data) return res.status(404).json({ error: "shipment_not_found", ref });
  if (String(q.format || "") === "json") { res.setHeader("Cache-Control", "no-store"); return res.json(data); }
  if (String(q.format || "") === "xlsx") {
    try {
      const ExcelJS = (await import("exceljs")).default, wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(data.kind.toUpperCase());
      ws.columns = [{ width: 18 }, { width: 42 }, { width: 18 }, { width: 36 }];
      ws.addRow([data.seller?.name]); ws.addRow([data.title_cn + " / " + data.title_en]); ws.addRow([]);
      ws.addRow(["Bill To", data.bill_to?.name, "Address", data.bill_to?.address]);
      ws.addRow(["POL", data.route?.pol, "POD", data.route?.pod]); ws.addRow([]);
      ws.addRow(["NO.", "Item", "Container", "Value"]).font = { bold: true };
      (data.shipment || []).forEach(r => ws.addRow([r.no, r.item, r.container, r.value]));
      ws.addRow([]); (data.cargo || []).forEach(r => ws.addRow([r.item, r.value, r.unit || ""]));
      ws.addRow([]); (data.terms || []).forEach(t => ws.addRow(["NOTE", t]));
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.xlsx"');
      return res.send(Buffer.from(buf));
    } catch (e) { return res.status(500).json({ error: "xlsx_failed", detail: e.message }); }
  }
  const html = renderHtml(data);
  if (String(q.format || "") === "pdf") {
    try {
      const puppeteer = (await import("puppeteer")).default;
      const browser = await puppeteer.launch({ headless: "new", executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
      const page = await browser.newPage(); await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
      await browser.close(); res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.pdf"');
      return res.send(Buffer.from(pdf));
    } catch (e) { return res.status(503).json({ error: "pdf_render_unavailable", detail: e.message }); }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}
