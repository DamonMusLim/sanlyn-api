// /api/db/hr-reimbursements.mjs — 集团HRM · 员工报销（购买+上传小票图片+审批）
// GET 列表 / POST 新建(含 receipt upload) / PATCH 仅限审批字段(status/review_note/reviewed_by)。
// 图片走 base64 JSON（仿现有 booking-collab 上传模式），存 /opt/sanlyn-uploads/reimbursement/，
// 走 ai.sanlyn.cn/uploads/reimbursement/... 静态访问，≤6MB，仅图片。
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { reportFailure } from "./lib/report-failure.mjs";

const UPLOAD_DIR = "/opt/sanlyn-uploads/reimbursement";
// 绝对域名：SPA 同时跑在 ai.sanlyn.cn 和 pet.sanlyn.cn 两个域，相对路径 /uploads/... 在 pet 域会404
// （pet.sanlyn.cn nginx 只放行 /uploads/banners/，没有通用 /uploads/ location）。ai.sanlyn.cn 是唯一公开可访问该路径的域。
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_BYTES = 6 * 1024 * 1024;
const APPROVAL_FIELDS = ["status", "review_note", "reviewed_by"];

function saveReceipt(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("仅支持图片格式");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("图片超过6MB上限");
  const dir = path.join(UPLOAD_DIR, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(filename || "receipt").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  const dest = path.join(dir, safeName);
  fs.writeFileSync(dest, buf);
  return `${PUBLIC_HOST}/uploads/reimbursement/${path.basename(dir)}/${safeName}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const { status, employee_id, limit = 500, offset = 0 } = req.query;
      const params = [];
      const conds = [];
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      if (employee_id) { params.push(employee_id); conds.push(`employee_id = $${params.length}`); }
      let sql = "SELECT id, employee_id, employee_name, store_id, amount, item_desc, to_char(purchase_date,'YYYY-MM-DD') AS purchase_date, "
              + "receipt_url, status, review_note, reviewed_by, reviewed_at, created_at "
              + "FROM hr_reimbursements";
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit) || 500, 2000));
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      params.push(parseInt(offset) || 0);
      sql += ` OFFSET $${params.length}`;
      const rows = await pool.query(sql, params);
      const c = await pool.query(
        "SELECT COUNT(*) AS total, count(*) FILTER (WHERE status='pending') AS pending, "
        + "COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS approved_total FROM hr_reimbursements"
      );
      return res.status(200).json({ success: true, data: rows.rows, count: parseInt(c.rows[0].total), stats: c.rows[0] });
    }

    if (req.method === "POST") {
      const { employee_id, employee_name, store_id, amount, item_desc, purchase_date,
              receipt_filename, receipt_mime, receipt_base64 } = req.body || {};
      if (!employee_name || !amount) {
        return res.status(400).json({ success: false, error: "employee_name/amount 必填" });
      }
      let receiptUrl = null;
      if (receipt_base64) {
        try { receiptUrl = saveReceipt(receipt_filename, receipt_mime, receipt_base64); }
        catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      }
      const r = await pool.query(
        `INSERT INTO hr_reimbursements
           (employee_id, employee_name, store_id, amount, item_desc, purchase_date, receipt_url)
         VALUES ($1, $2, COALESCE($3,'jinfang'), $4, $5, $6, $7)
         RETURNING *`,
        [employee_id || null, employee_name, store_id || null, amount, item_desc || null,
         purchase_date || null, receiptUrl]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [];
      const params = [];
      for (const k of APPROVAL_FIELDS) {
        if (k in body) { params.push(body[k]); sets.push(`${k} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "仅允许更新审批字段 status/review_note/reviewed_by" });
      if (body.status === "approved" || body.status === "rejected") {
        params.push(new Date().toISOString());
        sets.push(`reviewed_at = $${params.length}`);
      }
      params.push(id);
      const sql = `UPDATE hr_reimbursements SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`;
      const r = await pool.query(sql, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "报销记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    await reportFailure("hr-reimbursements", err, {
      impact: "报销审批列表/审批动作失败",
      method: req.method,
      user: req.user?.username || req.user?.account || req.user?.sub || null,
    }, { pool });
    return res.status(500).json({ success: false, error: err.message });
  }
}
