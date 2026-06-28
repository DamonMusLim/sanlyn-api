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

function buildCnHtml({ cn, raw, seller, audience, recipientAddr }) {
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

  // 编号铁律(sanlyn_id_hierarchy_rule): 工厂合同号(CP开头)对客户 hidden；
  // 客户版只显非 CP 的号(如 FS 内部号，客户可见)。工厂/内部版照显。
  const contractVisible = (isFactory || isInternal)
    ? (cn.contract_no || '')
    : (cn.contract_no && !/^CP/i.test(String(cn.contract_no).trim()) ? cn.contract_no : '');

  return `<!DOCTYPE html>
<html lang="${isFactory ? 'zh' : 'en'}">
<head>
<meta charset="UTF-8">
<title>${esc(cn.cn_no)} — Credit Note</title>
<style>
  /* ── 版式 1:1 照搬 documents.js type=pi/iv（灰白版），勿改观感；数据逻辑不动 ── */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system,'Helvetica Neue','Helvetica','Arial','PingFang SC','Microsoft YaHei',sans-serif; font-size: 11px; line-height: 1.4; color: #111; background: #f0f2f5; padding: 28px 0; }
  .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 24px 28px; box-shadow: 0 4px 20px rgba(0,0,0,.12); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
  .seller-block { flex: 1; min-width: 0; }
  .seller-name { font-size: 14px; font-weight: 700; color: #111; letter-spacing: .01em; text-transform: uppercase; }
  .seller-sub { font-size: 10px; color: #555; margin-top: 3px; line-height: 1.5; }
  .doc-title { text-align: right; flex-shrink: 0; margin-left: 24px; }
  .doc-title h1 { font-size: 18px; font-weight: 800; color: #111; letter-spacing: .05em; line-height: 1.1; }
  .doc-title .cn-no { font-size: 10px; color: #777; margin-top: 4px; font-family: 'SF Mono',Menlo,monospace; }
  .doc-title .status-pill { display: inline-block; padding: 2px 9px; border-radius: 3px; background: #f0f0f0; color: #555; border: 1px solid #ddd; font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-top: 5px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 28px; margin-bottom: 16px; padding: 10px 12px; background: #fafafa; border: 1px solid #eee; }
  .meta-row { display: flex; gap: 8px; font-size: 10.5px; }
  .meta-label { color: #777; min-width: 120px; }
  .meta-value { font-weight: 600; color: #111; }
  .section-title { font-size: 9px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: .12em; margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-bottom: 12px; }
  thead th { background: #f5f5f5; border-top: 1.5px solid #111; border-bottom: 1px solid #111; color: #333; padding: 7px 8px; text-align: left; font-weight: 700; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
  tbody td { padding: 8px; border-bottom: 1px solid #ececec; color: #222; vertical-align: middle; }
  .text-right { text-align: right; font-family: 'SF Mono',Menlo,monospace; }
  .total-row td { border-top: 1.5px solid #111; border-bottom: 1.5px solid #111; font-weight: 800; font-size: 11px; background: #fafafa; padding-top: 9px; }
  .total-credit { color: #111; }
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr ${isInternal ? '1fr' : ''}; gap: 24px; margin-top: 32px; }
  .sig-box { border-top: 1px solid #111; padding-top: 8px; text-align: center; }
  .sig-title { font-weight: 700; font-size: 9px; color: #444; letter-spacing: .08em; text-transform: uppercase; }
  .sig-sub { font-size: 8.5px; color: #888; margin-top: 3px; }
  .sig-stamp { width: 78px; height: 78px; border-radius: 50%; border: 1px dashed #ccc; margin: 8px auto; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #bbb; font-weight: 700; text-align: center; line-height: 1.3; }
  .sig-date { font-size: 9px; color: #888; margin-top: 4px; }
  .seal-area { margin-top: 40px; min-height: 130px; position: relative; }
  .seal-img { width: 124px; height: 124px; object-fit: contain; position: absolute; left: 56px; top: 0; transform: rotate(-7deg); }
  .reason-box { background: #fafafa; border-left: 3px solid #999; padding: 8px 12px; margin-bottom: 14px; font-size: 10.5px; color: #333; }
  .reason-label { font-weight: 700; color: #555; }
  .internal-badge { background: #f0f0f0; color: #555; border: 1px solid #ddd; padding: 4px 10px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: .04em; display: inline-block; margin-bottom: 12px; }
  .dl-btn { position: fixed; top: 16px; right: 16px; z-index: 50; padding: 9px 16px; border-radius: 6px; border: none; background: #333; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  @media print { body { background: #fff; padding: 0; } .container { max-width: 100%; box-shadow: none; padding: 0; } .dl-btn { display: none !important; } }
</style>
</head>
<body>
<button class="dl-btn" onclick="(function(){var u=new URL(window.location.href);u.searchParams.set('format','pdf');window.location.href=u.toString();})()">⬇ 下载 PDF / Download</button>
<div class="container">
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
  ${!isFactory && recipientAddr ? `<div class="meta-row" style="grid-column:1/-1"><span class="meta-label">Address:</span><span class="meta-value" style="font-weight:400;color:#444">${esc(recipientAddr)}</span></div>` : ''}
  <div class="meta-row"><span class="meta-label">${isFactory ? '开单日期 Date:' : 'Issue Date:'}</span><span class="meta-value">${fmtDate(cn.issued_date)}</span></div>
  <div class="meta-row"><span class="meta-label">${isFactory ? '参考订单 Order:' : 'Reference Order:'}</span><span class="meta-value">${esc(cn.order_no || '—')}</span></div>
  ${contractVisible ? `<div class="meta-row"><span class="meta-label">${isFactory ? '合同编号 Contract:' : 'Contract No.:'}</span><span class="meta-value">${esc(contractVisible)}</span></div>` : ''}
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
      // 逐项说明: 价格变动/赠品原因等(it.note)，真实存于 items[]，放在品名下一行灰字
      var lineNote = it.note || it.remark || '';
      return `
    <tr>
      <td>${String(i + 1).padStart(2, '0')}</td>
      <td>${esc(desc)}${lineNote ? `<div style="font-size:9.5px;color:#888;margin-top:2px;font-weight:400">${esc(lineNote)}</div>` : ''}</td>
      <td class="text-right">${esc(qtyStr)}</td>
      <td>${esc(unit)}</td>
      <td class="text-right">${pdiff != null ? curr + ' ' + Number(pdiff).toFixed(2) : '—'}</td>
      <td class="text-right" style="font-weight:600">${fmtAmt(it.amount, curr)}</td>
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
    if (cnNote) parts.push('<div style="margin-top:4px;color:#555">' + esc(cnNote) + '</div>');
    body = parts.join('');
  }
  return `<div class="reason-box" style="border-left-color:#bbb"><span class="reason-label">${isFactory ? '备注 Note: ' : 'Notes / 备注: '}</span>${body}</div>`;
})()}

${(function(){
  // 出单方实体红章（已预埋 base64），自然放置带轻微角度（Damon: 圈/字/底部文字都去掉，盖章可随机）。
  var sealImg = sealForSeller(seller);
  if (!sealImg) return '';
  return `<div class="seal-area"><img src="${sealImg}" alt="seal" class="seal-img" /></div>`;
})()}
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

  // 收件方（客户）公司地址：按 company_code 查 companies 主表，缺则留空（绝不编造）
  let recipientAddr = '';
  try {
    if (cn.company_code) {
      const cr = await pool.query('SELECT address FROM companies WHERE code=$1 LIMIT 1', [cn.company_code]);
      if (cr.rows.length) recipientAddr = cr.rows[0].address || '';
    }
  } catch (e) { /* leave blank */ }

  const html = buildCnHtml({ cn, raw, seller, audience: aud, recipientAddr });

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
