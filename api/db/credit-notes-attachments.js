import { mkdirSync, unlinkSync } from 'fs';
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { IncomingForm } from 'formidable';
import { UPLOADS_DIR, MAX_FILE_SIZE, MAX_FILES, getRaw } from './credit-notes-lib.js';

export async function uploadAttachments(req, res, pool, cn_no) {
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

export async function deleteAttachment(req, res, pool, cn_no) {
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
