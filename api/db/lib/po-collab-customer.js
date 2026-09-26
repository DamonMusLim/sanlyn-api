// po-collab-customer.js — 订单协同 · 客户版（Proforma Invoice）
// Damon 0926：「客户的,还有贸易商的(巴匕)同一个模板,只不过主题不同而已」「不用预览,让客户直接看到.就是协同的那个表格..这一版叫订单协同」
//   工厂版（采购单协同，collab-po.html）= 巴匕买、工厂卖；客户版（本文件 + collab-order.html）= 巴匕卖、客户买。
//   客户登录后直接看协同表格：回签 PI（一键公章 / 上传签好的 PI）· 提修改申请 · 看付款信息 · 切换看本集团的订单。
//
// 🔴 隔离铁律：客户版任何响应里 ⛔ 不出现 工厂名/工厂公司/factory_price/factory_amount/order_no/佣金/加价/成本。
//    行明细价只给客户价（order_line_items.unit_price / subtotal）。快照 ours 里就不存工厂价，从源头断。
// 🔴 权限：客户账号（role=customer）且订单 company_code ∈ JWT companyCode ∪ companyCodes（集团账号，
//    Damon 0926「SEVEN SEAS 和 cn-00048 是一个集团的,他们可以都看到....跟petsome一样」）；或内部（isInternal）。
//    链接 token 只认 recipient_role='customer_order'，工厂链接打不开客户版，反之亦然。
// ⛔ 客户改的东西只进 collab.*（theirs / party_request），不写订单；采纳时只写 orders.customer_confirmed_at。

import fs from "node:fs/promises";
import path from "node:path";
import { requireAuth, extractUser } from "../../auth.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";
import { isInternal } from "./po-collab-handlers.js";
import { sealStatus } from "./po-collab-seal.js";
import { autoIssueCollabLinks } from "./collab-auto-links.js";
import { notifyRecipients, piTerms, REPLY_DAYS } from "./po-collab-customer-notify.js";

export const CROLE = "customer_order";
const LINK_DAYS = 14;
const UPLOAD_ROOT = "/opt/sanlyn-uploads/po-collab";
const SELLER_CODE = "BABI";                          // 客户版卖方 = 厦门巴匕（companies.code）
const LINE_WL = ["qty", "note"];                     // 客户能改的行字段
const REQ_WL = ["delivery", "marks", "remarks"];     // 客户能提的整单修改申请
const PAGE = "collab-order.html";

const ymd = (d) => (d ? new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null);
const codesOf = (u) => [u?.companyCode, u?.company_code, ...(Array.isArray(u?.companyCodes) ? u.companyCodes : [])].filter(Boolean);
const num = (v) => { if (v == null || String(v).trim() === "") return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

// ── 内部：建客户协同单 + 发客户链接 ─────────────────────────
export async function handleCustomerSendLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  if (!isInternal(req.user)) return res.status(403).json({ ok: false, error: "仅限内部管理员账号" });
  const { order_no } = req.body || {};
  if (!order_no) return res.status(400).json({ ok: false, error: "order_no 必填" });
  const o = (await pool.query(
    `SELECT o.id, o.order_no, o.company_code, c.id AS cid, COALESCE(c.name_en, o.customer, '') AS cname
       FROM orders o LEFT JOIN companies c ON c.code = o.company_code
      WHERE o.order_no = $1 AND COALESCE(o.status,'') NOT IN ('cancelled','voided','void','deleted') LIMIT 1`,
    [order_no])).rows[0];
  if (!o) return res.status(404).json({ ok: false, error: "找不到这一票" });
  if (!o.cid) return res.status(409).json({ ok: false, error: "这票没有对应的客户公司档案（orders.company_code）" });

  await pool.query(`UPDATE collab.po_sheet SET status='void', updated_at=NOW()
                     WHERE order_no=$1 AND side='customer' AND status NOT IN ('void','adopted')`, [order_no]);
  const sheetId = (await pool.query(
    `INSERT INTO collab.po_sheet (order_no, order_id, side, party_company_id, factory_name, status, sent_at, created_by, reply_due_at)
     VALUES ($1,$2,'customer',$3,$4,'sent',NOW(),$5, NOW() + make_interval(days => ${REPLY_DAYS})) RETURNING id`,
    [o.order_no, o.id, o.cid, o.cname, req.user?.username || "system"])).rows[0].id;
  // 快照 ours：⛔ 只存客户价，工厂价根本不进这张表
  await pool.query(
    `INSERT INTO collab.po_line (sheet_id, line_item_id, product_id, seq, product_name, ours)
     SELECT $1, li.id, li.product_id, row_number() OVER (ORDER BY li.id),
            COALESCE(NULLIF(li.product_name,''), p.product_name, ''),
            jsonb_strip_nulls(jsonb_build_object(
              'qty', li.qty_ctn, 'price', li.unit_price, 'amount', li.subtotal,
              'pack', p.bg_bx, 'barcode', NULLIF(p.barcode,'')))
       FROM order_line_items li LEFT JOIN products p ON p.id = li.product_id
      WHERE li.order_id = $2`, [sheetId, o.id]);
  await pool.query(`UPDATE magic_links SET revoked_at=NOW()
                     WHERE recipient_role=$1 AND (meta->>'order_no')=$2 AND revoked_at IS NULL`, [CROLE, order_no]);
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1,$2,$3,NOW() + ($4 || ' days')::interval,'[]'::jsonb,NOW())`,
    [rawToHash(raw), CROLE, JSON.stringify({ order_no, sheet_id: sheetId, side: "customer", party_company_id: o.cid }), String(LINK_DAYS)]);
  return res.json({ ok: true, sheet_id: sheetId, side: "customer", customer: o.cname,
                    magic_link: `${process.env.ORDER_COLLAB_BASE || `${APP_BASE}/oc`}?c=${raw}`, expires_days: LINK_DAYS });
}

// ── token → 客户协同单（切换：只能切到别的客户版单；是不是本集团由 customerGate 判）
export async function resolveCustomerToken(pool, raw, wantSheet) {
  if (!raw) return { err: "Link is missing" };
  const r = await pool.query(
    `SELECT meta FROM magic_links WHERE token_hash=$1 AND recipient_role=$2 AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [rawToHash(raw), CROLE]);
  if (!r.rows.length) return { err: "This link is invalid or has expired. Please contact us for a new one." };
  const sid = parseInt(wantSheet, 10) || parseInt(r.rows[0].meta?.sheet_id, 10);
  const s = await pool.query(`SELECT * FROM collab.po_sheet WHERE id=$1 AND side='customer' AND status<>'void' LIMIT 1`, [sid]);
  if (!s.rows.length) return { err: "This order is not available." };
  return { sheet: s.rows[0] };
}

// 这张 token 是不是客户版的（路由用来分派）
export async function isCustomerToken(pool, raw) {
  if (!raw) return false;
  const r = await pool.query(`SELECT 1 FROM magic_links WHERE token_hash=$1 AND recipient_role=$2 LIMIT 1`, [rawToHash(raw), CROLE]);
  return r.rows.length > 0;
}

// ── 登录闸：客户账号必须属于这张单的客户（含集团成员）；内部放行 ──
export async function customerGate(req, res, pool, sheet) {
  const h = req.headers.authorization || "";
  const u = h.startsWith("Bearer ") ? extractUser(req) : null;
  if (!u) { res.status(401).json({ ok: false, valid: false, need_login: true, error: "Please log in with your company account." }); return false; }
  if (isInternal(u)) return true;
  if (String(u.role || "").toLowerCase() !== "customer") {
    res.status(403).json({ ok: false, valid: false, need_login: true, forbidden: true, error: "This account cannot view this order. Please log in with your company account." });
    return false;
  }
  const code = (await pool.query(`SELECT company_code FROM orders WHERE order_no=$1`, [sheet.order_no])).rows[0]?.company_code;
  if (code && codesOf(u).includes(code)) return true;
  res.status(403).json({ ok: false, valid: false, need_login: true, forbidden: true, error: "This order does not belong to your company account." });
  return false;
}

// ── 客户：打开页面 ─────────────────────────────────────────
export async function handleCustomerValidate(req, res, pool) {
  const { sheet, err } = await resolveCustomerToken(pool, req.query?.token, req.query?.sheet);
  if (err) return res.status(200).json({ valid: false, error: err });
  if (!(await customerGate(req, res, pool, sheet))) return;
  if (!sheet.opened_at) {
    await pool.query(`UPDATE collab.po_sheet SET opened_at=NOW(), status=CASE WHEN status='sent' THEN 'opened' ELSE status END, updated_at=NOW() WHERE id=$1`, [sheet.id]);
    await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'opened','customer',$2,'{}'::jsonb)`,
      [sheet.id, clip(req.user?.username, 60)]);
  }
  const o = (await pool.query(
    `SELECT order_date, pi_no, contract_no, currency, trade_terms, destination_port, payment_terms, payment_schedule,
            payment_terms_days, confirmed_delivery, marks, shipping_plan_id, company_code
       FROM orders WHERE order_no=$1 LIMIT 1`, [sheet.order_no])).rows[0] || {};
  const comp = async (code) => (await pool.query(
    `SELECT name_en, COALESCE(NULLIF(address_en,''), address) AS address, tax_id, registration_no, country
       FROM companies WHERE code=$1 LIMIT 1`, [code])).rows[0] || null;
  const payee = (await pool.query(
    `SELECT account_holder, bank_name_en, account_no, swift, bank_address, currency
       FROM bank_accounts WHERE company_code=$1 AND currency=$2 AND active ORDER BY is_default DESC LIMIT 1`,
    [SELLER_CODE, o.currency || "USD"])).rows[0] || null;
  const lines = (await pool.query(
    `SELECT l.id, l.seq, l.product_name, l.ours, l.theirs,
            COALESCE(NULLIF(p.image_url,''), NULLIF(p.images->>0,'')) AS image_url
       FROM collab.po_line l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.sheet_id=$1 ORDER BY l.seq`, [sheet.id])).rows;
  const hist = (await pool.query(
    `SELECT seq, field, old_val, new_val, COALESCE(NULLIF(actor_name,''), '—') AS who, actor_side, created_at
       FROM collab.po_line_history WHERE sheet_id=$1 ORDER BY created_at DESC LIMIT 200`, [sheet.id])).rows;
  // 切换看历史：本账号能看的所有公司（集团）的客户版单；内部人只列这家客户的
  const codes = isInternal(req.user) ? [o.company_code] : codesOf(req.user);
  const siblings = (await pool.query(
    `SELECT s.id, s.status, s.sent_at, s.adopted_at,
            COALESCE(NULLIF(od.pi_no,''), NULLIF(od.contract_no,''), 'Order #' || s.id) AS no,
            od.total_qty, c.name_en AS company
       FROM collab.po_sheet s JOIN orders od ON od.order_no = s.order_no
       LEFT JOIN companies c ON c.code = od.company_code
      WHERE s.side='customer' AND s.status<>'void' AND od.company_code = ANY($1)
      ORDER BY s.sent_at DESC NULLS LAST, s.id DESC LIMIT 100`, [codes])).rows;
  const contract = (await pool.query(
    `SELECT file_name, created_at FROM collab.po_file WHERE sheet_id=$1 AND kind='signed_back' ORDER BY created_at DESC LIMIT 1`,
    [sheet.id])).rows[0] || null;
  const returned = sheet.status === "returned" ? (await pool.query(
    `SELECT detail->>'reason' AS r FROM collab.po_event WHERE sheet_id=$1 AND kind='returned' ORDER BY created_at DESC LIMIT 1`,
    [sheet.id])).rows[0]?.r || null : null;
  return res.json({
    valid: true, role: CROLE,
    sheet: {
      id: sheet.id, side: "customer", status: sheet.status,
      display_no: o.pi_no || o.contract_no || "", order_date: ymd(o.order_date),
      currency: o.currency || null, trade_terms: o.trade_terms || null, destination_port: o.destination_port || null,
      payment: { terms: o.payment_terms || null, schedule: o.payment_schedule || null, days: o.payment_terms_days ?? null },
      confirmed_delivery: ymd(o.confirmed_delivery), marks: o.marks || null,
      request: sheet.party_request || {}, submitted_at: sheet.submitted_at, adopted_at: sheet.adopted_at,
      return_reason: returned, contract_file: contract,
      seal: await sealStatus(pool, sheet.party_company_id),
      seller: await comp(SELLER_CODE), buyer: await comp(o.company_code), payee,
      shipment: { available: !!o.shipping_plan_id },
      reply_due_at: sheet.reply_due_at || null, deemed_at: sheet.deemed_at || null, reply_days: REPLY_DAYS,
      terms: piTerms(o, sheet.reply_due_at),
      notify: await notifyRecipients(pool, sheet.party_company_id),
      siblings,
    },
    lines, history: hist,
  });
}

// ── 客户：提交修改申请（数量/备注 + 要求交期/唛头/备注）──────────
export async function handleCustomerSubmit(req, res, pool) {
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });
  if (!(await customerGate(req, res, pool, sheet))) return;
  if (sheet.status === "adopted") return res.status(409).json({ ok: false, error: "This order has already been confirmed by us. Please contact us for changes." });
  const actor = clip(req.body?.contact_name || req.user?.username, 40);
  let changed = 0;
  const cur = (await pool.query(`SELECT id, seq, ours, theirs FROM collab.po_line WHERE sheet_id=$1`, [sheet.id])).rows;
  const byId = Object.fromEntries(cur.map(l => [String(l.id), l]));
  for (const inl of Array.isArray(req.body?.lines) ? req.body.lines : []) {
    const l = byId[String(inl?.id)]; if (!l) continue;
    const theirs = { ...(l.theirs || {}) };
    for (const k of LINE_WL) {
      if (!(k in inl)) continue;
      let v = k === "qty" ? num(inl[k]) : clip(String(inl[k] ?? "").trim(), 300);
      if (k === "qty" && v != null && (v < 0 || v > 1e7)) continue;
      if (v === "" ) v = null;
      const before = theirs[k] ?? l.ours?.[k] ?? null;
      if (String(before ?? "") === String(v ?? "")) continue;
      // 改回我们原来的值 = 撤回这条申请（不再标成客户改过）
      if (v == null || String(v) === String(l.ours?.[k] ?? "")) delete theirs[k]; else theirs[k] = v;
      await pool.query(
        `INSERT INTO collab.po_line_history (sheet_id, line_id, seq, field, old_val, new_val, actor_side, actor_name)
         VALUES ($1,$2,$3,$4,$5,$6,'customer',$7)`,
        [sheet.id, l.id, l.seq, k, before == null ? null : String(before), v == null ? null : String(v), actor]);
      changed++;
    }
    await pool.query(`UPDATE collab.po_line SET theirs=$2::jsonb, updated_at=NOW() WHERE id=$1`, [l.id, JSON.stringify(theirs)]);
  }
  const reqIn = req.body?.request || {};
  const request = { ...(sheet.party_request || {}) };
  for (const k of REQ_WL) {
    if (!(k in reqIn)) continue;
    const v = k === "delivery" ? (/^\d{4}-\d{2}-\d{2}$/.test(String(reqIn[k] || "")) ? String(reqIn[k]) : null) : clip(String(reqIn[k] ?? "").trim(), 1000) || null;
    if (String(request[k] ?? "") === String(v ?? "")) continue;
    await pool.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'request_changed','customer',$2,$3::jsonb)`,
      [sheet.id, actor, JSON.stringify({ field: k, from: request[k] ?? null, to: v })]);
    if (v == null) delete request[k]; else request[k] = v;
    changed++;
  }
  await pool.query(
    `UPDATE collab.po_sheet SET party_request=$2::jsonb, submitted_at=NOW(), last_edit_by=$3, last_edit_at=NOW(),
            status=CASE WHEN status IN ('sent','opened','returned') THEN 'submitted' ELSE status END, updated_at=NOW()
      WHERE id=$1`, [sheet.id, JSON.stringify(request), actor]);
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'submitted','customer',$2,$3::jsonb)`,
    [sheet.id, actor, JSON.stringify({ changed })]);
  const status = await maybeCustomerConfirm(pool, sheet.id);
  if (status === "confirmed") await upsertPiTask(pool, sheet.id);   // 已回签后又改：任务提示先处理修改申请
  return res.json({ ok: true, status, changed });
}

// ── 客户：上传签好的 PI（PDF / 图片）──────────────────────────
export async function handleCustomerUpload(req, res, pool) {
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });
  if (!(await customerGate(req, res, pool, sheet))) return;
  if (sheet.status === "adopted") return res.status(409).json({ ok: false, error: "This order has already been confirmed by us." });
  const { filename, mime, data_base64 } = req.body || {};
  if (!/^(application\/pdf|image\/(png|jpe?g))$/i.test(String(mime || ""))) return res.status(400).json({ ok: false, error: "Please upload a PDF, PNG or JPG file." });
  let buf; try { buf = Buffer.from(String(data_base64 || ""), "base64"); } catch { buf = null; }
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: "The file is empty." });
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: "The file must be 8 MB or smaller." });
  const ext = /pdf/i.test(mime) ? "pdf" : /png/i.test(mime) ? "png" : "jpg";
  const dir = path.join(UPLOAD_ROOT, String(sheet.id));
  await fs.mkdir(dir, { recursive: true });
  const name = `${Date.now()}_signed-PI.${ext}`;
  await fs.writeFile(path.join(dir, name), buf);
  await pool.query(
    `INSERT INTO collab.po_file (sheet_id, kind, file_name, file_url, mime, size_bytes) VALUES ($1,'signed_back',$2,$3,$4,$5)`,
    [sheet.id, clip(filename, 120) || `Signed PI.${ext}`, `/uploads/po-collab/${sheet.id}/${name}`, mime, buf.length]);
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'uploaded','customer',$2,$3::jsonb)`,
    [sheet.id, clip(req.user?.username, 60), JSON.stringify({ kind: "signed_back", file: clip(filename, 120) })]);
  return res.json({ ok: true, status: await maybeCustomerConfirm(pool, sheet.id) });
}

// 盖章/公章上传/PDF 复用 po-collab-seal.js，只把「谁家的章、谁能操作、渲染哪个页面」换成客户版
export const CUSTOMER_SEAL_OPTS = (sheet) => ({
  companyId: sheet.party_company_id, party: sheet.factory_name, roles: ["customer"], requireSubmitted: false,
  page: PAGE, docName: "PI", actorSide: "customer",
  msg: { role: "Only your company account can confirm with your company seal.", adopted: "This order has already been confirmed by us.",
         noStamp: "Your company seal is not registered with us yet. Please upload a signed PI instead.", noSpot: "Cannot find the seal position on the PI." },
});
export const CUSTOMER_SEAL_UPLOAD_OPTS = (sheet) => ({
  companyId: sheet.party_company_id, party: sheet.factory_name, roles: ["customer"], actorSide: "customer", who: "客户",
  roleMsg: "Only your company account can upload your company seal.",
});
export const CUSTOMER_PDF_OPTS = { page: PAGE, fileName: "PI" };

// ── 回签闭环：有签好的 PI（盖章或上传）→ confirmed → 给艾莎建任务（九步 SOP 第 4 步）──
export async function maybeCustomerConfirm(pool, sheetId) {
  const s = (await pool.query(
    `SELECT s.status, EXISTS (SELECT 1 FROM collab.po_file f WHERE f.sheet_id=s.id AND f.kind='signed_back') AS signed
       FROM collab.po_sheet s WHERE s.id=$1`, [sheetId])).rows[0];
  if (!s || ["confirmed", "adopted", "void"].includes(s.status) || !s.signed) return s?.status || null;
  await pool.query(`UPDATE collab.po_sheet SET status='confirmed', updated_at=NOW() WHERE id=$1`, [sheetId]);
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, detail) VALUES ($1,'confirmed','customer','{"step":4}'::jsonb)`, [sheetId]);
  try { await upsertPiTask(pool, sheetId); } catch (e) { console.error("[order-collab] 建任务失败(不影响客户回签):", e.message); }
  return "confirmed";
}

async function upsertPiTask(pool, sheetId) {
  const t = (await pool.query(
    `SELECT s.id, s.order_no, s.factory_name AS customer, s.party_request, o.pi_no, o.contract_no,
            (SELECT COUNT(*) FROM collab.po_line_history h WHERE h.sheet_id=s.id AND h.actor_side='customer') AS line_changes
       FROM collab.po_sheet s LEFT JOIN orders o ON o.order_no=s.order_no WHERE s.id=$1`, [sheetId])).rows[0];
  if (!t) return;
  const no = t.pi_no || t.contract_no || `客户协同单#${t.id}`;
  const reqN = Object.keys(t.party_request || {}).length, lineN = Number(t.line_changes) || 0;
  const hasAsk = reqN + lineN > 0;
  const deepLink = (process.env.PO_REVIEW_BASE || `${APP_BASE}/po-review?sheet=`) + t.id;
  const raw = {
    task_class: "业务", subclass: "客户回签PI审核", canonical_domain: "order", owner: "WM-01 艾莎", reviewer: "D-00",
    deep_link: deepLink, severity: "P2", dedupe_key: `order:pi_confirm:${t.order_no}`, sop_step: 4, sheet_id: t.id,
    event: `${t.customer}已回签 PI ${no}${hasAsk ? `，另提了修改申请（行 ${lineN} 处 / 整单 ${reqN} 项）` : ""} → 审核后给工厂发开工通知`,
    facts: `客户协同单#${t.id} · 回签已上传 · 修改申请 ${lineN + reqN} 处`,
  };
  await pool.query(
    `INSERT INTO tasks (id, title, task_type, level, status, domain, priority, assigned_staff_no, related_order_no, source,
                        dedupe_key, due_at, reason, next_action, raw, created_at, updated_at)
     VALUES ($1,$2,'客户回签PI审核','L3','open','外贸','p1','WM-01',$3,'order-collab',$4,NOW()+interval '1 day',$5,$6,$7::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET status='open', title=EXCLUDED.title, reason=EXCLUDED.reason, next_action=EXCLUDED.next_action,
       raw=COALESCE(tasks.raw,'{}'::jsonb) || EXCLUDED.raw, updated_at=NOW()`,
    [`pi-confirm-${t.id}`, `${t.customer}已回签 PI ${no} → 审核后给工厂发开工通知`.slice(0, 100), t.order_no, raw.dedupe_key, raw.facts,
     hasAsk ? "①先处理客户修改申请（审核页逐条看）②采纳（记客户确认时间）③第4步：给工厂发开工通知"
            : "①打开审核页看客户回签的 PI ②采纳（记客户确认时间）③第4步：给工厂发开工通知",
     JSON.stringify(raw)]);
}

// ── 发货协同入口：订单已挂订舱计划才给入口；点了走现成的签发 helper（与自动协同同一套：撤旧链 + 写 shipping_plans.customer_token）
// GPT 0926 复核：原来每点一次就插一条新 customer_booking 链，不复用、不撤旧 = 同一票可能挂无限条有效链接
export async function handleCustomerShipmentLink(req, res, pool) {
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });
  if (!(await customerGate(req, res, pool, sheet))) return;
  const p = (await pool.query(
    `SELECT sp.id FROM orders o JOIN shipping_plans sp ON sp.id = o.shipping_plan_id WHERE o.order_no=$1 LIMIT 1`,
    [sheet.order_no])).rows[0];
  if (!p) return res.status(404).json({ ok: false, error: "Shipment collaboration opens after booking." });
  const issued = (await autoIssueCollabLinks(pool, p.id, ["customer"])) || [];
  const link = issued.find(x => x && x.recipient_role === "customer_booking");
  if (!link?.url) return res.status(502).json({ ok: false, error: "Shipment collaboration is not available yet." });
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'shipment_link','customer',$2,$3::jsonb)`,
    [sheet.id, clip(req.user?.username, 60), JSON.stringify({ shipment_id: p.id })]);
  return res.json({ ok: true, url: link.url });
}

// ── 我方审核（review.js 按 side 分派过来）───────────────────
export async function customerReview(req, res, pool, s) {
  const lines = (await pool.query(`SELECT id, seq, product_name, ours, theirs FROM collab.po_line WHERE sheet_id=$1 ORDER BY seq`, [s.id])).rows;
  const hist = (await pool.query(
    `SELECT seq, field, old_val, new_val, COALESCE(NULLIF(actor_name,''), actor_org) AS who, actor_side, created_at
       FROM collab.po_line_history WHERE sheet_id=$1 ORDER BY created_at`, [s.id])).rows;
  const files = (await pool.query(`SELECT id, kind, file_name, created_at FROM collab.po_file WHERE sheet_id=$1 ORDER BY created_at DESC`, [s.id])).rows;
  const evts = (await pool.query(
    `SELECT kind, actor_side, COALESCE(NULLIF(actor_name,''), actor_org) AS who, detail, created_at
       FROM collab.po_event WHERE sheet_id=$1 ORDER BY created_at DESC LIMIT 50`, [s.id])).rows;
  const task = (await pool.query(`SELECT id, status, progress_label FROM tasks WHERE id=$1`, [`pi-confirm-${s.id}`])).rows[0] || null;
  const pendingSeal = (await pool.query(
    `SELECT cs.id, cs.url, cs.username, cs.uploaded_at FROM customer_stamps cs JOIN companies c ON c.code = cs.company_code
      WHERE c.id=$1 AND NOT cs.is_active AND cs.name LIKE '%待审核%' ORDER BY cs.uploaded_at DESC LIMIT 1`, [s.party_company_id])).rows[0] || null;
  return res.json({
    ok: true,
    sheet: { id: s.id, side: "customer", order_no: s.order_no, status: s.status, customer: s.factory_name,
             display_no: s.pi_no || s.contract_no || "", request: s.party_request || {},
             submitted_at: s.submitted_at, adopted_at: s.adopted_at, adopted_by: s.adopted_by,
             order_now: { customer_confirmed_at: s.customer_confirmed_at } },
    lines, history: hist, files, events: evts, task, pending_seal: pendingSeal,
  });
}

export async function customerAdopt(req, res, pool, s, who) {
  if (s.status !== "confirmed") return res.status(409).json({ ok: false, error: `这张单现在是「${s.status}」，客户回签 PI 后才能采纳` });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = (await client.query(`SELECT customer_confirmed_at FROM orders WHERE id=$1 FOR UPDATE`, [s.oid])).rows[0] || {};
    await client.query(`UPDATE orders SET customer_confirmed_at=NOW() WHERE id=$1`, [s.oid]);
    await client.query(`UPDATE collab.po_sheet SET status='adopted', adopted_at=NOW(), adopted_by=$2, updated_at=NOW() WHERE id=$1`, [s.id, who]);
    await client.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'adopted','sanlyn',$2,$3::jsonb)`,
      [s.id, who, JSON.stringify({ order_before: before, customer_request: s.party_request || {} })]);
    await client.query(
      `UPDATE tasks SET progress_label='已采纳 → 第4步：给工厂发开工通知',
              title=left(regexp_replace(title, '→ 审核后给工厂发开工通知$', '→ 已采纳·待发开工通知'), 100),
              next_action='给工厂发开工通知（客户修改申请如有，已在订单里人工改好再发）', updated_at=NOW() WHERE id=$1`,
      [`pi-confirm-${s.id}`]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  // ⛔ 客户申请改的数量/交期/唛头不自动写回订单：审核页列清楚，人工在订单里改
  return res.json({ ok: true, qty_diffs: 0, product_changes: 0, customer_confirmed: true });
}

export async function customerReturn(req, res, pool, s, who, reason) {
  await pool.query(`UPDATE collab.po_sheet SET status='returned', updated_at=NOW() WHERE id=$1`, [s.id]);
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'returned','sanlyn',$2,$3::jsonb)`,
    [s.id, who, JSON.stringify({ reason })]);
  await pool.query(`UPDATE tasks SET progress_label='已退回客户修改', updated_at=NOW() WHERE id=$1`, [`pi-confirm-${s.id}`]);
  // 客户版不自动起草邮件：客户登录就能在页面上看到退回原因；要通知由人工在发件台写
  return res.json({ ok: true, draft_id: null });
}
