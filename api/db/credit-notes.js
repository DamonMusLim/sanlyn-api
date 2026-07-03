// api/db/credit-notes.js — Full Credit Note module (v2)
// 9 endpoints:
//   GET    /api/db/credit-notes                     — list (filter status/customer/date/order)
//   GET    /api/db/credit-notes?cn_no=CN-xxx        — single by cn_no
//   POST   /api/db/credit-notes                     — create (draft)
//   PATCH  /api/db/credit-notes?cn_no=CN-xxx        — edit raw fields
//   POST   /api/db/credit-notes?action=transition   — state machine
//   POST   /api/db/credit-notes?action=attachments  — multipart upload
//   DELETE /api/db/credit-notes?action=del_attach   — remove attachment
//   POST   /api/db/credit-notes?action=apply        — apply CN against invoice/payment
//   GET    /api/db/credit-notes?action=factory      — factory version data
//   GET    /api/db/credit-notes?action=credits_summary&company_code=CN-xxx — outstanding total

import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';
import { createWriteStream, mkdirSync, unlinkSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { IncomingForm } from 'formidable';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import { renderCreditNote } from './credit-note-doc.js';
import { scrubCustomerFacingHtml } from './doc-data.js';
import { htmlToPdf } from './_html-to-pdf.js';

const UPLOADS_DIR = '/opt/sanlyn-uploads/cn';
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || '';
const BASE_URL = process.env.APP_BASE_URL || 'https://ai.sanlyn.cn';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 10;

// 8-state machine transitions
const VALID_TRANSITIONS = {
  draft:                    ['pending_review'],
  pending_review:           ['approved', 'draft'],
  approved:                 ['issued_to_customer'],
  issued_to_customer:       ['signed_by_customer'],
  signed_by_customer:       ['pending_factory_decision'],
  pending_factory_decision: ['skip_factory_absorb', 'sent_to_factory'],
  sent_to_factory:          ['signed_by_factory'],
  signed_by_factory:        ['applied'],
  skip_factory_absorb:      ['applied'],
  applied:                  ['closed'],
  // legacy statuses kept for backward compat
  open:                     ['pending_review'],
  issued:                   ['signed_by_customer'],
  acknowledged:             ['pending_factory_decision'],
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

async function pingWecom(msg) {
  if (!WECOM_WEBHOOK) return;
  try {
    await fetch(WECOM_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: msg } }),
    });
  } catch (e) { /* non-blocking */ }
}

function getRaw(cn) {
  if (!cn.raw) return {};
  if (typeof cn.raw === 'string') {
    try { return JSON.parse(cn.raw); } catch { return {}; }
  }
  return cn.raw || {};
}

function calcOutstanding(cn) {
  const raw = getRaw(cn);
  const total = Math.abs(parseFloat(cn.net_amount) || 0);
  const applied = (raw.applied_to || []).reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  return Math.max(0, total - applied);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const { cn_no, action, company_code: qCompany, order_no: qOrder, status: qStatus, limit = 50, offset = 0 } = req.query;

  // ── GET ──────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // Credits summary for a customer
    if (action === 'credits_summary') {
      const code = qCompany || req.user?.companyCode;
      if (!code) return res.status(400).json({ error: 'company_code required' });
      // Fail-closed: non-admin can only see own
      if (req.user?.role !== 'admin' && req.user?.companyCode !== code) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const r = await pool.query(
        `SELECT cn_no, net_amount, status, raw FROM credit_notes WHERE company_code=$1 AND status NOT IN ('closed','draft')`,
        [code]
      );
      const openCNs = r.rows.filter(cn => !['closed','applied'].includes(cn.status));
      const totalOutstanding = r.rows.reduce((s, cn) => {
        if (['closed'].includes(cn.status)) return s;
        return s + calcOutstanding(cn);
      }, 0);
      return res.json({
        success: true,
        data: {
          company_code: code,
          open_count: openCNs.length,
          total_outstanding: totalOutstanding,
          cns: r.rows.map(cn => ({
            cn_no: cn.cn_no,
            net_amount: cn.net_amount,
            outstanding: calcOutstanding(cn),
            status: cn.status,
          })),
        },
      });
    }

    // Factory version data
    if (action === 'factory' && cn_no) {
      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [cn_no]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const cn = r.rows[0];
      const raw = getRaw(cn);
      // Only admin or supplier with matching factory can see factory version
      if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // Return factory-safe version: replace items with factory_cn items if available
      const factoryCn = raw.factory_cn || {};
      return res.json({
        success: true,
        data: {
          cn_no: cn.cn_no,
          issued_date: cn.issued_date,
          currency: cn.currency,
          status: cn.status,
          note: cn.note,
          factory_recipient: factoryCn.recipient_name || null,
          factory_recipient_code: factoryCn.recipient_code || null,
          items: factoryCn.items || cn.items || [],
          net_amount: factoryCn.net_amount || cn.net_amount,
          reason: raw.reason,
          reason_detail: raw.reason_detail,
          attachments: raw.attachments || [],
        },
      });
    }

    // Single by cn_no
    if (cn_no) {
      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [cn_no]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const cn = r.rows[0];
      // Fail-closed: customer role only sees own CNs, and factory_cn field is stripped
      if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
        const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : []);
        if (!codes.includes(cn.company_code)) return res.status(403).json({ error: 'Forbidden' });
        // Strip factory info from customer response
        const raw = getRaw(cn);
        delete raw.factory_cn;
        delete raw.factory_decision;
        return res.json({ success: true, data: { ...cn, raw, outstanding: calcOutstanding(cn) } });
      }
      return res.json({ success: true, data: { ...cn, outstanding: calcOutstanding(cn) } });
    }

    // List
    let where = [];
    let params = [];
    let idx = 1;

    // Scope enforcement
    if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
      const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
      if (!codes?.length) return res.status(403).json({ error: 'Scope missing' });
      const ph = codes.map(() => '$' + idx++).join(',');
      codes.forEach(c => params.push(c));
      where.push(`company_code IN (${ph})`);
    } else {
      if (qCompany) { where.push(`company_code = $${idx++}`); params.push(qCompany); }
    }

    if (qOrder)   { where.push(`order_no ILIKE $${idx++}`); params.push(`%${qOrder}%`); }
    if (qStatus)  { where.push(`status = $${idx++}`);       params.push(qStatus); }

    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const r = await pool.query(
      `SELECT *, CASE WHEN raw IS NOT NULL THEN raw ELSE '{}'::jsonb END as raw FROM credit_notes${w} ORDER BY issued_date DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    return res.json({
      success: true,
      data: r.rows.map(cn => ({ ...cn, outstanding: calcOutstanding(cn) })),
      count: r.rows.length,
    });
  }

  // ── POST ──────────────────────────────────────────────────────
  if (req.method === 'POST') {

    // State machine transition
    if (action === 'transition') {
      const { cn_no: bodyCn, to_status, note: transNote, factory_decision, factory_cn: factoryCnData } = req.body;
      const targetCn = bodyCn || cn_no;
      if (!targetCn) return res.status(400).json({ error: 'cn_no required' });
      if (!to_status) return res.status(400).json({ error: 'to_status required' });

      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [targetCn]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const cn = r.rows[0];

      const allowed = VALID_TRANSITIONS[cn.status] || [];
      if (!allowed.includes(to_status)) {
        return res.status(422).json({
          error: `Invalid transition: ${cn.status} → ${to_status}`,
          allowed_next: allowed,
        });
      }

      // Build raw update
      const raw = getRaw(cn);
      const log = raw.transition_log || [];
      log.push({
        from: cn.status,
        to: to_status,
        by: req.user?.username || 'system',
        at: new Date().toISOString(),
        note: transNote || null,
      });
      raw.transition_log = log;

      if (factory_decision) raw.factory_decision = factory_decision;
      if (factoryCnData)    raw.factory_cn = factoryCnData;
      if (to_status === 'signed_by_customer') {
        const sig = raw.tri_party_signatures || {};
        sig.customer_signed_at = new Date().toISOString();
        raw.tri_party_signatures = sig;
      }
      if (to_status === 'signed_by_factory') {
        const sig = raw.tri_party_signatures || {};
        sig.factory_signed_at = new Date().toISOString();
        raw.tri_party_signatures = sig;
      }
      if (to_status === 'approved') {
        const sig = raw.tri_party_signatures || {};
        sig.seller_signed_at = new Date().toISOString();
        raw.tri_party_signatures = sig;
      }

      const updated = await pool.query(
        `UPDATE credit_notes SET status=$1, raw=raw || $2::jsonb, updated_at=NOW() WHERE cn_no=$3 RETURNING *`,
        [to_status, JSON.stringify(raw), targetCn]
      );

      // WeCom notify for key transitions
      const notify = ['approved','issued_to_customer','sent_to_factory','signed_by_factory','applied'];
      if (notify.includes(to_status)) {
        const labelFrom = STATUS_LABELS[cn.status] || cn.status;
        const labelTo   = STATUS_LABELS[to_status] || to_status;
        pingWecom([
          `## 📝 Credit Note Status Update`,
          `**CN:** ${targetCn}`,
          `**From:** ${labelFrom} → **To:** ${labelTo}`,
          `**By:** ${req.user?.username || 'system'}`,
          transNote ? `**Note:** ${transNote}` : '',
          `[View CN](${BASE_URL}/admin/finance/credit-notes/${targetCn})`,
        ].filter(Boolean).join('\n'));
      }

      return res.json({ success: true, data: updated.rows[0] });
    }

    // Apply CN against invoice/payment
    if (action === 'apply') {
      const { cn_no: bodyCn, invoice_no, amount, applied_by } = req.body;
      const targetCn = bodyCn || cn_no;
      if (!targetCn) return res.status(400).json({ error: 'cn_no required' });
      if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'amount required' });

      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [targetCn]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const cn = r.rows[0];
      const raw = getRaw(cn);

      // Fail-closed: cross-customer CN apply forbidden
      if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
        const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : []);
        if (!codes.includes(cn.company_code)) {
          return res.status(422).json({ error: 'Cannot apply CN: company scope mismatch (cross-customer forbidden)' });
        }
      }

      const outstanding = calcOutstanding(cn);
      const applyAmt = parseFloat(amount);
      if (applyAmt > outstanding + 0.01) {
        return res.status(422).json({ error: `Cannot apply ${applyAmt} — only ${outstanding} outstanding` });
      }

      const appliedTo = raw.applied_to || [];
      appliedTo.push({
        invoice_no: invoice_no || null,
        amount: applyAmt,
        applied_at: new Date().toISOString(),
        applied_by: applied_by || req.user?.username || null,
      });
      raw.applied_to = appliedTo;

      const newOutstanding = Math.max(0, outstanding - applyAmt);
      const newStatus = newOutstanding <= 0.01 ? 'applied' : cn.status;

      const updated = await pool.query(
        `UPDATE credit_notes SET raw=raw || $1::jsonb, status=$2, updated_at=NOW() WHERE cn_no=$3 RETURNING *`,
        [JSON.stringify({ applied_to: appliedTo }), newStatus, targetCn]
      );
      return res.json({ success: true, data: { ...updated.rows[0], outstanding: newOutstanding } });
    }

    // Generate password-gated external share link (renders CN → static PDF → doc_share_links)
    if (action === 'share') {
      const targetCn = req.query.cn_no || cn_no;
      if (!targetCn) return res.status(400).json({ error: 'cn_no required' });
      const cnRow = (await pool.query('SELECT contract_no FROM credit_notes WHERE cn_no=$1', [targetCn])).rows[0];
      if (!cnRow) return res.status(404).json({ error: 'CN not found' });
      const html = await renderCreditNote(pool, targetCn, {});
      if (!html) return res.status(404).json({ error: 'CN render failed' });
      let pdf;
      try { pdf = await htmlToPdf(scrubCustomerFacingHtml(html)); }
      catch (e) { return res.status(500).json({ error: 'PDF render failed: ' + e.message }); }
      const cnDir = path.join(UPLOADS_DIR, targetCn);
      mkdirSync(cnDir, { recursive: true });
      const fileTok = randomBytes(12).toString('hex');
      const fname = 'share-' + fileTok + '.pdf';
      fs.writeFileSync(path.join(cnDir, fname), pdf);
      const fileUrl = 'https://api.sanlyn.cn/uploads/cn/' + encodeURIComponent(targetCn) + '/' + fname;
      const linkTok = randomBytes(6).toString('hex');
      const PW = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
      const seg = (n) => Array.from({ length: n }, () => PW[Math.floor(Math.random() * PW.length)]).join('');
      const password = seg(3) + '-' + seg(3) + '-' + seg(3);
      const by = (req.user && (req.user.username || req.user.name)) || 'admin';
      await pool.query(
        `INSERT INTO doc_share_links
           (token, contract_no, doc_key, doc_url, doc_name, password,
            created_by, expires_at, max_downloads, download_count, downloaded_log)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()+INTERVAL '7 days', 50, 0, $8::jsonb)`,
        [linkTok, (cnRow.contract_no || ''), 'cn:' + targetCn, fileUrl,
         'Credit Note ' + targetCn, password, by,
         JSON.stringify([{ action: 'created', by, doc: 'cn:' + targetCn, ts: new Date().toISOString() }])]
      );
      const quickUrl = 'https://api.sanlyn.cn/api/db/doc-share?token=' + linkTok + '&password=' + encodeURIComponent(password);
      const shareUrl = 'https://api.sanlyn.cn/api/db/doc-share?token=' + linkTok;
      return res.json({ ok: true, quickUrl, shareUrl, password, expiresInDays: 7 });
    }

    // Multipart attachment upload
    if (action === 'attachments') {
      const targetCn = req.query.cn_no || cn_no;
      if (!targetCn) return res.status(400).json({ error: 'cn_no required' });

      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [targetCn]);
      if (!r.rows.length) return res.status(404).json({ error: 'CN not found' });
      const cn = r.rows[0];
      const raw = getRaw(cn);
      const existingAttachments = raw.attachments || [];

      if (existingAttachments.length >= MAX_FILES) {
        return res.status(422).json({ error: `Max ${MAX_FILES} attachments reached` });
      }

      const cnDir = path.join(UPLOADS_DIR, targetCn);
      mkdirSync(cnDir, { recursive: true });

      const form = new IncomingForm({
        maxFileSize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES - existingAttachments.length,
        allowEmptyFiles: false,
        filter: ({ mimetype }) => {
          return mimetype && (
            mimetype.startsWith('image/') ||
            mimetype === 'application/pdf' ||
            mimetype.startsWith('video/')
          );
        },
      });

      let fields, files;
      try {
        [fields, files] = await form.parse(req);
      } catch (e) {
        return res.status(400).json({ error: 'Upload parse error: ' + e.message });
      }

      const fileList = Array.isArray(files.file) ? files.file : (files.file ? [files.file] : []);
      if (!fileList.length) return res.status(400).json({ error: 'No files uploaded' });

      const newAttachments = [];
      for (const f of fileList) {
        const sha = createHash('sha256').update(f.originalFilename + Date.now()).digest('hex').slice(0, 12);
        const safeName = sha + '__' + (f.originalFilename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const dest = path.join(cnDir, safeName);
        fs.renameSync(f.filepath, dest);

        newAttachments.push({
          id: sha,
          url: `/uploads/cn/${targetCn}/${safeName}`,
          name: f.originalFilename || 'file',
          size: f.size,
          mimetype: f.mimetype,
          kind: (fields.kind?.[0] || 'doc'),
          uploaded_by: req.user?.username || null,
          uploaded_at: new Date().toISOString(),
        });
      }

      const allAttachments = [...existingAttachments, ...newAttachments];
      await pool.query(
        `UPDATE credit_notes SET raw=raw || $1::jsonb, updated_at=NOW() WHERE cn_no=$2`,
        [JSON.stringify({ attachments: allAttachments }), targetCn]
      );

      return res.json({ success: true, data: newAttachments, total: allAttachments.length });
    }

    // Create new CN (draft)
    const {
      cn_no: bodyCnNo, company_code: bodyCompany, company_name,
      order_no, contract_no, invoice_no,
      issued_date, currency = 'CNY',
      net_amount, note, items = [],
      reason, reason_detail, apply_method, direction,
    } = req.body;

    if (!bodyCompany)  return res.status(400).json({ error: 'company_code required' });
    if (net_amount === undefined || net_amount === null) return res.status(400).json({ error: 'net_amount required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items[] required' });

    for (const it of items) {
      if (!it.qty_unit) return res.status(400).json({
        error: `Item "${it.desc || it.no}" missing qty_unit (must be smallest unit: CANS/PCS/BAGS etc.)`
      });
    }

    const rawInit = {
      direction: direction || null,
      reason: reason || null,
      reason_detail: reason_detail || null,
      apply_method: apply_method || null,
      attachments: [],
      applied_to: [],
      transition_log: [{
        from: null,
        to: 'draft',
        by: req.user?.username || 'system',
        at: new Date().toISOString(),
      }],
    };

    // 自动编号:未传 cn_no → 生成下一个纯顺序号 CN-000xx(仅 ^CN-[0-9]+$ 参与序列,老的带字母的不算);撞号自动重试
    let finalCnNo = bodyCnNo;
    let created;
    for (let attempt = 0; attempt < (bodyCnNo ? 1 : 6); attempt++) {
      if (!bodyCnNo) {
        const _yr = String(new Date().getFullYear());
        const seqR = await pool.query(
          "SELECT COALESCE(MAX(split_part(cn_no,'-',3)::int),0) AS mx FROM credit_notes WHERE cn_no ~ ('^CN-' || $1 || '-[0-9]+$')",
          [_yr]
        );
        finalCnNo = 'CN-' + _yr + '-' + String((Number(seqR.rows[0].mx) || 0) + 1).padStart(4, '0');
      }
      created = await pool.query(`
        INSERT INTO credit_notes
          (cn_no, company_code, company_name, order_no, contract_no, invoice_no,
           issued_date, currency, net_amount, status, note, items, created_by, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13)
        ON CONFLICT (cn_no) DO NOTHING
        RETURNING *
      `, [
        finalCnNo, bodyCompany, company_name,
        order_no, contract_no, invoice_no,
        issued_date || new Date().toISOString().slice(0, 10),
        currency, net_amount, note,
        JSON.stringify(items),
        req.user?.username || null,
        JSON.stringify(rawInit),
      ]);
      if (created.rows.length) break;
    }

    if (!created.rows.length) return res.status(409).json({ error: 'CN number already exists (auto-number exhausted)' });
    return res.status(201).json({ success: true, data: created.rows[0] });
  }

  // ── PATCH ──────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const targetCn = cn_no;
    if (!targetCn) return res.status(400).json({ error: 'cn_no query param required' });

    const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [targetCn]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const cn = r.rows[0];

    // Only allow editing in draft/pending_review
    if (!['draft', 'pending_review'].includes(cn.status)) {
      return res.status(422).json({ error: `Cannot edit CN in status: ${cn.status}` });
    }

    const allowed = ['company_name','order_no','contract_no','invoice_no','issued_date','currency','net_amount','note','items','lang'];
    const sets = ['updated_at=NOW()'];
    const params = [];
    let idx = 1;

    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        sets.push(`${k}=$${idx++}`);
        params.push(k === 'items' ? JSON.stringify(req.body[k]) : req.body[k]);
      }
    }

    // Patch raw fields
    const rawFields = ['reason','reason_detail','apply_method','factory_cn','factory_decision'];
    const rawPatch = {};
    for (const k of rawFields) {
      if (req.body[k] !== undefined) rawPatch[k] = req.body[k];
    }
    if (Object.keys(rawPatch).length) {
      sets.push(`raw=raw || $${idx++}::jsonb`);
      params.push(JSON.stringify(rawPatch));
    }

    params.push(targetCn);
    const updated = await pool.query(
      `UPDATE credit_notes SET ${sets.join(',')} WHERE cn_no=$${idx} RETURNING *`,
      params
    );
    return res.json({ success: true, data: updated.rows[0] });
  }

  // ── DELETE ──────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (action === 'del_attach') {
      const { attachment_id } = req.query;
      const targetCn = cn_no;
      if (!targetCn || !attachment_id) return res.status(400).json({ error: 'cn_no and attachment_id required' });

      const r = await pool.query('SELECT * FROM credit_notes WHERE cn_no=$1', [targetCn]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const cn = r.rows[0];
      const raw = getRaw(cn);
      const existing = raw.attachments || [];
      const toRemove = existing.find(a => a.id === attachment_id);
      if (!toRemove) return res.status(404).json({ error: 'Attachment not found' });

      // Remove file from disk
      try {
        const filePath = path.join('/opt/sanlyn-uploads', toRemove.url.replace('/uploads/', ''));
        unlinkSync(filePath);
      } catch (e) { /* file may not exist */ }

      raw.attachments = existing.filter(a => a.id !== attachment_id);
      await pool.query(
        `UPDATE credit_notes SET raw=raw || $1::jsonb, updated_at=NOW() WHERE cn_no=$2`,
        [JSON.stringify({ attachments: raw.attachments }), targetCn]
      );
      return res.json({ success: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
