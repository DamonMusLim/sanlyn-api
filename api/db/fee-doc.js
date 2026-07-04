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
const obj = v => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return {}; } };
const normRef = b => String(b.ref || b.id || b.contract_no || b.bl_no || "").trim();
const cleanKind = k => ({ debit: "debit", portcharge: "portcharge" }[String(k || "").toLowerCase()] || "");
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const hasAmt = v => v !== undefined && v !== null && v !== "" && Number(v) > 0;
const fmtM = n => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function overlay(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== "object") return out;
  for (const [k, v] of Object.entries(over)) {
    if (Array.isArray(v)) out[k] = v;
    else if (v && typeof v === "object") out[k] = overlay(out[k] || {}, v);
    else if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

async function loadPlan(pool, ref) {
  const q = await pool.query(
    `SELECT * FROM shipping_plans
      WHERE _id=$1 OR shipment_no=$1 OR contract_no=$1 OR bl_no=$1
         OR id::text=$1 OR order_contract_nos ILIKE '%'||$1||'%'
      LIMIT 1`, [ref]
  );
  return q.rows[0] || null;
}

function amountTotals(lines, exr) {
  const by = {};
  (lines || []).forEach(r => {
    if (hasAmt(r.amount)) by[r.currency || "CNY"] = (by[r.currency || "CNY"] || 0) + num(r.amount);
  });
  const rows = Object.keys(by).sort().map(c => ({ currency: c, amount: Number(by[c].toFixed(2)) }));
  const cny = by.CNY || by.RMB || 0, usd = by.USD || 0;
  return { rows, cny_equiv: exr > 0 ? Number((cny + usd * exr).toFixed(2)) : null };
}

function debitLines(sp) {
  const cqty = pick(sp.container_qty, obj(sp.raw).containerQty, 1);
  const term = pick(sp.freight_term, "");
  const isFob = ["FOB", "FCA"].includes(String(term || "").toUpperCase().trim());
  const portMisc = ["THC", "DOCUMENTATION FEE", "SEAL FEE", "B/L FEE", "EIR", "VGM", "BOOKING FEE"];
  const rows = [
    ["OCEAN FREIGHT", "海运费", cqty, "USD", sp.freight_sale_usd],
    ["THC", "码头操作费", 1, "CNY", sp.thc_fee],
    ["DOCUMENTATION FEE", "文件费", 1, "CNY", sp.doc_fee],
    ["SEAL FEE", "铅封费", cqty, "CNY", sp.seal_fee],
    ["B/L FEE", "提单/电放费", 1, "CNY", sp.tlx_fee],
    ["EIR", "设备交接费", cqty, "CNY", sp.eir_fee],
    ["VGM", "信息代输费", 1, "CNY", sp.info_trans_fee],
    ["BOOKING FEE", "订舱费", 1, "CNY", sp.bkg_fee],
    ["TRUCKING", "拖车费", 1, "CNY", sp.trucking_cost_total],
    ["CUSTOMS", "报关费", 1, "CNY", sp.customs_cost_total],
    ["INSURANCE", "保险费", 1, "USD", sp.insurance_cost],
  ];
  return rows.filter(r => !isFob || !portMisc.includes(r[0])).filter(r => hasAmt(r[4]) || r[4] == null || r[4] === "").map(r => ({
    item: r[0], desc: r[1], qty: r[2], currency: r[3], unit_price: "", amount: hasAmt(r[4]) ? num(r[4]) : ""
  }));
}

async function portchargeLines(pool, sp, ref) {
  const blNo = pick(sp.bl_no, ref);
  const r = await pool.query(
    `SELECT cost_category,amount,currency,qty,unit_price,charge_basis,payer_company_code
       FROM active_freight_supplier_bills
      WHERE bl_no=$1 AND (cost_category !~* '海运|ocean|freight') AND COALESCE(amount,0)>0
      ORDER BY id`, [blNo]
  );
  return r.rows.map(x => ({
    item: pick(x.cost_category, "港杂费"), desc: pick(x.charge_basis, "整票"),
    qty: num(x.qty) || 1, currency: String(x.currency || "CNY").toUpperCase(),
    unit_price: x.unit_price != null ? num(x.unit_price) : "", amount: num(x.amount),
    payer_company_code: x.payer_company_code || ""
  }));
}

async function loadBillTo(pool, sp, raw, kind, lines) {
  if (kind === "portcharge") {
    const code = (lines.find(r => r.payer_company_code) || {}).payer_company_code || "";
    if (code) {
      try { const c = await pool.query("SELECT name_cn,name_en,address,tax_id FROM companies WHERE code=$1 LIMIT 1", [code]); const x = c.rows[0]; if (x) return { name: pick(x.name_cn, x.name_en), address: x.address || "", tax_id: x.tax_id || "" }; } catch {}
    }
  }
  return { name: pick(sp.customer_en, sp.customer, raw.consignee), address: pick(raw.consigneeAddress, raw.customerAddress), tax_id: "" };
}

async function loadFeeDoc(pool, ref, kind) {
  const sp = await loadPlan(pool, ref);
  if (!sp) return null;
  const raw = obj(sp.raw), cfg = await loadSellerCfg(pool, raw, "", { shipping: true });
  const lines = kind === "portcharge" ? await portchargeLines(pool, sp, ref) : debitLines(sp);
  const billTo = await loadBillTo(pool, sp, raw, kind, lines);
  const exr = num(pick(sp.exchange_rate, raw.exchangeRate, 0));
  const docNo = (kind === "debit" ? "DB-" : "PC-") + pick(sp.contract_no, sp.bl_no, sp.shipment_no, ref);
  const title = kind === "debit" ? ["借记通知单", "DEBIT NOTE"] : ["港杂费对账单", "PORT CHARGES STATEMENT"];
  const data = {
    kind, ref_no: ref, title_cn: title[0], title_en: title[1], seller_code: raw.shipping_vendor || raw.shippingVendor || "yangbaobao",
    seller: { name: pick(cfg.nameEN, raw.shipper), address: cfg.address || "", tel: cfg.tel || "", email: cfg.email || "" },
    bill_to: billTo,
    details: [
      { label: "Doc No.", value: docNo }, { label: "Contract", value: pick(sp.contract_no, raw.contractNo) },
      { label: "B/L No.", value: pick(sp.bl_no, raw.blNo, raw.bl_no) }, { label: "Issue Date", value: fmtD(new Date()) },
      { label: "Freight Term", value: pick(sp.freight_term, "") }, { label: "Quote Ref", value: pick(sp.quote_ref, "") }
    ],
    route: { pol: pick(sp.pol, raw.pol), pod: pick(sp.pod, raw.pod) },
    shipment: { vessel: pick(sp.vessel, raw.vessel), voyage: pick(sp.voyage, raw.voyage), etd: fmtD(pick(sp.etd, raw.etd)), container_type: pick(sp.container_type, raw.containerType), container_qty: pick(sp.container_qty, raw.containerQty, 1) },
    fee_lines: lines, totals: amountTotals(lines, exr), exchange_rate: exr || "",
    note: kind === "debit" ? "Please arrange payment within 7 working days upon receipt of this debit note." : "Port charges statement based on actual supplier bills.",
    bank: { beneficiary: cfg.bank?.beneficiary || "", bankName: cfg.bank?.bankName || "", swift: cfg.bank?.swift || "", usdAccount: cfg.bank?.usdAccount || "", rmbAccount: cfg.bank?.rmbAccount || "" },
    signatures: { left: "CLIENT CONFIRMATION", right: "AUTHORIZED SIGNATURE" }, seal_url: "", seal_name: "", buyer_seal_url: "", buyer_seal_name: "", has_override: false
  };
  let override = {}, sealUrl = "", sealName = "";
  try { const r = await pool.query("SELECT data,seal_url,seal_name FROM ocean_doc_overrides WHERE ref_no=$1 AND doc_kind=$2 LIMIT 1", [ref, kind]); if (r.rows[0]) { override = obj(r.rows[0].data); sealUrl = r.rows[0].seal_url || ""; sealName = r.rows[0].seal_name || ""; } } catch {}
  let defaultSeal = cfg.seal_url || "";
  try { const sr = await pool.query("SELECT url,name FROM customer_stamps WHERE company_code=$1 AND COALESCE(is_default,false) AND COALESCE(is_active,true) ORDER BY id DESC LIMIT 1", [data.seller_code]); defaultSeal = pick(defaultSeal, sr.rows[0]?.url); if (!sealName && defaultSeal === sr.rows[0]?.url) sealName = sr.rows[0]?.name || ""; } catch {}
  const out = overlay(data, override);
  out.totals = amountTotals(out.fee_lines || [], num(out.exchange_rate));
  out.seal_url = pick(sealUrl, cfg.seal_url, out.seal_url, defaultSeal);
  out.seal_name = sealName || out.seal_name || "";
  out.has_override = Object.keys(override).length > 0 || !!sealUrl;
  return out;
}

function renderHtml(d) {
  const red = v => pick(v) ? esc(v) : '<span style="color:#dc2626;font-weight:800">待填/缺</span>';
  const money = v => hasAmt(v) ? fmtM(v) : '<span style="color:#dc2626;font-weight:800">待填/缺</span>';
  const totalRows = (d.totals?.rows || []).map(r => `<tr><td colspan="5" class="tr">GRAND TOTAL ${esc(r.currency)}</td><td class="tr"><b>${esc(r.currency)} ${fmtM(r.amount)}</b></td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(d.title_en)} ${esc(d.ref_no)}</title><style>
*{box-sizing:border-box}body{margin:0;padding:30px 18px;background:#eef0f3;color:#111;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}.wrap{max-width:880px;margin:auto}.doc{background:#fff;border:1px solid #e2e8f0;box-shadow:0 4px 18px rgba(0,0,0,.12)}.hdr{padding:22px 26px;border-bottom:2px solid #111;display:flex;justify-content:space-between;gap:24px}.hdr h1{margin:0 0 4px;font-size:21px}.seller,.qno,.k{color:#555;font-size:11px}.qno{text-align:right}.big{font-size:16px;color:#111;font-weight:800}.meta{padding:16px 26px;display:grid;grid-template-columns:1fr 1fr;gap:7px 24px}.v,td{font-family:Menlo,Consolas,monospace}.v{font-weight:700}.route{padding:12px 26px;border-top:1px solid #e2e5e9;background:#f8fafc;display:flex;gap:18px;justify-content:space-between}.sec{padding:18px 26px;border-top:1px solid #e2e5e9}.ttl{font-size:11px;color:#1d4ed8;font-weight:800;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#111;color:#fff;text-align:left;font-size:10px;font-weight:800}td,th{padding:9px;border-bottom:1px solid #e2e5e9}.tr{text-align:right}.tc{text-align:center}tfoot td{border-top:2px solid #111;font-size:13px}.note{padding:14px 26px;border-top:1px solid #e2e5e9}.bank{white-space:pre-line}.sig{padding:24px 26px;display:grid;grid-template-columns:1fr 1fr;gap:60px;border-top:1px solid #e2e5e9;position:relative;min-height:120px}.sig div{border-top:1px solid #111;text-align:center;padding-top:7px;font-size:10px;color:#555}.seal{position:absolute;right:145px;top:4px;width:100px;height:100px;object-fit:contain}.foot{padding:10px 26px;text-align:center;color:#9aa1a9;font-size:10px;border-top:1px dashed #ccc}@media print{body{background:#fff;padding:0}.doc{box-shadow:none;border:none}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="wrap"><div class="doc">
<div class="hdr"><div><h1>${esc(d.title_cn)}<br>${esc(d.title_en)}</h1><div class="seller"><b>${red(d.seller?.name)}</b><br>${red(d.seller?.address)}<br>Tel: ${red(d.seller?.tel)} · Email: ${red(d.seller?.email)}</div></div><div class="qno"><div class="big">${red(d.details?.[0]?.value)}</div><div>Issue date: ${red(d.details?.[3]?.value)}</div></div></div>
<div class="meta"><div class="k">BILL TO 付款方</div><div class="k">DETAILS 单据详情</div><div class="v">${red(d.bill_to?.name)}<br>${red(d.bill_to?.address)}</div><div class="v">B/L: ${red(d.details?.[2]?.value)}<br>Contract: ${red(d.details?.[1]?.value)}<br>Freight Term: ${red(d.details?.[4]?.value)}</div></div>
<div class="route"><span>VSL/VOY: <b>${red([d.shipment?.vessel,d.shipment?.voyage].filter(Boolean).join(" / "))}</b></span><span>POL: <b>${red(d.route?.pol)}</b></span><span>POD: <b>${red(d.route?.pod)}</b></span><span>ETD: <b>${red(d.shipment?.etd)}</b></span></div>
<div class="sec"><div class="ttl">FEE DETAILS / 费用明细</div><table><thead><tr><th style="width:38px">No.</th><th>Item</th><th>Description</th><th class="tc">Qty</th><th class="tc">Cur</th><th class="tr">Unit Price</th><th class="tr">Amount</th></tr></thead><tbody>${(d.fee_lines||[]).map((r,i)=>`<tr><td class="tc">${String(i+1).padStart(2,"0")}</td><td>${red(r.item)}</td><td>${red(r.desc)}</td><td class="tc">${red(r.qty)}</td><td class="tc">${red(r.currency)}</td><td class="tr">${r.unit_price===""?red(""):money(r.unit_price)}</td><td class="tr">${money(r.amount)}</td></tr>`).join("") || `<tr><td colspan="7" class="tc"><span style="color:#dc2626;font-weight:800">待填/缺</span></td></tr>`}</tbody><tfoot>${totalRows || `<tr><td colspan="7" class="tr"><span style="color:#dc2626;font-weight:800">GRAND TOTAL 待填/缺</span></td></tr>`}${d.kind==="debit"?`<tr><td colspan="5" class="tr">TOTAL DUE CNY EQUIV</td><td colspan="2" class="tr">${d.totals?.cny_equiv!=null?"CNY "+fmtM(d.totals.cny_equiv):'<span style="color:#dc2626;font-weight:800">汇率缺失 / FX rate required</span>'}</td></tr>`:""}</tfoot></table></div>
<div class="note"><b style="color:#1d4ed8">NOTE</b><br>${red(d.note)}${d.bank?`<div class="bank" style="margin-top:10px"><b>Banking Information</b><br>Beneficiary: ${red(d.bank.beneficiary)}<br>Bank: ${red(d.bank.bankName)}<br>SWIFT: ${red(d.bank.swift)}<br>USD: ${red(d.bank.usdAccount)}<br>RMB: ${red(d.bank.rmbAccount)}</div>`:""}</div>
<div class="sig">${d.buyer_seal_url?`<img class="seal" style="left:145px;right:auto" src="${esc(d.buyer_seal_url)}" alt="buyer seal">`:""}${d.seal_url?`<img class="seal" src="${esc(d.seal_url)}" alt="seal">`:""}<div><b>${esc(d.signatures?.left||"CLIENT")}</b>(签字 / 盖章)</div><div><b>${esc(d.signatures?.right||"SELLER")}</b>(签字 / 盖章)</div></div>
<div class="foot">Generated &amp; Verified by Sanlyn OS · ${esc(d.details?.[3]?.value||"")}</div></div></div></body></html>`;
}

function sharePassword() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; const seg = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); return seg(3) + "-" + seg(3) + "-" + seg(3); }

async function createShare(pool, req, ref, kind) {
  const data = await loadFeeDoc(pool, ref, kind);
  if (!data) return { status: 404, body: { error: "shipment_not_found", ref } };
  let pdf;
  try { pdf = await htmlToPdf(scrubCustomerFacingHtml(renderHtml(data))); } catch (e) { return { status: 500, body: { error: "PDF render failed: " + e.message } }; }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const fname = String(ref).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) + "_" + kind + "_" + randomBytes(6).toString("hex") + ".pdf";
  writeFileSync(path.join(UPLOADS_DIR, fname), pdf);
  const token = randomBytes(6).toString("hex"), password = sharePassword(), by = (req.user && (req.user.username || req.user.name)) || "admin";
  await pool.query(
    `INSERT INTO doc_share_links(token,contract_no,doc_key,doc_url,doc_name,password,created_by,expires_at,max_downloads,download_count,downloaded_log)
     VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '7 days',50,0,$8::jsonb)`,
    [token, ref, "fee:" + kind + ":" + ref, SHARE_BASE + "/uploads/ocean/" + encodeURIComponent(fname), data.title_en + " " + ref, password, by, JSON.stringify([{ action: "created", by, doc: "fee:" + kind + ":" + ref, ts: new Date().toISOString() }])]
  );
  const shareUrl = SHARE_BASE + "/api/db/doc-share?token=" + token;
  return { status: 200, body: { ok: true, quickUrl: shareUrl + "&password=" + encodeURIComponent(password), shareUrl, password, expiresInDays: 7 } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const pool = getPool();
  if (req.method === "POST") {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {}, ref = normRef(b), kind = cleanKind(b.kind);
    if (!ref || !kind) return res.status(400).json({ error: "ref and kind required" });
    if (String(req.query?.action || "") === "share") { const out = await createShare(pool, req, ref, kind); return res.status(out.status).json(out.body); }
    const data = b.data && typeof b.data === "object" ? b.data : {};
    await pool.query(
      `INSERT INTO ocean_doc_overrides(ref_no,doc_kind,data,seal_url,seal_name,updated_by)
       VALUES($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT(ref_no,doc_kind) DO UPDATE SET data=EXCLUDED.data, seal_url=EXCLUDED.seal_url, seal_name=EXCLUDED.seal_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [ref, kind, JSON.stringify(data), b.seal_url || null, b.seal_name || null, req.user.username || "manual"]
    );
    return res.json({ success: true, ref, kind, count: Object.keys(data).length });
  }
  const q = req.query || {}, ref = normRef(q), kind = cleanKind(q.kind);
  if (!ref || !kind) return res.status(400).json({ error: "ref and kind required" });
  if (String(q.action || "") === "share") { if (!req.user) return res.status(401).json({ error: "unauthorized" }); const out = await createShare(pool, req, ref, kind); return res.status(out.status).json(out.body); }
  const data = await loadFeeDoc(pool, ref, kind);
  if (!data) return res.status(404).json({ error: "shipment_not_found", ref });
  if (String(q.format || "") === "json") { res.setHeader("Cache-Control", "no-store"); return res.json(data); }
  if (String(q.format || "") === "xlsx") {
    try {
      const ExcelJS = (await import("exceljs")).default, wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(kind.toUpperCase());
      ws.columns = [{ width: 6 }, { width: 24 }, { width: 28 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 14 }];
      ws.addRow([data.seller?.name]); ws.addRow([data.title_cn + " / " + data.title_en]); ws.addRow([]);
      ws.addRow(["Bill To", data.bill_to?.name, "Doc No.", data.details?.[0]?.value]); ws.addRow(["POL", data.route?.pol, "POD", data.route?.pod]); ws.addRow([]);
      ws.addRow(["NO.", "Item", "Description", "Qty", "Currency", "Unit Price", "Amount"]).font = { bold: true };
      (data.fee_lines || []).forEach((r, i) => ws.addRow([i + 1, r.item, r.desc, r.qty, r.currency, r.unit_price, r.amount]));
      ws.addRow([]); (data.totals?.rows || []).forEach(r => ws.addRow(["", "", "", "", "GRAND TOTAL " + r.currency, "", r.amount]));
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.xlsx"');
      return res.send(Buffer.from(buf));
    } catch (e) { return res.status(500).json({ error: "xlsx_failed", detail: e.message }); }
  }
  const html = renderHtml(data);
  if (String(q.format || "") === "pdf") {
    try { const pdf = await htmlToPdf(scrubCustomerFacingHtml(html)); res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.pdf"'); return res.send(Buffer.from(pdf)); }
    catch (e) { return res.status(503).json({ error: "pdf_render_unavailable", detail: e.message }); }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}
