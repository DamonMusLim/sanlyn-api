// po-collab-review.js — 采购单协同 · 我方审核采纳（SOP 第 2 步收口 → 第 3 步发 PI）
// Damon 0925 定：
//   ① 采纳 → 订单写 确认交期 + 工厂确认时间/人；工厂改过的数量存 orders.confirmed_qty 待过目（⛔ 不覆盖 OLI 原数量）
//   ② 采纳 → 工厂填的 箱规/毛重/净重/条码 以工厂为准覆盖 products（⛔ HS 不动：工厂只是建议，申报口径我们定）
//   ③ 采纳后同一条任务改「待发 PI」；④ 可写原因退回工厂，工厂同一张单改完重交
// 全部要登录（内部账号），⛔ 工厂/客户/门户账号一律 403。每次写库前后值都记进 collab.po_event，可追可撤。

import { requireAuth } from "../../auth.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";
import fs from "node:fs/promises";
import { customerReview, customerAdopt, customerReturn } from "./po-collab-customer.js";
import path from "node:path";

const UPLOAD_ROOT = "/opt/sanlyn-uploads/po-collab";

const ROLE = "factory_po";
const LINK_DAYS = 14;
// 🔴 白名单：只有内部管理员能审核/采纳/退回（原黑名单会放行 logistics/trader/petstore/staff/disabled）
const INTERNAL_ROLES = ["admin"];
const INTERNAL_UIDS = [91];   // damon（Damon 本人，role=petstore），按账号 id 放行
// 工厂字段 → products 列（⛔ hs_code 不在里面）
const PRODUCT_MAP = { box_l: "box_l", box_w: "box_w", box_h: "box_h", gw_ctn: "gross_weight", nw_ctn: "net_weight", barcode: "barcode" };

function staffOnly(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!INTERNAL_ROLES.includes(String(req.user?.role || "").toLowerCase()) && !INTERNAL_UIDS.includes(Number(req.user?.uid))) {
    res.status(403).json({ ok: false, error: "仅限内部管理员账号" });
    return false;
  }
  return true;
}
const who = (req) => req.user?.username || req.user?.name || req.user?.role || "staff";
const ymd = (d) => (d ? new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null);
// ⛔ 空值不许当 0：工厂没填 ≠ 工厂填了 0（0926 测试抓到：没填的 34 行全被记成「改成 0 箱」）
const num = (v) => { if (v == null || String(v).trim() === "") return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

async function loadSheet(pool, sheetId) {
  const s = await pool.query(
    `SELECT s.*, o.id AS oid, o.customer, o.customer_po, o.contract_no, o.fs_no, o.pi_no, o.customer_confirmed_at,
            o.confirmed_delivery, o.confirmed_qty, o.factory_confirmed_at, o.factory_confirmed_by,
            c.code AS factory_code, c.contact_email AS factory_email
       FROM collab.po_sheet s
       LEFT JOIN orders o ON o.order_no = s.order_no
       LEFT JOIN companies c ON c.id = s.factory_company_id
      WHERE s.id = $1`, [sheetId]);
  return s.rows[0] || null;
}

// ── GET /review?sheet=ID ────────────────────────────────────
async function handleReview(req, res, pool) {
  if (!staffOnly(req, res)) return;
  const id = parseInt(req.query?.sheet || req.query?.sheet_id, 10);
  if (!id) return res.status(400).json({ ok: false, error: "sheet 必填" });
  const s = await loadSheet(pool, id);
  if (!s) return res.status(404).json({ ok: false, error: "没有这张协同单" });
  if (s.side === "customer") return await customerReview(req, res, pool, s);   // 订单协同·客户版

  const lines = await pool.query(
    `SELECT l.id, l.seq, l.product_id, l.product_name, l.ours, l.theirs, l.diff_keys,
            p.sku, p.box_l, p.box_w, p.box_h, p.gross_weight, p.net_weight, p.barcode, p.cbm
       FROM collab.po_line l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.sheet_id = $1 ORDER BY l.seq`, [id]);
  const hist = await pool.query(
    `SELECT seq, field, old_val, new_val, COALESCE(NULLIF(actor_name,''), actor_org) AS who, actor_side, created_at
       FROM collab.po_line_history WHERE sheet_id = $1 ORDER BY created_at`, [id]);
  const files = await pool.query(
    `SELECT id, kind, file_name, created_at FROM collab.po_file WHERE sheet_id = $1 ORDER BY created_at DESC`, [id]);
  const evts = await pool.query(
    `SELECT kind, actor_side, COALESCE(NULLIF(actor_name,''), actor_org) AS who, detail, created_at
       FROM collab.po_event WHERE sheet_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
  const task = await pool.query(`SELECT id, status, progress_label FROM tasks WHERE id = $1`, [`po-confirm-${id}`]);
  const pendingSeal = (await pool.query(
    `SELECT cs.id, cs.url, cs.username, cs.uploaded_at FROM customer_stamps cs JOIN companies c ON c.code = cs.company_code
      WHERE c.id = $1 AND NOT cs.is_active AND cs.name LIKE '%待审核%' ORDER BY cs.uploaded_at DESC LIMIT 1`,
    [s.factory_company_id])).rows[0] || null;

  return res.json({
    ok: true,
    sheet: {
      id: s.id, order_no: s.order_no, status: s.status, factory_name: s.factory_name,
      display_no: s.contract_no || s.fs_no || s.customer_po || "",
      customer: s.customer, delivery_date: ymd(s.factory_delivery_date), remarks: s.factory_remarks,
      submitted_at: s.submitted_at, adopted_at: s.adopted_at, adopted_by: s.adopted_by,
      order_now: { confirmed_delivery: ymd(s.confirmed_delivery), factory_confirmed_at: s.factory_confirmed_at,
                   factory_confirmed_by: s.factory_confirmed_by, confirmed_qty: s.confirmed_qty },
    },
    lines: lines.rows, history: hist.rows, files: files.rows, events: evts.rows, task: task.rows[0] || null,
    pending_seal: pendingSeal,
  });
}

// ── POST /adopt {sheet_id} ─────────────────────────────────
async function handleAdopt(req, res, pool) {
  if (!staffOnly(req, res)) return;
  const id = parseInt(req.body?.sheet_id, 10);
  const s = id && await loadSheet(pool, id);
  if (!s) return res.status(404).json({ ok: false, error: "没有这张协同单" });
  if (s.side === "customer") return await customerAdopt(req, res, pool, s, who(req));
  if (s.status !== "confirmed")
    return res.status(409).json({ ok: false, error: `这张单现在是「${s.status}」，工厂回签(交期+合同)齐了才能采纳` });
  if (!s.oid) return res.status(409).json({ ok: false, error: "找不到对应订单" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lines = (await client.query(
      `SELECT l.id, l.seq, l.line_item_id, l.product_id, l.product_name, l.ours, l.theirs,
              p.box_l, p.box_w, p.box_h, p.gross_weight, p.net_weight, p.barcode, p.cbm
         FROM collab.po_line l LEFT JOIN products p ON p.id = l.product_id
        WHERE l.sheet_id = $1 ORDER BY l.seq FOR UPDATE OF l`, [id])).rows;

    // ① 数量：工厂改过的进 confirmed_qty（待过目，不动 OLI）
    const qtyDiffs = [];
    for (const l of lines) {
      const o = num(l.ours?.qty), t = num(l.theirs?.qty);
      if (t != null && o != null && t !== o)
        qtyDiffs.push({ line_item_id: l.line_item_id, product_id: l.product_id, seq: l.seq, name: l.product_name, ours: o, theirs: t });
    }
    const orderBefore = { confirmed_delivery: ymd(s.confirmed_delivery), factory_confirmed_at: s.factory_confirmed_at,
                          factory_confirmed_by: s.factory_confirmed_by, confirmed_qty: s.confirmed_qty };
    await client.query(
      `UPDATE orders SET confirmed_delivery = $2, factory_confirmed_at = NOW(), factory_confirmed_by = $3,
              confirmed_qty = $4::jsonb, updated_at = NOW() WHERE id = $1`,
      [s.oid, s.factory_delivery_date, s.factory_name, JSON.stringify(qtyDiffs)]);

    // ② 产品资料：以工厂为准覆盖（Damon 0925「全部以工厂为准覆盖」），前后值留痕
    const prodChanges = [];
    for (const l of lines) {
      if (!l.product_id || !l.theirs) continue;
      const set = {}, before = {};
      for (const [k, col] of Object.entries(PRODUCT_MAP)) {
        const v = l.theirs[k];
        if (v == null || String(v).trim() === "") continue;
        const nv = col === "barcode" ? String(v).trim() : num(v);
        if (nv == null) continue;
        const cur = l[col];
        if (cur != null && String(cur) === String(nv)) continue;
        if (col !== "barcode" && cur != null && Number(cur) === Number(nv)) continue;
        set[col] = nv; before[col] = cur;
      }
      const L = set.box_l ?? num(l.box_l), W = set.box_w ?? num(l.box_w), H = set.box_h ?? num(l.box_h);
      if (("box_l" in set || "box_w" in set || "box_h" in set) && L && W && H) {
        set.cbm = Math.round(L * W * H / 1e6 * 1e6) / 1e6; before.cbm = l.cbm;
      }
      const cols = Object.keys(set);
      if (!cols.length) continue;
      await client.query(
        `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`,
        [l.product_id, ...cols.map(c => set[c])]);
      prodChanges.push({ product_id: l.product_id, seq: l.seq, name: l.product_name, before, after: set });
    }

    await client.query(
      `UPDATE collab.po_sheet SET status='adopted', adopted_at=NOW(), adopted_by=$2, updated_at=NOW() WHERE id=$1`,
      [id, who(req)]);
    await client.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail)
       VALUES ($1,'adopted','ours',$2,$3::jsonb)`,
      [id, who(req), JSON.stringify({ order_before: orderBefore, qty_diffs: qtyDiffs, product_changes: prodChanges })]);

    // ③ 同一条任务改「待发 PI」
    await client.query(
      `UPDATE tasks SET progress_label = '已采纳 → 第3步：发正式PI',
              title = left(regexp_replace(title, '→ 审核采纳后发PI$', '→ 已采纳·待发PI'), 100),
              next_action = $2, updated_at = NOW(),
              raw = COALESCE(raw,'{}'::jsonb) || $3::jsonb
        WHERE id = $1`,
      [`po-confirm-${id}`,
       `给 ${s.customer || "客户"} 发正式 PI（交期 ${ymd(s.factory_delivery_date)}）`,
       JSON.stringify({ sop_step: 3, adopted_at: new Date().toISOString(), adopted_by: who(req) })]);

    await client.query("COMMIT");
    return res.json({ ok: true, qty_diffs: qtyDiffs.length, product_changes: prodChanges.length,
                      delivery_date: ymd(s.factory_delivery_date) });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message });
  } finally { client.release(); }
}

// ── POST /return {sheet_id, reason} ────────────────────────
async function handleReturn(req, res, pool) {
  if (!staffOnly(req, res)) return;
  const id = parseInt(req.body?.sheet_id, 10);
  const reason = String(req.body?.reason || "").trim().slice(0, 1000);
  if (!reason) return res.status(400).json({ ok: false, error: "请写退回原因" });
  const s = id && await loadSheet(pool, id);
  if (!s) return res.status(404).json({ ok: false, error: "没有这张协同单" });
  if (!["submitted", "confirmed"].includes(s.status))
    return res.status(409).json({ ok: false, error: `这张单现在是「${s.status}」，不能退回` });
  if (s.side === "customer") return await customerReturn(req, res, pool, s, who(req), reason);

  // 新发一个链接放进邮件（旧链接照样能用；只存 hash，原文只在这一刻有）
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1,$2,$3,NOW() + ($4 || ' days')::interval,'[]'::jsonb,NOW())`,
    [rawToHash(raw), ROLE, JSON.stringify({ order_no: s.order_no, sheet_id: id, factory_company_id: s.factory_company_id, reissued_for: "returned" }),
     String(LINK_DAYS)]);
  const link = (process.env.PO_LINK_BASE || `${APP_BASE}/po?c=`) + raw;

  await pool.query(`UPDATE collab.po_sheet SET status='returned', updated_at=NOW() WHERE id=$1`, [id]);
  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail)
     VALUES ($1,'returned','ours',$2,$3::jsonb)`, [id, who(req), JSON.stringify({ reason })]);
  await pool.query(
    `UPDATE tasks SET progress_label='已退回工厂修改', updated_at=NOW(),
            raw = COALESCE(raw,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
    [`po-confirm-${id}`, JSON.stringify({ returned_at: new Date().toISOString(), return_reason: reason })]);

  // 给工厂的通知 → 发件台草稿（⛔ AI/系统不发，Damon 审核后发）；抄送由 companies.cc_emails 触发器补
  let draftId = null;
  if (s.factory_email) {
    const dno = s.contract_no || s.fs_no || s.customer_po || `协同单#${id}`;
    const esc = (t) => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const d = await pool.query(
      `INSERT INTO mail_outbox (tpl_key, sender_key, entity_type, entity_id, prepared_by, to_emails, cc_emails, subject, body_html, status)
       VALUES ('po','petbaby','orders',$1,'po-collab-review',$2::jsonb,'[]'::jsonb,$3,$4,'draft') RETURNING id`,
      [s.oid, JSON.stringify(String(s.factory_email).split(/[,;\s]+/).filter(Boolean).slice(0, 1)),
       `采购单 ${dno} 需修改后重新提交`,
       `<p>您好，</p><p>采购单 <b>${esc(dno)}</b> 我们核对后需要贵司修改：</p>`
       + `<blockquote style="border-left:3px solid #D64541;padding-left:10px;color:#333">${esc(reason).replace(/\n/g, "<br>")}</blockquote>`
       + `<p>请用下面的链接打开同一张采购单，改好后点「保存并提交」：</p><p><a href="${link}">${link}</a></p>`
       + `<p>谢谢！<br>厦门巴匕进出口有限公司</p>`]);
    draftId = d.rows[0].id;
  }
  return res.json({ ok: true, draft_id: draftId });
}

// ── GET /file?sheet=ID&id=FILE_ID —— 工厂传的文件（回签合同等），⛔ 不走公开 /uploads，登录才能看
async function handleFile(req, res, pool) {
  if (!staffOnly(req, res)) return;
  const sid = parseInt(req.query?.sheet, 10), fid = parseInt(req.query?.id, 10);
  const f = (await pool.query(`SELECT file_name, file_url, mime FROM collab.po_file WHERE id=$1 AND sheet_id=$2`, [fid, sid])).rows[0];
  if (!f) return res.status(404).json({ ok: false, error: "没有这个文件" });
  const name = path.basename(String(f.file_url || ""));
  const full = path.join(UPLOAD_ROOT, String(sid), name);
  if (!full.startsWith(path.join(UPLOAD_ROOT, String(sid)) + path.sep)) return res.status(400).end();
  try {
    const buf = await fs.readFile(full);
    res.setHeader("Content-Type", f.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.file_name || name)}`);
    return res.end(buf);
  } catch { return res.status(404).json({ ok: false, error: "文件不在服务器上" }); }
}

// ── POST /seal-approve {stamp_id, approve, reason} —— 审核工厂上传的公章（仅内部管理员）
async function handleSealApprove(req, res, pool) {
  if (!staffOnly(req, res)) return;
  const id = parseInt(req.body?.stamp_id, 10);
  const approve = req.body?.approve === true;
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  const st = (await pool.query(`SELECT * FROM customer_stamps WHERE id=$1`, [id])).rows[0];
  if (!st || st.is_active || !/待审核/.test(st.name || "")) return res.status(409).json({ ok: false, error: "这枚公章不在待审核状态" });
  if (!approve && !reason) return res.status(400).json({ ok: false, error: "驳回请写原因" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (approve) {
      // 设为本厂默认章：同公司其它默认章让位（只改 is_default，不删不停用，可回退）
      await client.query(`UPDATE customer_stamps SET is_default=false WHERE company_code=$1 AND id<>$2 AND is_default`, [st.company_code, id]);
      await client.query(`UPDATE customer_stamps SET is_active=true, is_default=true,
                            name=replace(name,'待审核','已审核·'||$2) WHERE id=$1`, [id, who(req)]);
    } else {
      await client.query(`UPDATE customer_stamps SET name=replace(name,'待审核','已驳回：'||$2) WHERE id=$1`, [id, reason]);
    }
    await client.query(
      `UPDATE tasks SET status=$2, closed_at=NOW(), result_summary=$3, updated_at=NOW() WHERE id=$1`,
      [`seal-approve-${id}`, approve ? "done" : "done", approve ? `已通过，设为默认章（${who(req)}）` : `已驳回：${reason}（${who(req)}）`]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); return res.status(500).json({ ok: false, error: e.message }); }
  finally { client.release(); }
  return res.json({ ok: true, approved: approve });
}

export { handleReview, handleAdopt, handleReturn, handleFile, handleSealApprove };
