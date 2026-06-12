// api/db/cn-document.js
// GET /api/db/documents?type=cn&id=<cn_no>&audience=<customer|factory|internal>
// Returns an HTML credit note document.
// audience=customer → English main, no factory info
// audience=factory  → Chinese main, factory items/price
// audience=internal → bilingual, tri-party signatures

import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';
import fs from 'fs';
import path from 'path';

// CN-SEAL-EMBED-2026-05-20: pre-printed issuing-party seals embedded as base64
// so the PDF always carries the official chop without an upload step.
// BABI (厦门巴匕进出口有限公司) seal is the default issuing party.
// Other issuing companies fall back to the dashed placeholder until uploaded.
const SEAL_DIR = path.join(process.cwd(), 'assets', 'seals');
const _sealCache = {};
function sealDataUri(file) {
  if (_sealCache[file] !== undefined) return _sealCache[file];
  try {
    const buf = fs.readFileSync(path.join(SEAL_DIR, file));
    _sealCache[file] = 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) { _sealCache[file] = null; }
  return _sealCache[file];
}
// Map issuing-company name → seal file. Match on EN or CN name fragments.
function sealForSeller(seller) {
  const s = ((seller && (seller.nameEN || '')) + ' ' + (seller && (seller.nameCN || ''))).toUpperCase();
  if (/BABY|巴匕|PET BABY|XIAMEN PET/.test(s)) return sealDataUri('babi-seal.png');
  if (/OCEAN|洋宝/.test(s)) return sealDataUri('shanghai-ocean-baby-seal.png');
  return null; // dashed placeholder
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch { return String(v); }
}

function fmtAmt(v, curr = 'CNY') {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return curr + ' ' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getRaw(cn) {
  if (!cn.raw) return {};
  if (typeof cn.raw === 'string') { try { return JSON.parse(cn.raw); } catch { return {}; } }
  return cn.raw || {};
}

const REASON_LABELS = {
  price_error:   { en: 'Price Error',          zh: '标价错误' },
  quality:       { en: 'Quality Issue',         zh: '质量问题' },
  damage:        { en: 'Cargo Damage',          zh: '货损' },
  qty_short:     { en: 'Quantity Shortage',     zh: '数量短少' },
  freight_over:  { en: 'Freight Overcharge',    zh: '运费多收' },
  goodwill:      { en: 'Goodwill Adjustment',   zh: '客户关系' },
  other:         { en: 'Other',                 zh: '其他' },
};

const STATUS_LABELS = {
  draft:                    'Draft',
  pending_review:           'Pending Review',
  approved:                 'Approved',
  issued_to_customer:       'Issued to Customer',
  signed_by_customer:       'Signed by Customer',
  pending_factory_decision: 'Pending Factory Decision',
  skip_factory_absorb:      'BABI Absorbing',
  sent_to_factory:          'Sent to Factory',
  signed_by_factory:        'Signed by Factory',
  applied:                  'Applied',
  closed:                   'Closed',
  open:                     'Open',
  issued:                   'Issued',
  acknowledged:             'Acknowledged',
};

function buildCnHtml({ cn, raw, seller, audience }) {
  const isCustomer = audience === 'customer';
  const isFactory  = audience === 'factory';
  const isInternal = audience === 'internal';

  // For customer: use cn.items; for factory: use raw.factory_cn.items if available
  const items = isFactory
    ? (raw.factory_cn?.items || cn.items || [])
    : (typeof cn.items === 'string' ? JSON.parse(cn.items || '[]') : (cn.items || []));

  const netAmount = isFactory
    ? (raw.factory_cn?.net_amount || cn.net_amount)
    : cn.net_amount;

  const curr = cn.currency || 'CNY';
  const reasonKey = raw.reason || '';
  const reasonLabel = isFactory
    ? (REASON_LABELS[reasonKey]?.zh || reasonKey || '—')
    : (REASON_LABELS[reasonKey]?.en || reasonKey || '—');

  const recipientName = isFactory
    ? (raw.factory_cn?.recipient_name || '—')
    : esc(cn.company_name || cn.company_code || '—');

  const title = isFactory
    ? '贷记通知书 / CREDIT NOTE (FACTORY)'
    : isInternal
    ? 'CREDIT NOTE (INTERNAL) / 贷记通知书 (内部)'
    : 'CREDIT NOTE / 贷记通知书';

  const sigs = raw.tri_party_signatures || {};
  const statusLabel = STATUS_LABELS[cn.status] || cn.status;

  return `<!DOCTYPE html>
<html lang="${isFactory ? 'zh' : 'en'}">
<head>
<meta charset="UTF-8">
<title>${esc(cn.cn_no)} — Credit Note</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 28px 36px; max-width: 820px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1a73e8; padding-bottom: 16px; margin-bottom: 20px; }
  .seller-block { flex: 1; }
  .seller-name { font-size: 16px; font-weight: 700; color: #1a1a1a; }
  .seller-sub { font-size: 10px; color: #555; margin-top: 2px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 18px; font-weight: 800; color: #c62828; letter-spacing: .04em; }
  .doc-title .cn-no { font-size: 11px; color: #555; margin-top: 4px; }
  .doc-title .status-pill { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #e3f2fd; color: #1565c0; font-size: 10px; font-weight: 700; margin-top: 4px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 18px; padding: 12px 14px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #1a73e8; }
  .meta-row { display: flex; gap: 8px; font-size: 11px; }
  .meta-label { color: #666; min-width: 110px; }
  .meta-value { font-weight: 600; color: #1a1a1a; }
  .section-title { font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .05em; margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e0e0e0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 12px; }
  thead th { background: #1a73e8; color: #fff; padding: 7px 10px; text-align: left; font-weight: 600; }
  tbody tr { border-bottom: 1px solid #f0f0f0; }
  tbody tr:nth-child(even) { background: #fafafa; }
  td { padding: 6px 10px; vertical-align: middle; }
  .text-right { text-align: right; }
  .total-row td { border-top: 2px solid #1a73e8; font-weight: 700; font-size: 13px; padding-top: 10px; }
  .total-credit { color: #c62828; }
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr ${isInternal ? '1fr' : ''}; gap: 20px; margin-top: 28px; }
  .sig-box { border-top: 2px solid #1a1a1a; padding-top: 8px; text-align: center; }
  .sig-title { font-weight: 700; font-size: 11px; color: #333; }
  .sig-sub { font-size: 9px; color: #888; margin-top: 2px; }
  .sig-stamp { width: 80px; height: 80px; border-radius: 50%; border: 3px dashed ${isInternal || isFactory ? '#aaa' : '#e53935'}; margin: 8px auto; display: flex; align-items: center; justify-content: center; font-size: 9px; color: ${isInternal || isFactory ? '#aaa' : '#e53935'}; font-weight: 700; }
  .sig-date { font-size: 10px; color: #555; margin-top: 4px; }
  .footer { margin-top: 20px; border-top: 1px solid #e0e0e0; padding-top: 8px; display: flex; justify-content: space-between; font-size: 9px; color: #888; }
  .reason-box { background: #fff8e1; border-left: 4px solid #ffa000; padding: 8px 12px; border-radius: 4px; margin-bottom: 14px; font-size: 11px; }
  .reason-label { font-weight: 700; color: #e65100; }
  .internal-badge { background: #f3e5f5; color: #6a1b9a; padding: 4px 10px; border-radius: 4px; font-size: 10px; font-weight: 700; display: inline-block; margin-bottom: 12px; }
  .dl-btn { position: fixed; top: 16px; right: 16px; z-index: 50; padding: 9px 16px; border-radius: 8px; border: none; background: #1a73e8; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  @media print { body { padding: 0; } .dl-btn { display: none !important; } }
</style>
</head>
<body>
<button class="dl-btn" onclick="(function(){var u=new URL(window.location.href);u.searchParams.set('format','pdf');window.location.href=u.toString();})()">⬇ 下载 PDF / Download</button>
${isInternal ? '<div class="internal-badge">⚙ INTERNAL COPY — CONFIDENTIAL / 内部用途 — 保密</div>' : ''}
<div class="header">
  <div class="seller-block">
    <div class="seller-name">${esc(seller.nameEN || '')}</div>
    <div class="seller-sub">${esc(seller.address || '')}</div>
  </div>
  <div class="doc-title">
    <h1>${title}</h1>
    <div class="cn-no">${esc(cn.cn_no)}</div>
    <div class="status-pill">${esc(statusLabel)}</div>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-row"><span class="meta-label">${isFactory ? '收件方 Recipient:' : 'Issued To:'}</span><span class="meta-value">${recipientName}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '开单日期 Date:' : 'Issue Date:'}</span><span class="meta-value">${fmtDate(cn.issued_date)}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '参考订单 Order:' : 'Reference Order:'}</span><span class="meta-value">${esc(cn.order_no || '—')}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '合同编号 Contract:' : 'Contract No.:'}</span><span class="meta-value">${esc(cn.contract_no || '—')}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '发票参考 Invoice:' : 'Source Invoice:'}</span><span class="meta-value">${esc(cn.invoice_no || '—')}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '货币 Currency:' : 'Currency:'}</span><span class="meta-value">${esc(curr)}</span></div>
</div>

${reasonKey ? `<div class="reason-box"><span class="reason-label">${isFactory ? '原因 Reason: ' : 'Reason: '}</span>${esc(reasonLabel)}${raw.reason_detail ? ' — ' + esc(raw.reason_detail) : ''}</div>` : ''}

<div class="section-title">${isFactory ? '项目明细 Item Details' : 'Credit Items'}</div>
<table>
  <thead>
    <tr>
      <th>#</th>
      <th>${isFactory ? '品名 Description' : 'Description'}</th>
      <th class="text-right">${isFactory ? '数量 Qty' : 'Qty'}</th>
      <th>${isFactory ? '单位 Unit' : 'Unit'}</th>
      <th class="text-right">${isFactory ? '单价差 Price Diff' : 'Price Diff'}</th>
      <th class="text-right">${isFactory ? '金额 Amount' : 'Amount'}</th>
    </tr>
  </thead>
  <tbody>
    ${items.map((it, i) => {
      // CN-ITEM-FIELD-FIX-2026-05-20: real items[] schema uses `product` / `unit` /
      // `unit_price_diff` (NOT desc / qty_unit / price_diff). Map all aliases so
      // existing + future rows render品名 + 价格 instead of blank "—".
      // Audience-aware product name: customer/internal prefer English (product_en),
      // factory prefers Chinese (product). Fall back to whichever exists.
      var desc = isFactory
        ? (it.product || it.product_en || it.desc || it.product_name || it.name || '—')
        : (it.product_en || it.product || it.desc || it.product_name || it.name || '—');
      var unit = it.unit || it.qty_unit || '—';
      var pdiff = (it.unit_price_diff != null) ? it.unit_price_diff
                : (it.price_diff != null) ? it.price_diff : null;
      var qtyStr = (it.qty != null && it.qty !== '') ? String(it.qty) : '—';
      return `
    <tr>
      <td>${String(i + 1).padStart(2, '0')}</td>
      <td>${esc(desc)}</td>
      <td class="text-right">${esc(qtyStr)}</td>
      <td>${esc(unit)}</td>
      <td class="text-right">${pdiff != null ? curr + ' ' + Number(pdiff).toFixed(2) : '—'}</td>
      <td class="text-right" style="color:#c62828;font-weight:600">${fmtAmt(it.amount, curr)}</td>
    </tr>`;
    }).join('')}
    <tr class="total-row">
      <td colspan="5" class="text-right">${isFactory ? '合计 Total Credit:' : 'Total Credit Amount:'}</td>
      <td class="text-right total-credit">${fmtAmt(netAmount, curr)}</td>
    </tr>
  </tbody>
</table>

${(function(){
  // CN-NOTES-BILINGUAL-2026-05-20: customer版 needs EN + CN. raw.note_en (if present)
  // gives the English; cn.note is the Chinese source. Show both for customer/internal.
  var cnNote = cn.note || '';
  var enNote = (raw && (raw.note_en || raw.noteEn)) || '';
  if (!cnNote && !enNote) return '';
  var body;
  if (isFactory) {
    body = esc(cnNote || enNote);
  } else {
    // customer + internal: English first, Chinese under it
    var parts = [];
    if (enNote) parts.push('<div>' + esc(enNote) + '</div>');
    if (cnNote) parts.push('<div style="margin-top:4px;color:#33691e">' + esc(cnNote) + '</div>');
    body = parts.join('');
  }
  return `<div class="reason-box" style="background:#e8f5e9;border-color:#43a047"><span class="reason-label" style="color:#2e7d32">${isFactory ? '备注 Note: ' : 'Notes / 备注: '}</span>${body}</div>`;
})()}

<div class="sig-grid">
  <div class="sig-box">
    ${(function(){
      // CN-SEAL-EMBED-2026-05-20: pre-printed issuing-party chop. Real PNG when
      // available (BABI / OCEANBABY), else dashed text placeholder.
      var sealImg = sealForSeller(seller);
      if (sealImg) return `<img src="${sealImg}" alt="seal" style="width:90px;height:90px;object-fit:contain;margin:0 auto;display:block" />`;
      return `<div class="sig-stamp">${seller.nameEN?.slice(0, 6) || 'SELLER'}<br>SEAL</div>`;
    })()}
    <div class="sig-title">${isFactory ? '出单方 ISSUING PARTY' : 'ISSUING PARTY'}</div>
    <div class="sig-sub">${esc(seller.nameEN || '')}</div>
    ${sigs.seller_signed_at ? `<div class="sig-date">Signed: ${fmtDate(sigs.seller_signed_at)}</div>` : ''}
  </div>
  <div class="sig-box">
    <div class="sig-stamp" style="border-style:dashed;border-color:#aaa;color:#aaa">${isFactory ? '工厂' : 'RCPT'}<br>SEAL</div>
    <div class="sig-title">${isFactory ? '工厂确认 FACTORY CONFIRMATION' : 'CUSTOMER ACKNOWLEDGEMENT'}</div>
    <div class="sig-sub">${recipientName}</div>
    ${isFactory && sigs.factory_signed_at ? `<div class="sig-date">Signed: ${fmtDate(sigs.factory_signed_at)}</div>` : ''}
    ${!isFactory && sigs.customer_signed_at ? `<div class="sig-date">Signed: ${fmtDate(sigs.customer_signed_at)}</div>` : ''}
  </div>
  ${isInternal ? `
  <div class="sig-box">
    <div class="sig-stamp" style="border-style:dashed;border-color:#aaa;color:#aaa">AUDIT<br>SEAL</div>
    <div class="sig-title">FINANCE AUDIT / 财务审核</div>
    <div class="sig-sub">Internal Use Only</div>
  </div>` : ''}
</div>

<div class="footer">
  <span>${esc(cn.cn_no)} · Issued ${fmtDate(cn.issued_date)} · Source: ${esc(cn.invoice_no || cn.order_no || '—')}</span>
  <span>Generated by Sanlyn OS · ${new Date().toISOString().slice(0,10)}</span>
</div>
</body>
</html>`;
}

export async function generateCnDocument(pool, req, res, id, audience) {
  const aud = audience || 'customer';

  const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [id]);
  if (!r.rows.length) return res.status(404).send('<h1>Credit Note not found: ' + esc(id) + '</h1>');
  const cn = r.rows[0];
  const raw = getRaw(cn);

  // Fail-closed: customer can only see their own CN, factory version forbidden
  if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
    if (aud === 'factory' || aud === 'internal') {
      return res.status(403).send('<h1>Forbidden: insufficient role for this audience</h1>');
    }
    const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : []);
    if (!codes.includes(cn.company_code)) return res.status(403).send('<h1>Forbidden</h1>');
  }

  // Load seller profile
  let seller = { nameEN: 'Sanlyn International Co., Ltd.', nameCN: '三林国际', address: '', tel: '', email: '' };
  try {
    const sp = await pool.query('SELECT * FROM seller_profiles WHERE is_default=TRUE LIMIT 1');
    if (sp.rows.length) {
      const s = sp.rows[0];
      seller = {
        nameEN: s.name_en || seller.nameEN,
        nameCN: s.name_cn || '',
        address: s.address || '',
        tel: s.tel || '',
        email: s.email || '',
      };
    }
  } catch (e) { /* use default */ }

  const html = buildCnHtml({ cn, raw, seller, audience: aud });

  // CN-PDF-DOWNLOAD-2026-05-20: format=pdf → puppeteer renders真·PDF 文件下载
  // (system Chrome /usr/bin/google-chrome). Same pattern as documents.js.
  if ((req.query.format || '') === 'pdf') {
    try {
      const puppeteer = (await import('puppeteer')).default;
      const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
      const launchOpts = {
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer'],
      };
      try { const fsm = await import('fs'); if (fsm.existsSync(chromePath)) launchOpts.executablePath = chromePath; } catch (_) {}
      const browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
      await browser.close();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + esc(cn.cn_no || 'credit-note') + '.pdf"');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(Buffer.from(pdfBuf));
    } catch (pdfErr) {
      console.error('[cn-document] puppeteer PDF error:', pdfErr.message);
      res.setHeader('Content-Type', 'application/json');
      return res.status(503).json({ error: 'pdf_render_unavailable', detail: pdfErr.message });
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}
