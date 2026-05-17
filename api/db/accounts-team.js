// accounts-team.js
// 公司主账号管理团队成员 — 列表/邀请/改权限/移除
// 蓝图 §5 + 老板拍板"客户自己管"
//
// GET    /api/db/accounts-team               — 列出本公司所有账号
// POST   /api/db/accounts-team/invite        — 邀请同事 (按 email 发链接，对方设密码)
// PATCH  /api/db/accounts-team/:id           — 改权限 (operator/viewer/...)
// DELETE /api/db/accounts-team/:id           — 移除成员
//
// 权限规则:
//   - 必须登录
//   - 只能操作 company_code = 自己 company_code 的账号
//   - admin 跨公司操作无限制
//   - 不能删除自己

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";

var BASE_URL = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";
var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
var DM_AK = process.env.DM_ACCESS_KEY_ID || "";
var DM_SK = process.env.DM_ACCESS_KEY_SECRET || "";
var DM_REGION = process.env.DM_REGION || "ap-southeast-1";

var ALLOWED_ROLES = ["owner", "admin", "operator", "viewer", "finance"];

function sanitize(row) {
  if (!row) return row;
  var { password, pwd, pwd_hash, password_hash, ...rest } = row;
  return rest;
}

async function sendInviteEmail({ to, inviter_company, invite_link }) {
  if (!DM_AK || !DM_SK || !to) return { skipped: true };
  var subject = "Sanlyn OS — Team Invitation";
  var html = [
    "<p>Hi,</p>",
    "<p>You've been invited to join <strong>" + (inviter_company || "Sanlyn OS") + "</strong> as a team member.</p>",
    "<p>Click below to set your password and activate your account (link valid 7 days):</p>",
    "<p><a href='" + invite_link + "' style='background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block'>Accept Invitation →</a></p>",
    "<p style='color:#888;font-size:12px'>Or copy: " + invite_link + "</p>",
    "<hr/><p style='color:#888;font-size:12px'>Sanlyn OS · ai.sanlyn.cn</p>",
  ].join("\n");

  var endpoint = DM_REGION === "cn-hangzhou" ? "https://dm.aliyuncs.com/" : "https://dm." + DM_REGION + ".aliyuncs.com/";
  var params = {
    Action: "SingleSendMail", Version: "2015-11-23", Format: "JSON",
    AccessKeyId: DM_AK, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
    SignatureNonce: Math.random().toString(36).slice(2),
    Timestamp: new Date().toISOString().replace(/\.\d+/, "Z"),
    AccountName: "OB@sanlynos.com", FromAlias: "Sanlyn OS",
    AddressType: "1", ReplyToAddress: "false",
    ToAddress: to, Subject: subject, HtmlBody: html,
  };
  var sorted = Object.keys(params).sort()
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
  params.Signature = crypto.createHmac("sha1", DM_SK + "&")
    .update("POST&" + encodeURIComponent("/") + "&" + encodeURIComponent(sorted))
    .digest("base64");

  try {
    var r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&"),
    });
    var j = await r.json();
    return j.Code ? { ok: false, code: j.Code } : { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function ensureInviteTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_invites (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token         VARCHAR(64) UNIQUE NOT NULL,
      company_code  VARCHAR(32) NOT NULL,
      email         VARCHAR(128) NOT NULL,
      role          VARCHAR(16) DEFAULT 'operator',
      invited_by    VARCHAR(64),
      status        VARCHAR(16) DEFAULT 'pending',
      expires_at    TIMESTAMPTZ,
      used_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var pool = getPool();
  var myCode = req.user.companyCode || req.user.company_code;
  var isAdmin = req.user.role === "admin" || req.user.role === "super_admin";

  try {
    // ── GET: list teammates ──
    if (req.method === "GET") {
      var code = req.query?.company_code || myCode;
      if (!code) return res.status(200).json({ success: true, company_code: null, members: [], pending_invites: [] });
      if (!isAdmin && code !== myCode) return res.status(403).json({ error: "can only view own company" });

      var r = await pool.query(
        `SELECT id, username, role, company, company_code, supplier_role,
                portal_role, is_active, created_at
         FROM accounts WHERE company_code = $1 ORDER BY created_at ASC`,
        [code]
      );

      // pending invites (not yet accepted)
      await ensureInviteTable(pool);
      var inv = await pool.query(
        `SELECT id, email, role, invited_by, expires_at, created_at
         FROM team_invites WHERE company_code = $1 AND status = 'pending' ORDER BY created_at DESC`,
        [code]
      );

      return res.status(200).json({
        success: true,
        company_code: code,
        members: r.rows.map(sanitize),
        pending_invites: inv.rows,
      });
    }

    // ── POST /invite (path is /accounts-team, action via body.action) ──
    var body = req.body || {};
    if (req.method === "POST" && body.action === "invite") {
      var { email, role } = body;
      if (!email) return res.status(400).json({ error: "email required" });
      role = ALLOWED_ROLES.includes(role) ? role : "operator";

      var targetCode = body.company_code || myCode;
      if (!isAdmin && targetCode !== myCode) {
        // Allow cross-company invite within the same group / parent company.
        // PETSOME GROUP siblings + 中宠 departments all share group_id or
        // parent_company_code with the inviter's company.
        var sameGroup = await pool.query(
          `SELECT 1 FROM customers a, customers b
            WHERE a.company_code = $1 AND b.company_code = $2
              AND (
                (a.group_id IS NOT NULL AND a.group_id = b.group_id)
                OR a.company_code = b.parent_company_code
                OR b.company_code = a.parent_company_code
                OR a.parent_company_code = b.parent_company_code
              )
            LIMIT 1`,
          [myCode, targetCode]
        );
        if (sameGroup.rows.length === 0) {
          return res.status(403).json({ error: "can only invite to own company or group" });
        }
      }

      // Check for existing account or pending invite with this email
      var dup = await pool.query(
        "SELECT id FROM accounts WHERE username = $1 LIMIT 1",
        [email]
      );
      if (dup.rows.length) return res.status(409).json({ error: "email already registered" });

      await ensureInviteTable(pool);
      var dup2 = await pool.query(
        "SELECT id FROM team_invites WHERE email = $1 AND company_code = $2 AND status = 'pending' LIMIT 1",
        [email, targetCode]
      );
      if (dup2.rows.length) return res.status(409).json({ error: "invite already pending for this email" });

      var token = crypto.randomBytes(24).toString("hex");
      var expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      var ins = await pool.query(
        `INSERT INTO team_invites (token, company_code, email, role, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [token, targetCode, email, role, req.user.email || req.user.username, expires]
      );

      var link = BASE_URL + "/team-join?token=" + token;
      var emailRes = await sendInviteEmail({ to: email, inviter_company: req.user.company || targetCode, invite_link: link });

      writeAudit(pool, req, {
        action: "team.invite",
        entity_type: "account",
        entity_id: ins.rows[0].id,
        after: { email, role, company_code: targetCode },
        note: "invite link sent",
      }).catch(() => {});

      return res.status(200).json({ success: true, invite_id: ins.rows[0].id, link, email_sent: emailRes });
    }

    // ── PATCH: change role / activate ──
    if (req.method === "PATCH") {
      var idMatch = (req.url || "").match(/\/accounts-team\/([^?]+)/);
      var targetId = body.id || (idMatch && idMatch[1]);
      if (!targetId) return res.status(400).json({ error: "id required" });

      var tg = await pool.query("SELECT id, company_code, username FROM accounts WHERE id = $1 LIMIT 1", [targetId]);
      if (!tg.rows.length) return res.status(404).json({ error: "account not found" });
      var t = tg.rows[0];
      if (!isAdmin && t.company_code !== myCode) return res.status(403).json({ error: "out of scope" });

      var sets = [], vals = [];
      if (body.role !== undefined && ALLOWED_ROLES.includes(body.role)) {
        vals.push(body.role); sets.push(`role = $${vals.length}`);
      }
      if (body.portal_role !== undefined) {
        vals.push(body.portal_role); sets.push(`portal_role = $${vals.length}`);
      }
      if (body.is_active !== undefined) {
        vals.push(!!body.is_active); sets.push(`is_active = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });

      vals.push(targetId);
      await pool.query(`UPDATE accounts SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);

      writeAudit(pool, req, {
        action: "team.update",
        entity_type: "account",
        entity_id: targetId,
        after: { role: body.role, is_active: body.is_active },
      }).catch(() => {});

      return res.status(200).json({ success: true, id: targetId });
    }

    // ── DELETE ──
    if (req.method === "DELETE") {
      var idMatch2 = (req.url || "").match(/\/accounts-team\/([^?]+)/);
      var delId = req.query?.id || body.id || (idMatch2 && idMatch2[1]);
      if (!delId) return res.status(400).json({ error: "id required" });

      var tg2 = await pool.query("SELECT id, company_code, username FROM accounts WHERE id = $1 LIMIT 1", [delId]);
      if (!tg2.rows.length) return res.status(404).json({ error: "account not found" });
      var t2 = tg2.rows[0];
      if (!isAdmin && t2.company_code !== myCode) return res.status(403).json({ error: "out of scope" });
      if (String(t2.id) === String(req.user.uid)) return res.status(400).json({ error: "cannot delete yourself" });

      await pool.query("UPDATE accounts SET is_active = false WHERE id = $1", [delId]);

      writeAudit(pool, req, {
        action: "team.deactivate",
        entity_type: "account",
        entity_id: delId,
        after: { is_active: false },
      }).catch(() => {});

      return res.status(200).json({ success: true, id: delId, message: "account deactivated" });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[accounts-team]", e);
    return res.status(500).json({ error: e.message });
  }
}
