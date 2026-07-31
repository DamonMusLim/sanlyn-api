// /api/db/hr-employees.mjs — 集团HRM · 员工花名册（店长/店员，真实人员）
// GET 列表 / GET ?id=X 详情(证件号全量) / GET ?file=<id>&kind=id_card|contract 取证件文件
// POST 新建 / PATCH 编辑。
//
// 🔒 隐私处理（身份证/合同属敏感个人信息，跟报销小票不同等级）：
//  · 证件/合同文件存 /opt/sanlyn-private/hr/<employee_id>/，**不在任何 nginx web root 内**，
//    只能经本接口 ?file= 取，天然吃 /api/db/* 的登录门（未登录 401）。绝不放 /opt/sanlyn-uploads
//    ——那个目录挂在 ai.sanlyn.cn/uploads/ 公开且 CORS *，等于把身份证挂公网。
//  · 列表默认**打码**身份证号(前6后4)，只有 ?id=X 单人详情才返全量。
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getPool, setCors } from "./db.js";
import { hashPw } from "./hr-staff-auth.mjs";   // 店长设初始密码用同一套 scrypt

// ── 员工自助链接：签发【限权长效 token】（role=staff + employee_id，180天）──
// 用同一个 JWT_SECRET，故 auth.js 的 verifyToken 能直接验；但 role=staff 进不了任何后台接口，
// 只有 /api/db/hr-staff-portal 认这个 role，且里面 employee_id 只从 token 取（防改号看别人）。
const STAFF_TOKEN_DAYS = 180;
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signStaffToken(employeeId, name) {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) throw new Error("JWT_SECRET 未配置");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { role: "staff", employee_id: employeeId, name, iat: now, exp: now + STAFF_TOKEN_DAYS * 86400 };
  const seg = [b64url(JSON.stringify(header)), b64url(JSON.stringify(body))];
  seg.push(b64url(crypto.createHmac("sha256", SECRET).update(seg.join(".")).digest()));
  return seg.join(".");
}

const PRIVATE_ROOT = "/opt/sanlyn-private/hr";
const MAX_BYTES = 8 * 1024 * 1024;
const KINDS = { id_card: "id_card_file", contract: "contract_file" };

const COLS = "id, employee_code, name, role, employment_status, store_id, phone, id_card_no, "
  + "company_code, position, pay_type, pay_rate, "
  + "to_char(probation_end,'YYYY-MM-DD') AS probation_end, "
  + "(password_hash IS NOT NULL) AS has_password, must_change_password, "
  + "id_card_file, to_char(contract_start,'YYYY-MM-DD') AS contract_start, "
  + "to_char(contract_end,'YYYY-MM-DD') AS contract_end, contract_file, "
  + "emergency_contact, emergency_phone, to_char(hire_date,'YYYY-MM-DD') AS hire_date, "
  + "face_employee_id, face_enabled, left_at, created_at";

// 空串进 date/numeric 列会让 PG 报 invalid input syntax，统一转 null
const dt = (v) => (v === "" || v === undefined ? null : v);
const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

function maskId(v) {
  const s = String(v || "");
  if (s.length < 8) return s ? "****" : null;
  return s.slice(0, 6) + "*".repeat(Math.max(4, s.length - 10)) + s.slice(-4);
}

// 列表视图：证件号打码，文件只给"有没有"的布尔，不外泄路径
function forList(r) {
  return {
    ...r,
    id_card_no: r.id_card_no ? maskId(r.id_card_no) : null,
    id_card_file: undefined,
    contract_file: undefined,
    has_id_card: !!r.id_card_file,
    has_contract: !!r.contract_file,
  };
}

function saveDoc(employeeId, kind, filename, mime, dataB64) {
  const ok = /^image\//.test(String(mime || "")) || mime === "application/pdf";
  if (!ok) throw new Error("证件/合同只支持图片或 PDF");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("文件超过8MB上限");
  const dir = path.join(PRIVATE_ROOT, String(employeeId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = `${kind}_${Date.now()}_` +
    String(filename || "doc").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf, { mode: 0o600 });
  return path.posix.join(String(employeeId), safe); // 只存相对路径，取用时再拼根目录
}

function streamDoc(res, rel) {
  // 防路径穿越：解析后必须仍在 PRIVATE_ROOT 内
  const abs = path.resolve(PRIVATE_ROOT, rel);
  if (!abs.startsWith(PRIVATE_ROOT + path.sep)) return res.status(400).json({ success: false, error: "非法路径" });
  if (!fs.existsSync(abs)) return res.status(404).json({ success: false, error: "文件不存在" });
  const ext = path.extname(abs).toLowerCase();
  const type = ext === ".pdf" ? "application/pdf"
    : ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp" : "image/jpeg";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "private, no-store");
  return res.end(fs.readFileSync(abs));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const { id, file, kind, q, role, employment_status, staff_link, limit = 500, offset = 0 } = req.query;

      // 生成员工自助链接（发给店员，手机打开即可用；180天有效）
      if (staff_link) {
        const e = await pool.query("SELECT id,name,employment_status FROM hr_employees WHERE id=$1", [staff_link]);
        if (!e.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
        if (e.rows[0].employment_status !== "active")
          return res.status(400).json({ success: false, error: "该员工已离职，不发链接" });
        const token = signStaffToken(e.rows[0].id, e.rows[0].name);
        return res.status(200).json({ success: true, data: {
          employee: e.rows[0].name,
          // 员工端读的是 ?t=（Q.get("t")），路径式 /m/staff/<token> 打开是登录页
          url: `https://pet.sanlyn.cn/m/staff?t=${token}`,
          expires_days: STAFF_TOKEN_DAYS,
          note: "发给员工本人。此链接只能看/提交他自己的数据，无任何审批权。员工离职后链接自动失效。",
        }});
      }

      // 取证件/合同文件（已过登录门）
      if (file) {
        const col = KINDS[kind];
        if (!col) return res.status(400).json({ success: false, error: "kind 必须是 id_card 或 contract" });
        const r = await pool.query(`SELECT ${col} AS rel FROM hr_employees WHERE id = $1`, [file]);
        if (!r.rows.length || !r.rows[0].rel) return res.status(404).json({ success: false, error: "没有该文件" });
        return streamDoc(res, r.rows[0].rel);
      }

      // 单人详情：证件号返全量（供编辑用）
      if (id) {
        const r = await pool.query(`SELECT ${COLS} FROM hr_employees WHERE id = $1`, [id]);
        if (!r.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
        const row = r.rows[0];
        return res.status(200).json({
          success: true,
          data: { ...row, id_card_file: undefined, contract_file: undefined,
                  has_id_card: !!row.id_card_file, has_contract: !!row.contract_file },
        });
      }

      const params = [];
      const conds = [];
      if (role) { params.push(role); conds.push(`role = $${params.length}`); }
      if (employment_status) { params.push(employment_status); conds.push(`employment_status = $${params.length}`); }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        conds.push(`(name ILIKE $${i} OR employee_code ILIKE $${i} OR phone ILIKE $${i})`);
      }
      let sql = `SELECT ${COLS} FROM hr_employees`;
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit) || 500, 2000));
      sql += ` ORDER BY employment_status ASC, name ASC LIMIT $${params.length}`;
      params.push(parseInt(offset) || 0);
      sql += ` OFFSET $${params.length}`;
      const rows = await pool.query(sql, params);
      const c = await pool.query("SELECT COUNT(*) FROM hr_employees");
      return res.status(200).json({ success: true, data: rows.rows.map(forList), count: parseInt(c.rows[0].count) });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ success: false, error: "name 必填" });
      const r = await pool.query(
        `INSERT INTO hr_employees
           (employee_code, name, role, store_id, phone, id_card_no,
            contract_start, contract_end, emergency_contact, emergency_phone, hire_date,
            company_code, position, pay_type, pay_rate, probation_end,
            password_hash, must_change_password)
         VALUES ($1,$2,COALESCE($3,'clerk'),COALESCE($4,'jinfang'),$5,$6,$7,$8,$9,$10,$11,
                 COALESCE($12,'JINFANG'),$13,COALESCE($14,'daily'),$15,$16,$17,true) RETURNING id`,
        [b.employee_code || null, b.name, b.role || null, b.store_id || null, b.phone || null,
         b.id_card_no || null, dt(b.contract_start), dt(b.contract_end),
         b.emergency_contact || null, b.emergency_phone || null, dt(b.hire_date),
         b.company_code || null, b.position || null, b.pay_type || null,
         num(b.pay_rate), dt(b.probation_end),
         b.password ? hashPw(String(b.password)) : null]
      );
      const newId = r.rows[0].id;
      const sets = [];
      const params = [];
      for (const k of Object.keys(KINDS)) {
        const b64 = b[`${k}_base64`];
        if (!b64) continue;
        try {
          const rel = saveDoc(newId, k, b[`${k}_filename`], b[`${k}_mime`], b64);
          params.push(rel); sets.push(`${KINDS[k]} = $${params.length}`);
        } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      }
      if (sets.length) {
        params.push(newId);
        await pool.query(`UPDATE hr_employees SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      }
      const out = await pool.query(`SELECT ${COLS} FROM hr_employees WHERE id = $1`, [newId]);
      return res.status(200).json({ success: true, data: forList(out.rows[0]) });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const allowed = ["employee_code", "name", "role", "employment_status", "store_id",
        "phone", "id_card_no", "contract_start", "contract_end",
        "emergency_contact", "emergency_phone", "hire_date", "face_employee_id", "face_enabled",
        "company_code", "position", "pay_type", "pay_rate", "probation_end"];
      const sets = [];
      const params = [];
      for (const k of allowed) {
        if (k in body) {
          // 日期/数字空串要转 null，否则 PG 报 invalid input syntax
          let v = body[k];
          if (["contract_start", "contract_end", "hire_date", "probation_end"].includes(k)) v = dt(v);
          if (k === "pay_rate") v = num(v);
          params.push(v); sets.push(`${k} = $${params.length}`);
        }
      }
      // 店长重设初始密码：员工下次登录强制改
      if (body.password) {
        params.push(hashPw(String(body.password)));
        sets.push(`password_hash = $${params.length}`);
        sets.push("must_change_password = true");
        sets.push("login_fail_count = 0");
        sets.push("locked_until = NULL");
      }
      for (const k of Object.keys(KINDS)) {
        const b64 = body[`${k}_base64`];
        if (!b64) continue;
        try {
          const rel = saveDoc(id, k, body[`${k}_filename`], body[`${k}_mime`], b64);
          params.push(rel); sets.push(`${KINDS[k]} = $${params.length}`);
        } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      }
      if (body.employment_status === "left") {
        params.push(new Date().toISOString());
        sets.push(`left_at = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
      params.push(id);
      const r = await pool.query(
        `UPDATE hr_employees SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLS}`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
      return res.status(200).json({ success: true, data: forList(r.rows[0]) });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
