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
  // 2026-05-18 add raw JSONB column for headquarters multi-company scope (company_codes[])
  await pool.query(`ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS raw JSONB`);
  // 2026-05-18 admin-approval flow requires accounts.is_active + portal_role columns
  // These were referenced by code but missing from prod schema — discovered during E2E test.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS portal_role TEXT`);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var pool = getPool();
  var myCode = req.user.companyCode || req.user.company_code;
  var isAdmin = req.user.role === "admin" || req.user.role === "super_admin";

  // P2 fix per codex: run schema migration ONCE at entry so all methods see the new columns.
  // is_active / portal_role were referenced before being added — first call after deploy would 500.
  try { await ensureInviteTable(pool); } catch (e) { /* non-fatal — best-effort */ }

  try {
    // ── GET: list teammates ──
    if (req.method === "GET") {
      var code = req.query?.company_code || myCode;
      if (!code) return res.status(200).json({ success: true, company_code: null, members: [], pending_invites: [] });
      if (!isAdmin && code !== myCode) return res.status(403).json({ error: "can only view own company" });

      // Active accounts only — pending-review go in their own bucket below
      var r = await pool.query(
        `SELECT id, username, role, company, company_code, supplier_role,
                portal_role, is_active, created_at
         FROM accounts WHERE company_code = $1 AND is_active = true ORDER BY created_at ASC`,
        [code]
      );

      // Inactive accounts = registered but waiting for admin approval (双门槛 流程)
      var pendingReview = await pool.query(
        `SELECT id, username, role, company_code, company_codes, created_at
         FROM accounts WHERE company_code = $1 AND is_active = false ORDER BY created_at DESC`,
        [code]
      );

      // Outstanding invites (not yet clicked / not yet registered) — table ensured at handler entry
      var inv = await pool.query(
        `SELECT id, email, role, invited_by, expires_at, created_at
         FROM team_invites WHERE company_code = $1 AND status = 'pending' ORDER BY created_at DESC`,
        [code]
      );

      return res.status(200).json({
        success: true,
        company_code: code,
        members: r.rows.map(sanitize),
        pending_review: pendingReview.rows.map(sanitize),
        pending_invites: inv.rows,
      });
    }

    // ── POST /invite (path is /accounts-team, action via body.action) ──
    var body = req.body || {};
    if (req.method === "POST" && body.action === "invite") {
      var { email, role } = body;
      // Email is now OPTIONAL (2026-05-18 双门槛): admin can generate link without
      // knowing recipient's email; invitee self-claims on team-join page.
      // If admin provides one, it becomes a hard verification gate.
      if (email != null && email !== "" && String(email).indexOf("@") < 0) {
        return res.status(400).json({ error: "email_invalid" });
      }
      // Use a placeholder for the not-null constraint when admin doesn't know the email.
      // team-join handler treats any value without '@' as "no hint" and lets invitee self-claim.
      var emailForDb = email && String(email).trim() ? String(email).trim().toLowerCase() : "(pending-self-claim)";
      role = ALLOWED_ROLES.includes(role) ? role : "operator";

      // Headquarters scope (2026-05-18): caller passes company_codes[] = all siblings.
      // We store them on team_invites.raw and propagate to accounts.company_codes on accept.
      var hqCodes = Array.isArray(body.company_codes) && body.company_codes.length > 0 ? body.company_codes : null;
      var targetCode = body.company_code || myCode;

      // Resolve inviter's full allowed scope: own company + any sibling (same group_id /
      // parent_company_code / direct parent). Sanlyn admins bypass — they're trusted to manage all.
      var allowedCodes = new Set([myCode]);
      if (!isAdmin && myCode) {
        var scope = await pool.query(
          `SELECT b.company_code FROM customers a, customers b
            WHERE a.company_code = $1
              AND (
                (a.group_id IS NOT NULL AND a.group_id = b.group_id)
                OR a.company_code = b.parent_company_code
                OR b.company_code = a.parent_company_code
                OR (a.parent_company_code IS NOT NULL AND a.parent_company_code = b.parent_company_code)
                OR b.company_code = a.company_code
              )`,
          [myCode]
        );
        scope.rows.forEach(function(r) { allowedCodes.add(r.company_code); });
      }

      // Gate target_code against allowed scope
      if (!isAdmin && !allowedCodes.has(targetCode)) {
        return res.status(403).json({ error: "can only invite to own company or group" });
      }
      // P1 fix per codex: every requested HQ scope code MUST be within inviter's allowed scope.
      // Otherwise caller could grant invitee access to companies they themselves don't have.
      if (!isAdmin && hqCodes) {
        for (var i = 0; i < hqCodes.length; i++) {
          if (!allowedCodes.has(hqCodes[i])) {
            return res.status(403).json({
              error: "hq_scope_out_of_range",
              message: "Cannot grant HQ access to " + hqCodes[i] + " — outside your group scope.",
            });
          }
        }
      }

      // Dup checks only meaningful when admin specified a real email
      if (email) {
        var dup = await pool.query("SELECT id FROM accounts WHERE username = $1 LIMIT 1", [email]);
        if (dup.rows.length) return res.status(409).json({ error: "email already registered" });
      }

      // ensureInviteTable already ran at handler entry
      if (email) {
        var dup2 = await pool.query(
          "SELECT id FROM team_invites WHERE email = $1 AND company_code = $2 AND status = 'pending' LIMIT 1",
          [email, targetCode]
        );
        if (dup2.rows.length) return res.status(409).json({ error: "invite already pending for this email" });
      }

      var token = crypto.randomBytes(24).toString("hex");
      var expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      // Store HQ multi-company scope on raw JSONB if present; accept handler reads it back.
      var inviteRaw = hqCodes ? JSON.stringify({ scope: "headquarters", company_codes: hqCodes }) : null;
      var ins = await pool.query(
        `INSERT INTO team_invites (token, company_code, email, role, invited_by, expires_at, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [token, targetCode, emailForDb, role, req.user.email || req.user.username, expires, inviteRaw]
      );

      var link = BASE_URL + "/team-join.html?token=" + token;
      // Only send email if admin actually specified a real email; otherwise admin shares link manually
      var emailRes = email
        ? await sendInviteEmail({ to: email, inviter_company: req.user.company || targetCode, invite_link: link })
        : { skipped: true, reason: "no_email_self_claim_flow" };

      writeAudit(pool, req, {
        action: "team.invite",
        entity_type: "account",
        entity_id: ins.rows[0].id,
        after: { email: email || "(self-claim)", role, company_code: targetCode },
        note: email ? "invite link sent via email" : "invite link generated for manual share",
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
