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
const obj = v => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return {}; } };
const fmtD = v => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); };
const num = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const money = v => v === "" || v == null ? "" : Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const normRef = b => String(b.ref || b.id || b.contract_no || b.order_no || "").trim();
const cleanKind = k => !k || String(k).toLowerCase() === "cpo" ? "cpo" : "";

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

async function loadOrder(pool, ref) {
  const r = await pool.query("SELECT * FROM orders WHERE id::text=$1 OR _id=$1 OR contract_no=$1 OR customer_po=$1 OR order_no=$1 LIMIT 1", [ref]);
  return r.rows[0] || null;
}

async function loadSupplier(pool, o, raw) {
  const name0 = pick(o.factory, raw.factoryName, raw.supplier, raw.vendor, raw.factory);
  const out = { name: name0, tax_no: pick(raw.factoryTaxNo, raw.vendorTaxNo), address: "", bank: pick(raw.factoryBank), account: pick(raw.factoryAccount) };
  const orderNoFac = String(o.order_no || "").split("-")[1] || "";
  const fcode = pick(o.factory_code, raw.factory_code, raw.factoryCode);
  try {
    let r = orderNoFac ? await pool.query("SELECT * FROM factories WHERE po_prefix=$1 LIMIT 1", [orderNoFac]) : { rows: [] };
    if (!r.rows.length && fcode) r = await pool.query("SELECT * FROM factories WHERE company_code=$1 OR po_prefix=$1 LIMIT 1", [fcode]);
    if (!r.rows.length && name0) r = await pool.query("SELECT * FROM factories WHERE name=$1 OR name LIKE $2 LIMIT 1", [name0, "%" + name0.replace(/股份|有限公司|进出口/g, "").slice(0, 6) + "%"]);
    const f = r.rows[0];
    if (f) Object.assign(out, { name: pick(f.name, out.name), tax_no: pick(out.tax_no, f.tax_no), address: f.address || "", bank: pick(out.bank, f.bank_name), account: pick(out.account, f.bank_account), code: pick(f.company_code, f.po_prefix, fcode) });
  } catch {}
  try {
    if (!out.tax_no && out.name) {
      const c = await pool.query("SELECT name_cn,tax_id,address,bank_name,bank_account FROM companies WHERE name_cn=$1 OR name_en=$1 LIMIT 1", [out.name]);
      const x = c.rows[0];
      if (x) Object.assign(out, { name: pick(x.name_cn, out.name), tax_no: x.tax_id || "", address: pick(out.address, x.address), bank: pick(out.bank, x.bank_name), account: pick(out.account, x.bank_account) });
    }
  } catch {}
  return out;
}

async function loadLines(pool, o) {
  let rows = [];
  try {
    const r = await pool.query(`SELECT li.*, p.barcode AS p_barcode, p.product_name AS p_name
      FROM order_line_items li LEFT JOIN products p ON p.id=li.product_id OR (li.product_id IS NULL AND p.sku=li.sku)
      WHERE li.order_id=$1 ORDER BY li.sort_order, li.id`, [o.id || o._id]);
    rows = r.rows;
  } catch {}
  if (!rows.length) rows = (obj(o.raw).products || obj(o.raw).items || []).map(p => ({ raw: p, sku: p.sku, barcode: p.barcode, product_name: p.productName || p.name, declaration_name_en: p.declarationNameEn || p.declaration_name_en, size: p.size || p.spec, qty_ctn: p.qty, unit: p.unit || "CTN", factory_price: "", factory_subtotal: "" }));
  return rows.map((r, i) => {
    const raw = obj(r.raw), q = pick(r.qty_ctn, r.qty, raw.qty), up = r.factory_price == null || r.factory_price === "" ? "" : num(r.factory_price);
    const amt = r.factory_subtotal == null || r.factory_subtotal === "" ? (up === "" || !q ? "" : num(q) * num(up)) : num(r.factory_subtotal);
    return { no: String(i + 1).padStart(2, "0"), sku: pick(r.sku, raw.sku), barcode: pick(r.barcode, r.p_barcode, raw.barcode), name: pick(r.declaration_name_en, raw.declaration_name_en, raw.declarationNameEn), product_name: pick(r.product_name, r.p_name, raw.productName, raw.name), spec: pick(r.size, raw.size, raw.spec), qty: q, unit: pick(r.unit, raw.unit, "CTN"), unit_price: up, amount: amt };
  });
}

function totals(lines) {
  const amount = (lines || []).reduce((s, r) => r.amount === "" || r.amount == null ? s : s + num(r.amount), 0);
  const qty = (lines || []).reduce((s, r) => s + num(r.qty), 0);
  return { currency: "CNY", qty, amount: Number(amount.toFixed(2)), missing_amount: (lines || []).some(r => r.amount === "" || r.amount == null) };
}

async function loadCpo(pool, ref) {
  const o = await loadOrder(pool, ref); if (!o) return null;
  const raw = obj(o.raw), code = pick(o.seller_code, raw.sellerCode, raw.seller_code);
  const cfg = await loadSellerCfg(pool, raw, code, {});
  const supplier = await loadSupplier(pool, o, raw), lines = await loadLines(pool, o);
  const docNo = pick(raw.fs_no, raw.internal_no, o.order_no, o.contract_no, ref) + "-CPO";
  const base = { kind: "cpo", ref_no: ref, title_cn: "采购确认单 / 采购合同", title_en: "PURCHASE CONFIRMATION ORDER", seller_code: code || raw.issuingCompany || raw.issuingCompanyEN || "",
    issuer: { name: pick(cfg.nameCN, cfg.nameEN, o.issuing_company), name_en: pick(cfg.nameEN, o.issuing_company_en), address: cfg.address || "", tel: cfg.tel || "", email: cfg.email || "", tax_no: cfg.taxNo || "", bank: pick(cfg.bank?.bankNameCN, cfg.bank?.bankName), account: cfg.bank?.rmbAccount || "" },
    supplier, details: [{ label: "PO No.", value: pick(o.order_no, raw.customerPO) }, { label: "Contract No.", value: pick(o.contract_no, o.order_no) }, { label: "Issue Date", value: fmtD(new Date()) }, { label: "Order Date", value: fmtD(pick(o.order_date, o.created_at)) }, { label: "Delivery Date", value: fmtD(pick(o.delivery_date, raw.deliveryDate, raw.expectedDelivery)) }],
    product_lines: lines, totals: totals(lines), terms: (cfg.termsPO || []).map(t => ({ heading: t.heading || "", body: String(t.body || "").split("\n")[0] })).filter(t => t.heading || t.body),
    signatures: { left: "BUYER / PURCHASER", right: "SUPPLIER / VENDOR" }, seal_url: "", seal_name: "", supplier_seal_url: "", supplier_seal_name: "", has_override: false };
  let over = {}, sealUrl = "", sealName = "";
  try { const r = await pool.query("SELECT data,seal_url,seal_name FROM ocean_doc_overrides WHERE ref_no=$1 AND doc_kind='cpo' LIMIT 1", [ref]); if (r.rows[0]) { over = obj(r.rows[0].data); sealUrl = r.rows[0].seal_url || ""; sealName = r.rows[0].seal_name || ""; } } catch {}
  let defaultSeal = cfg.seal_url || "";
  try { const sr = await pool.query("SELECT url,name FROM customer_stamps WHERE company_code=$1 AND COALESCE(is_default,false) AND COALESCE(is_active,true) ORDER BY id DESC LIMIT 1", [base.seller_code]); defaultSeal = pick(defaultSeal, sr.rows[0]?.url); if (!sealName && defaultSeal === sr.rows[0]?.url) sealName = sr.rows[0]?.name || ""; } catch {}
  const out = overlay(base, over);
  out.totals = totals(out.product_lines || []);
  out.seal_url = pick(sealUrl, cfg.seal_url, out.seal_url, defaultSeal);
  out.seal_name = sealName || out.seal_name || "";
  out.has_override = Object.keys(over).length > 0 || !!sealUrl;
  return out;
}

function renderHtml(d) {
  const red = v => pick(v) ? esc(v) : '<span class="miss">待填/缺</span>';
  const m = v => v === "" || v == null ? '<span class="miss">待填/缺</span>' : money(v);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(d.title_en)} ${esc(d.ref_no)}</title><style>
*{box-sizing:border-box}body{margin:0;padding:30px 18px;background:#eef0f3;color:#111;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}.doc{max-width:880px;margin:auto;background:#fff;border:1px solid #e2e8f0;box-shadow:0 4px 18px rgba(0,0,0,.12)}.hdr{padding:22px 26px;border-bottom:2px solid #111;display:flex;justify-content:space-between;gap:24px}.hdr h1{margin:0;font-size:20px}.muted,.k{color:#555;font-size:11px}.big{font-size:16px;font-weight:800}.meta{padding:16px 26px;display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}.v,td{font-family:Menlo,Consolas,monospace}.v{font-weight:700}.sec{padding:18px 26px;border-top:1px solid #e2e5e9}.ttl{font-size:11px;color:#1d4ed8;font-weight:800;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#111;color:#fff;text-align:left;font-size:10px}td,th{padding:8px;border-bottom:1px solid #e2e5e9}.r{text-align:right}.c{text-align:center}.miss{color:#dc2626;font-weight:800}tfoot td{background:#111;color:#fff;font-weight:900}.terms{padding:14px 26px;border-top:1px solid #e2e5e9}.sig{padding:28px 26px;display:grid;grid-template-columns:1fr 1fr;gap:60px;border-top:1px solid #e2e5e9;position:relative;min-height:125px}.sig div{border-top:1px solid #111;text-align:center;padding-top:7px;font-size:10px;color:#555}.seal{position:absolute;left:145px;top:6px;width:100px;height:100px;object-fit:contain}.sseal{left:auto;right:145px}.foot{padding:10px 26px;text-align:center;color:#9aa1a9;font-size:10px;border-top:1px dashed #ccc}@media print{body{background:#fff;padding:0}.doc{box-shadow:none;border:none}th,tfoot td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div class="doc">
<div class="hdr"><div><h1>${esc(d.title_cn)}<br>${esc(d.title_en)}</h1><div class="muted"><b>${red(d.issuer?.name)}</b><br>${red(d.issuer?.address)}<br>Tel: ${red(d.issuer?.tel)} · Email: ${red(d.issuer?.email)}</div></div><div class="muted" style="text-align:right"><div class="big">${red(d.details?.[0]?.value)}</div><div>Issue date: ${red(d.details?.[2]?.value)}</div></div></div>
<div class="meta"><div class="k">BUYER 买方（采购主体）</div><div class="k">SUPPLIER 卖方（工厂）</div><div class="v">${red(d.issuer?.name)}<br>税号: ${red(d.issuer?.tax_no)}<br>开户行: ${red(d.issuer?.bank)}<br>账号: ${red(d.issuer?.account)}</div><div class="v">${red(d.supplier?.name)}<br>税号: ${red(d.supplier?.tax_no)}<br>开户行: ${red(d.supplier?.bank)}<br>账号: ${red(d.supplier?.account)}</div><div class="k">DETAILS 单据详情</div><div class="v">Contract: ${red(d.details?.[1]?.value)}<br>Order Date: ${red(d.details?.[3]?.value)}<br>Delivery: ${red(d.details?.[4]?.value)}</div></div>
<div class="sec"><div class="ttl">PRODUCT DETAILS / 产品明细</div><table><thead><tr><th style="width:38px">No.</th><th style="width:105px">Barcode</th><th>Description</th><th>Spec</th><th class="c">Qty</th><th class="c">Unit</th><th class="r">Unit Price</th><th class="r">Amount</th></tr></thead><tbody>${(d.product_lines||[]).map((r,i)=>`<tr><td class="c">${esc(r.no||String(i+1).padStart(2,"0"))}</td><td>${red(r.barcode)}</td><td>${red(r.name)}</td><td>${red(r.spec)}</td><td class="c">${red(r.qty)}</td><td class="c">${red(r.unit)}</td><td class="r">${m(r.unit_price)}</td><td class="r">${m(r.amount)}</td></tr>`).join("") || `<tr><td colspan="8" class="c"><span class="miss">待填/缺</span></td></tr>`}</tbody><tfoot><tr><td colspan="4" class="r">GRAND TOTAL</td><td class="c">${money(d.totals?.qty)}</td><td></td><td></td><td class="r">${d.totals?.missing_amount?'<span class="miss">待填/缺</span>':'CNY '+money(d.totals?.amount)}</td></tr></tfoot></table></div>
<div class="terms"><b style="color:#1d4ed8">TERMS / 条款</b>${(d.terms||[]).map(t=>`<div style="margin-top:6px"><b>${red(t.heading)}</b><br>${red(t.body)}</div>`).join("") || `<div class="miss">待填/缺</div>`}</div>
<div class="sig">${d.seal_url?`<img class="seal" src="${esc(d.seal_url)}" alt="buyer seal">`:""}${d.supplier_seal_url?`<img class="seal sseal" src="${esc(d.supplier_seal_url)}" alt="supplier seal">`:""}<div><b>${esc(d.signatures?.left||"BUYER")}</b>(签字 / 盖章)</div><div><b>${esc(d.signatures?.right||"SUPPLIER")}</b>(签字 / 盖章)</div></div><div class="foot">Generated &amp; Verified by Sanlyn OS</div></div></body></html>`;
}

function sharePassword() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; const seg = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); return seg(3) + "-" + seg(3) + "-" + seg(3); }
async function createShare(pool, req, ref) {
  const data = await loadCpo(pool, ref); if (!data) return { status: 404, body: { error: "order_not_found", ref } };
  let pdf; try { pdf = await htmlToPdf(scrubCustomerFacingHtml(renderHtml(data))); } catch (e) { return { status: 500, body: { error: "PDF render failed: " + e.message } }; }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const fname = String(ref).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) + "_cpo_" + randomBytes(6).toString("hex") + ".pdf";
  writeFileSync(path.join(UPLOADS_DIR, fname), pdf);
  const token = randomBytes(6).toString("hex"), password = sharePassword(), by = (req.user && (req.user.username || req.user.name)) || "admin";
  await pool.query(`INSERT INTO doc_share_links(token,contract_no,doc_key,doc_url,doc_name,password,created_by,expires_at,max_downloads,download_count,downloaded_log)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '7 days',50,0,$8::jsonb)`, [token, ref, "cpo:cpo:" + ref, SHARE_BASE + "/uploads/ocean/" + encodeURIComponent(fname), data.title_en + " " + ref, password, by, JSON.stringify([{ action: "created", by, doc: "cpo:cpo:" + ref, ts: new Date().toISOString() }])]);
  const shareUrl = SHARE_BASE + "/api/db/doc-share?token=" + token;
  return { status: 200, body: { ok: true, quickUrl: shareUrl + "&password=" + encodeURIComponent(password), shareUrl, password, expiresInDays: 7 } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS"); if (req.method === "OPTIONS") return res.status(204).end();
  const pool = getPool();
  if (req.method === "POST") {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {}, ref = normRef(b), kind = cleanKind(b.kind);
    if (!ref || !kind) return res.status(400).json({ error: "ref and kind=cpo required" });
    if (String(req.query?.action || "") === "share") { const out = await createShare(pool, req, ref); return res.status(out.status).json(out.body); }
    const data = b.data && typeof b.data === "object" ? b.data : {};
    await pool.query(`INSERT INTO ocean_doc_overrides(ref_no,doc_kind,data,seal_url,seal_name,updated_by) VALUES($1,'cpo',$2::jsonb,$3,$4,$5)
      ON CONFLICT(ref_no,doc_kind) DO UPDATE SET data=EXCLUDED.data, seal_url=EXCLUDED.seal_url, seal_name=EXCLUDED.seal_name, updated_by=EXCLUDED.updated_by, updated_at=now()`, [ref, JSON.stringify(data), b.seal_url || null, b.seal_name || null, req.user.username || "manual"]);
    return res.json({ success: true, ref, kind: "cpo", count: Object.keys(data).length });
  }
  const q = req.query || {}, ref = normRef(q), kind = cleanKind(q.kind);
  if (!ref || !kind) return res.status(400).json({ error: "ref and kind=cpo required" });
  if (String(q.action || "") === "share") { if (!req.user) return res.status(401).json({ error: "unauthorized" }); const out = await createShare(pool, req, ref); return res.status(out.status).json(out.body); }
  const data = await loadCpo(pool, ref); if (!data) return res.status(404).json({ error: "order_not_found", ref });
  if (String(q.format || "") === "json") { res.setHeader("Cache-Control", "no-store"); return res.json(data); }
  if (String(q.format || "") === "xlsx") {
    try { const ExcelJS = (await import("exceljs")).default, wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("CPO"); ws.columns = [{ width: 6 }, { width: 18 }, { width: 34 }, { width: 18 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 14 }];
      ws.addRow([data.issuer?.name]); ws.addRow([data.title_cn + " / " + data.title_en]); ws.addRow(["Supplier", data.supplier?.name, "Doc No.", data.details?.[0]?.value]); ws.addRow([]);
      ws.addRow(["NO.", "Barcode", "Description", "Spec", "Qty", "Unit", "Unit Price", "Amount"]).font = { bold: true };
      (data.product_lines || []).forEach((r, i) => ws.addRow([i + 1, r.barcode, r.name, r.spec, r.qty, r.unit, r.unit_price, r.amount])); ws.addRow(["", "", "", "GRAND TOTAL", data.totals?.qty, "", "", data.totals?.amount]);
      const buf = await wb.xlsx.writeBuffer(); res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.xlsx"'); return res.send(Buffer.from(buf));
    } catch (e) { return res.status(500).json({ error: "xlsx_failed", detail: e.message }); }
  }
  const html = renderHtml(data);
  if (String(q.format || "") === "pdf") {
    try { const pdf = await htmlToPdf(scrubCustomerFacingHtml(html)); res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(data.title_en + "_" + ref) + '.pdf"'); return res.send(Buffer.from(pdf)); }
    catch (e) { return res.status(503).json({ error: "pdf_render_unavailable", detail: e.message }); }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.send(html);
}
