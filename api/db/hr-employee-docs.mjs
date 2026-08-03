// /api/db/hr-employee-docs.mjs — 员工凭据柜（需后台登录）
//
//   GET  ?employee_id=36            → 这个人名下所有凭据（不含已归档；加 &all=1 看全部）
//   GET  ?doc_id=12                 → 下载/预览这一份（**只走这个口，文件不在任何 web root 里**）
//   POST {action:'upload', employee_id, kind, filename, mime, base64, title?, note?, valid_from?, valid_to?}
//   POST {action:'archive', id, note?}   → 作废（不删文件，只标归档）
//
// 🔒 三条不能破：
//   1. 文件一律落 /opt/sanlyn-private/hr/<employee_id>/ —— /opt/sanlyn-uploads 是公开可读的，身份证进那里=泄露
//   2. 路径穿越硬拦：拼完 resolve，必须还在 PRIVATE_ROOT 底下才给
//   3. 只增不删。作废走 archived_at —— 仲裁时「当时交的是哪一版」比「现在是哪一版」重要
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

const PRIVATE_ROOT = "/opt/sanlyn-private/hr";
const MAX_BYTES = 12 * 1024 * 1024;
const OK_MIME = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/;

export const KIND_LABEL = {
  id_card_front: "身份证 · 人像面", id_card_back: "身份证 · 国徽面",
  contract: "劳动合同", training_agreement: "培训服务期协议",
  health_cert: "健康证", award: "奖励", penalty: "处分",
  resignation: "离职证明", social_insurance: "社保凭证", other: "其他",
};
// 花名册上那三个快捷指针：传了新的就同步过去，老代码照常работа
const MIRROR_COL = { id_card_front: "id_card_file", id_card_back: "id_card_back_file", contract: "contract_file" };

function saveFile(employeeId, filename, mime, dataB64) {
  if (!OK_MIME.test(String(mime || ""))) throw new Error("只收图片或 PDF");
  const buf = Buffer.from(dataB64, "base64");
  if (!buf.length) throw new Error("文件是空的");
  if (buf.length > MAX_BYTES) throw new Error("文件超过 12MB");
  const dir = path.join(PRIVATE_ROOT, String(employeeId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = `${Date.now()}_` +
    String(filename || "doc").replace(/[^a-zA-Z0-9._一-龥-]/g, "_").slice(-80);
  fs.writeFileSync(path.join(dir, safe), buf, { mode: 0o600 });
  return { rel: path.posix.join(String(employeeId), safe), bytes: buf.length };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const auth = requireAuth(req, res);
  if (!auth) return;
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";
  const who = auth?.username || auth?.name || auth?.email || "admin";

  try {
    // ── 下载一份 ──
    if (req.method === "GET" && req.query?.doc_id) {
      const d = (await pool.query(
        "SELECT employee_id, file_path, mime, title, kind FROM hr_employee_docs WHERE id=$1", [req.query.doc_id])).rows[0];
      if (!d) return res.status(404).json({ success: false, error: "凭据不存在" });
      const abs = path.resolve(PRIVATE_ROOT, d.file_path);
      if (!abs.startsWith(PRIVATE_ROOT + path.sep)) return res.status(400).json({ success: false, error: "非法路径" });
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, error: "文件不在了" });
      res.setHeader("Content-Type", d.mime || "application/octet-stream");
      res.setHeader("Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent((d.title || KIND_LABEL[d.kind] || "doc") + path.extname(abs))}`);
      res.setHeader("Cache-Control", "private, no-store");
      return fs.createReadStream(abs).pipe(res);
    }

    // ── 列一个人的 ──
    if (req.method === "GET") {
      const empId = parseInt(req.query?.employee_id, 10);
      if (!empId) return res.status(400).json({ success: false, error: "缺 employee_id" });
      const cond = req.query?.all === "1" ? "" : " AND archived_at IS NULL";
      const r = await pool.query(
        `SELECT id, kind, title, mime, bytes, note, source, uploaded_by,
                to_char(valid_from,'YYYY-MM-DD') AS valid_from,
                to_char(valid_to,'YYYY-MM-DD')   AS valid_to,
                to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') AS created_at,
                to_char(archived_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') AS archived_at
           FROM hr_employee_docs
          WHERE employee_id=$1${cond}
          ORDER BY created_at DESC`, [empId]);
      // 缺哪几样一起告诉前端，省得它自己拼
      const have = new Set(r.rows.filter((x) => !x.archived_at).map((x) => x.kind));
      const missing = ["id_card_front", "id_card_back", "contract"]
        .filter((k) => !have.has(k)).map((k) => ({ kind: k, label: KIND_LABEL[k] }));
      return res.status(200).json({ success: true, data: r.rows, missing, kinds: KIND_LABEL });
    }

    const b = req.body || {};

    // ── 传一份 ──
    if (b.action === "upload") {
      const empId = parseInt(b.employee_id, 10);
      const kind = String(b.kind || "other");
      if (!empId) return res.status(400).json({ success: false, error: "缺 employee_id" });
      const emp = (await pool.query("SELECT id, company_code FROM hr_employees WHERE id=$1", [empId])).rows[0];
      if (!emp) return res.status(404).json({ success: false, error: "员工不存在" });
      if (!b.base64) return res.status(400).json({ success: false, error: "没有文件" });

      let saved;
      try { saved = saveFile(empId, b.filename, b.mime, b.base64); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }

      const r = await pool.query(
        `INSERT INTO hr_employee_docs
           (company_code, employee_id, kind, title, file_path, mime, bytes,
            valid_from, valid_to, note, source, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin',$11) RETURNING id`,
        [emp.company_code || company, empId, kind, b.title || null, saved.rel,
         b.mime || null, saved.bytes,
         /^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_from || "")) ? b.valid_from : null,
         /^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_to || "")) ? b.valid_to : null,
         b.note || null, who]);

      // 同一 kind 的旧件自动归档 —— 一个人同时只有一份「当前有效的身份证」
      await pool.query(
        `UPDATE hr_employee_docs SET archived_at=now(), archived_by=$3, archive_note='被新版本替换'
          WHERE employee_id=$1 AND kind=$2 AND id<>$4 AND archived_at IS NULL`,
        [empId, kind, who, r.rows[0].id]);

      // 花名册那三个快捷指针跟着走
      if (MIRROR_COL[kind]) {
        await pool.query(`UPDATE hr_employees SET ${MIRROR_COL[kind]}=$1 WHERE id=$2`, [saved.rel, empId]);
      }
      return res.status(200).json({ success: true, id: r.rows[0].id, message: `已归档：${KIND_LABEL[kind] || kind}` });
    }

    // ── 作废（不删文件）──
    if (b.action === "archive") {
      if (!b.id) return res.status(400).json({ success: false, error: "缺 id" });
      const r = await pool.query(
        `UPDATE hr_employee_docs SET archived_at=now(), archived_by=$2, archive_note=$3
          WHERE id=$1 AND archived_at IS NULL RETURNING id, kind, employee_id`, [b.id, who, b.note || null]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "找不到，或已经作废过了" });
      const { kind, employee_id } = r.rows[0];
      if (MIRROR_COL[kind]) {
        const still = (await pool.query(
          "SELECT file_path FROM hr_employee_docs WHERE employee_id=$1 AND kind=$2 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
          [employee_id, kind])).rows[0];
        await pool.query(`UPDATE hr_employees SET ${MIRROR_COL[kind]}=$1 WHERE id=$2`,
          [still?.file_path || null, employee_id]);
      }
      return res.status(200).json({ success: true, message: "已作废（文件留着，随时能翻出来）" });
    }

    return res.status(400).json({ success: false, error: "action 只能是 upload / archive" });
  } catch (e) {
    console.error("[hr-employee-docs]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
