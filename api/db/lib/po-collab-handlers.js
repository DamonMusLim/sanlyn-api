// po-collab-handlers.js — 采购单协同（Damon 0918 定的九步 SOP 第 1 步）
//
// ⛔ 底层不动：orders / products / order_line_items 一个字段都不写。
//    工厂填的东西全落 collab.* ，Damon 采纳后才由人工/skill 写回真源（0624 定）。
// ⛔ 工厂用的是 magic_links 受限 token（recipient_role='factory_po'），
//    ⛔ 绝不是内部 JWT —— 内部 JWT 给工厂等于给管理员权限。
//
// 端点：
//   POST /send-link   内部：建协同单 + 签发工厂链接
//   GET  /validate    工厂：校验 token，返回采购单 + 缺什么 + 条款 + 下载包
//   POST /submit      工厂：提交回填（价格/箱规/条码/HS建议/交货日/开户行）
//   POST /upload      工厂：传文件（产品图 / QC报告 / 自己的合同模板）

import { requireAuth, extractUser } from "../../auth.js";
import { sealStatus } from "./po-collab-seal.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";

const ROLE = "factory_po";
// 🔴 白名单（0926 部署会话复核抓到：原来是「外部角色黑名单、其余当内部放行」，
//    logistics(9个货代)/trader/petstore/staff/disabled 都会被当成内部员工直接放行）
const INTERNAL_ROLES = ["admin"];                 // 只有这些不查公司
// 按账号 id 单独放行的内部人（不按角色放，免得同角色的别人跟着进来）：91 = damon（Damon 本人，role=petstore）
const INTERNAL_UIDS = [91];
const isInternal = (u) => INTERNAL_ROLES.includes(String(u?.role || "").toLowerCase()) || INTERNAL_UIDS.includes(Number(u?.uid));
const FACTORY_ROLES = ["factory", "supplier"];    // 这些必须 companyCode 命中本单工厂
const LINK_DAYS = 14; // 工厂链接有效期。⚠️ booking 那套给 7 天，结果 217 条全过期没人用，这里放宽

// 工厂能改的字段白名单。⛔ 只认这些 key，别的一律丢弃
const FIELD_WL = ["qty", "pbag", "cprice", "barcode", "box_l", "box_w", "box_h",
                  "carton_qty", "gw_ctn", "nw_ctn", "cbm_ctn", "hs_code", "note"];

// ── 内部：建协同单 + 发链接 ────────────────────────────────
async function handleSendLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  // 🔴 只有内部管理员能签发工厂链接（0926 部署会话复核：原来任何登录账号——客户/工厂/货代——都能给任意订单签链接读数据）
  if (!isInternal(req.user))
    return res.status(403).json({ ok: false, error: "仅限内部管理员账号" });
  const { order_no, qc_required } = req.body || {};
  if (!order_no) return res.status(400).json({ ok: false, error: "order_no 必填" });

  const ord = await pool.query(
    `SELECT o.id, o.order_no, o.factory_company_id,
            COALESCE(c.name_cn, o.factory, '') AS factory_name
       FROM orders o
       LEFT JOIN companies c ON c.id = o.factory_company_id
      WHERE o.order_no = $1
        AND COALESCE(o.status,'') NOT IN ('cancelled','voided','void','deleted')
      LIMIT 1`, [order_no]);
  if (!ord.rows.length) return res.status(404).json({ ok: false, error: "找不到这一票" });
  const o = ord.rows[0];

  // 同一票只留一张活的协同单，旧的作废
  await pool.query(
    `UPDATE collab.po_sheet SET status='void', updated_at=NOW()
      WHERE order_no=$1 AND side='factory' AND status NOT IN ('void','adopted')`, [order_no]);   // ⛔ 只作废工厂那张，别碰客户版

  const sheet = await pool.query(
    `INSERT INTO collab.po_sheet
       (order_no, order_id, factory_company_id, factory_name, status, sent_at,
        qc_required, created_by)
     VALUES ($1,$2,$3,$4,'sent',NOW(),$5,$6)
     RETURNING id`,
    [o.order_no, o.id, o.factory_company_id, o.factory_name,
     qc_required === true, req.user?.username || "system"]);
  const sheetId = sheet.rows[0].id;

  // 明细快照：ours 是我们发出去的原值，⛔ 之后永不改动
  await pool.query(
    `INSERT INTO collab.po_line (sheet_id, line_item_id, product_id, seq, product_name, ours)
     SELECT $1, li.id, li.product_id,
            row_number() OVER (ORDER BY li.id),
            COALESCE(li.product_name, p.product_name_cn, p.product_name, ''),
            jsonb_strip_nulls(jsonb_build_object(
              'qty',        li.qty_ctn,
              'pbag',       li.factory_price,
              'cprice',     li.factory_price,
              'barcode',    NULLIF(p.barcode,''),
              'box_l',      p.box_l, 'box_w', p.box_w, 'box_h', p.box_h,
              'carton_qty', p.carton_qty,
              'gw_ctn',     li.gw_ctn, 'nw_ctn', li.nw_ctn, 'cbm_ctn', li.cbm_ctn,
              'hs_code',    NULLIF(p.hs_code,'')
            ))
       FROM order_line_items li
       LEFT JOIN products p ON p.id = li.product_id
      WHERE li.order_id = $2`, [sheetId, o.id]);

  // 撤掉这家工厂这一票的旧链接
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = $1 AND (meta->>'order_no') = $2 AND revoked_at IS NULL`,
    [ROLE, order_no]);

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval, '[]'::jsonb, NOW())`,
    [rawToHash(raw), ROLE,
     JSON.stringify({ order_no, sheet_id: sheetId, factory_company_id: o.factory_company_id }),
     String(LINK_DAYS)]);

  return res.json({
    ok: true, sheet_id: sheetId, factory: o.factory_name,
    magic_link: `${APP_BASE}/po?c=${raw}`,
    expires_days: LINK_DAYS,
  });
}

// ── token → sheet（工厂侧统一入口，⛔ 不接受任何内部 JWT）────
// ── 工厂登录闸（Damon 0926：链接之外还要登录）──────────────
// 链接(magic token)决定看哪张单；登录决定是谁。工厂账号必须属于本单工厂（companyCode/companyCodes 命中），
// 内部员工账号放行（预览/代办）。⛔ 只认 Authorization 头，不认 ?token=（那是协同链接的 token）
async function factoryGate(req, res, pool, sheet) {
  const h = req.headers.authorization || "";
  const u = h.startsWith("Bearer ") ? extractUser(req) : null;
  if (!u) { res.status(401).json({ ok: false, valid: false, need_login: true, error: "请先登录贵司账号" }); return false; }
  const role = String(u.role || "").toLowerCase();
  if (isInternal(u)) return true;
  if (!FACTORY_ROLES.includes(role)) {
    res.status(403).json({ ok: false, valid: false, need_login: true, forbidden: true, error: "当前登录的账号不能查看这张采购单，请用贵司工厂账号登录" });
    return false;
  }
  const code = (await pool.query(`SELECT code FROM companies WHERE id=$1`, [sheet.factory_company_id])).rows[0]?.code;
  const codes = [u.companyCode, ...(Array.isArray(u.companyCodes) ? u.companyCodes : [])].filter(Boolean);
  if (code && codes.includes(code)) return true;
  res.status(403).json({ ok: false, valid: false, need_login: true, forbidden: true, error: "当前登录的账号不属于本单工厂，请用贵司工厂账号登录" });
  return false;
}

// 切换采购单（Damon 0926「可以切换看到订单」）：同一家工厂的链接可以看本厂其它协同单；⛔ 别家工厂的一律拒
async function resolveToken(pool, raw, wantSheet) {
  if (!raw) return { err: "token 缺失" };
  const r = await pool.query(
    `SELECT meta, expires_at FROM magic_links
      WHERE token_hash = $1 AND recipient_role = $2
        AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1`, [rawToHash(raw), ROLE]);
  if (!r.rows.length) return { err: "链接无效或已过期，请联系我们重新发送" };
  const meta = r.rows[0].meta || {};
  if (!meta.sheet_id) return { err: "链接数据不完整" };
  const s = await pool.query(
    `SELECT * FROM collab.po_sheet WHERE id = $1 AND side = 'factory' AND status <> 'void' LIMIT 1`, [meta.sheet_id]);
  if (!s.rows.length) return { err: "这张协同单已作废" };
  const want = parseInt(wantSheet, 10);
  if (want && want !== Number(s.rows[0].id)) {
    const o = await pool.query(
      `SELECT * FROM collab.po_sheet WHERE id = $1 AND factory_company_id = $2 AND side = 'factory' AND status <> 'void' LIMIT 1`,
      [want, s.rows[0].factory_company_id]);
    if (!o.rows.length) return { err: "这张采购单不在贵司名下，或已作废" };
    return { sheet: o.rows[0] };
  }
  return { sheet: s.rows[0] };
}

// ── SOP 第 2 步「工厂回签确认」闭环（Damon 0925）───────────
// 判据：已提交 + 交货期已填 + 回签合同(signed_back)已上传。三样齐了才算这一步闭上，
// 状态改 confirmed、记一条事件；⛔ 不写 orders（采纳/回写 orders 是我方审核那一步的事）
async function maybeConfirm(pool, sheetId, rawToken) {
  const r = await pool.query(
    `SELECT s.id, s.status, s.submitted_at, s.factory_delivery_date,
            EXISTS (SELECT 1 FROM collab.po_file f WHERE f.sheet_id = s.id AND f.kind = 'signed_back') AS has_contract
       FROM collab.po_sheet s WHERE s.id = $1`, [sheetId]);
  const s = r.rows[0];
  if (!s || ["confirmed", "adopted", "void"].includes(s.status)) return s?.status || null;
  if (!s.submitted_at || !s.factory_delivery_date || !s.has_contract) return s.status;
  await pool.query(`UPDATE collab.po_sheet SET status='confirmed', updated_at=NOW() WHERE id=$1`, [sheetId]);
  try { await createReviewTask(pool, sheetId, rawToken); }
  catch (e) { console.error("[po-collab] 建审核任务失败(不影响工厂确认):", e.message); }
  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, detail)
     VALUES ($1,'confirmed','factory',$2::jsonb)`,
    [sheetId, JSON.stringify({ step: 2, delivery_date: s.factory_delivery_date })]);
  return "confirmed";
}

// ── 第 2 步闭上 → 给艾莎(WM-01)建任务：审核工厂回签 → 采纳 → 第 3 步发 PI（Damon 0925 定归属+顺序）
// 按「创建任务知识指南」10 字段；deep_link 指向这一票的采购单（能打开能看，不是大厅）
// ⛔ 只建任务不推送：推送要先在信芸那登记 owner+reviewer，首跑先观察
async function createReviewTask(pool, sheetId, rawToken) {
  const r = await pool.query(
    `SELECT s.id, s.order_no, s.factory_name, s.factory_delivery_date,
            o.customer, o.customer_po, o.contract_no,
            (SELECT file_name FROM collab.po_file f WHERE f.sheet_id=s.id AND f.kind='signed_back'
              ORDER BY created_at DESC LIMIT 1) AS contract_file,
            (SELECT COUNT(*) FROM collab.po_line_history h WHERE h.sheet_id=s.id) AS changed_n
       FROM collab.po_sheet s LEFT JOIN orders o ON o.order_no = s.order_no
      WHERE s.id=$1`, [sheetId]);
  const t = r.rows[0]; if (!t) return;
  const dno = t.contract_no || t.customer_po || `协同单#${t.id}`;
  const dd = t.factory_delivery_date ? new Date(new Date(t.factory_delivery_date).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : "?";
  // 深链 = 我方审核页（要登录），不是工厂那张免登录链接
  const deepLink = (process.env.PO_REVIEW_BASE || `${APP_BASE}/po-review?sheet=`) + t.id;
  const event = `${t.factory_name}已回签采购单 ${dno}（交货 ${dd}，合同已上传）→ 请审核工厂改动并采纳，然后第3步给 ${t.customer || "客户"} 发正式 PI`;
  const facts = `协同单#${t.id} · 交货期 ${dd} · 回签合同「${t.contract_file || "?"}」· 工厂改动 ${t.changed_n} 处`;
  const due = new Date(Date.now() + 24 * 3600e3);
  const raw = {
    task_class: "业务", subclass: "采购单回签审核", canonical_domain: "order",
    owner: "WM-01 艾莎", reviewer: "D-00", deep_link: deepLink, event, facts,
    severity: "P2", dedupe_key: `order:po_confirm:${t.order_no}`, deadline: due.toISOString(),
    sop_step: 2, next_sop_step: 3, sheet_id: t.id,
  };
  await pool.query(
    `INSERT INTO tasks (id, title, task_type, level, status, domain, priority, assigned_staff_no,
                        related_order_no, source, dedupe_key, due_at, reason, next_action, raw,
                        created_at, updated_at)
     VALUES ($1,$2,'采购单回签审核','L3','open','外贸','p1','WM-01',$3,'po-collab',$4,$5,$6,$7,$8::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET status='open', progress_label='工厂已重新提交 · 待审核', title=EXCLUDED.title,
       reason=EXCLUDED.reason, raw=COALESCE(tasks.raw,'{}'::jsonb) || EXCLUDED.raw, updated_at=NOW()`,
    [`po-confirm-${t.id}`, `${t.factory_name}回签 ${dno}（交货 ${dd}）→ 审核采纳后发PI`.slice(0, 100), t.order_no, raw.dedupe_key, due, facts,
     "①打开采购单看工厂改了什么和回签合同 ②采纳（回写确认交期/工厂确认时间）③第3步：给客户发正式 PI",
     JSON.stringify(raw)]);
}

// ── 工厂：打开页面 ────────────────────────────────────────
async function handleValidate(req, res, pool) {
  const { sheet, err } = await resolveToken(pool, req.query?.token, req.query?.sheet);
  if (err) return res.status(200).json({ valid: false, error: err });
  if (!(await factoryGate(req, res, pool, sheet))) return;

  if (!sheet.opened_at) {
    await pool.query(`UPDATE collab.po_sheet SET opened_at=NOW(), status=CASE WHEN status='sent' THEN 'opened' ELSE status END, updated_at=NOW() WHERE id=$1`, [sheet.id]);
    await pool.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_org, ip, ua)
       VALUES ($1,'opened','factory',$2,$3,$4)`,
      [sheet.id, sheet.factory_name,
       (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').toString().slice(0,60),
       (req.headers['user-agent'] || '').toString().slice(0,200)]);
  }

  const lines = await pool.query(
    `SELECT l.id, l.seq, l.product_name, l.ours, l.theirs, l.product_id,
            (s."疑点" IS NOT NULL)    AS hs_suspect,
            s."疑点"                  AS hs_suspect_why,
            s."建议HS4"               AS hs_suggest
       FROM collab.po_line l
       LEFT JOIN staging.v_hs_suspect s ON s."产品id" = l.product_id
      WHERE l.sheet_id = $1 ORDER BY l.seq`, [sheet.id]);

  // 条款：这家工厂配了就用它的，没配用默认
  const terms = await pool.query(
    `SELECT seq, title_cn, title_en, body_cn, body_en FROM collab.po_terms
      WHERE is_active AND factory_company_id IS NOT DISTINCT FROM
            (SELECT CASE WHEN EXISTS(SELECT 1 FROM collab.po_terms
                                      WHERE factory_company_id = $1 AND is_active)
                         THEN $1 END)
      ORDER BY seq`, [sheet.factory_company_id]);

  // 下载包：采购合同 + QC 要求（Damon 0918「下载我们最好有两份，包括 qc 要求」）
  const packs = await pool.query(
    `SELECT kind, title, file_url, is_required FROM collab.po_attachment
      WHERE in_download_pack
        AND (sheet_id = $1 OR (sheet_id IS NULL AND factory_company_id = $2))
      ORDER BY seq`, [sheet.id, sheet.factory_company_id]);

  // 📜 改动史（最近 200 条）+ 事件流水（最近 50 条）
  const hist = await pool.query(
    `SELECT seq, field, old_val, new_val,
            COALESCE(NULLIF(actor_name,''), actor_org, '未留名') AS who,
            actor_side, created_at
       FROM collab.po_line_history WHERE sheet_id=$1
      ORDER BY created_at DESC LIMIT 200`, [sheet.id]);
  const evts = await pool.query(
    `SELECT kind, COALESCE(NULLIF(actor_name,''), actor_org, '未留名') AS who,
            actor_side, detail, created_at
       FROM collab.po_event WHERE sheet_id=$1 ORDER BY created_at DESC LIMIT 50`, [sheet.id]);

  // 卖方开票资料 + 下单日期 + 对外单号：从主数据带出（Damon 0925「他们税号这些肯定有,为什么看不到」）
  // 卖方资料 = companies 主数据打底，工厂在协同单里填过的覆盖（theirs 优先）；⛔ 只读，不回写 companies
  // 对外单号 = customer_po → contract_no → fs_no；⛔ 绝不给工厂看 order_no（开头是客户编号）
  const oi = (await pool.query(
    `SELECT o.order_date, o.customer_po, o.contract_no, o.fs_no,
            c.tax_id, c.bank_name, c.bank_account, c.bank_accounts
       FROM orders o LEFT JOIN companies c ON c.id = $2
      WHERE o.order_no = $1 LIMIT 1`, [sheet.order_no, sheet.factory_company_id])).rows[0] || {};
  const b0 = (Array.isArray(oi.bank_accounts) && oi.bank_accounts[0]) || {};
  const nonEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && String(v).trim() !== ""));
  const profile = {
    ...nonEmpty({ tax_id: oi.tax_id, bank_name: oi.bank_name || b0.bank, bank_account: oi.bank_account || b0.account }),
    ...nonEmpty(sheet.factory_profile),
  };
  // 对外单号统一用我们给工厂的采购合同号（Damon 0926「单号不一致」：原来有PO号的显示PO号、没有的显示合同号，两种混着）
  const displayNo = oi.contract_no || oi.fs_no || oi.customer_po || "";
  const orderDate = oi.order_date ? new Date(new Date(oi.order_date).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null;

  // 产品图 + 库存（Damon 0925「还有产品图片,还有库存表,都要显示上」）
  // 袋子只取【这家工厂名下】的库存（packaging_stock_by_owner），别家/公共袋不算；成品库存读 finished_goods_inventory
  const facCode = (await pool.query(`SELECT code FROM companies WHERE id = $1`, [sheet.factory_company_id])).rows[0]?.code || null;
  const extra = await pool.query(
    `SELECT l.id, p.sku, p.bg_bx,
            COALESCE(NULLIF(p.image_url,''), NULLIF(p.images->>0,'')) AS image_url,
            fg.current_stock AS fg_stock, fg.stocktook_at,
            (SELECT jsonb_agg(jsonb_build_object('code', pm.sku_code, 'stock', o.current_stock) ORDER BY pm.sku_code)
               FROM packaging_materials pm
               JOIN packaging_stock_by_owner o ON o.material_id = pm.id AND o.owner_code = $2
              WHERE pm.product_skus ? p.sku) AS bags
       FROM collab.po_line l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN finished_goods_inventory fg ON fg.product_id = p.id
      WHERE l.sheet_id = $1`, [sheet.id, facCode]);
  const ex = Object.fromEntries(extra.rows.map(r => [String(r.id), r]));
  for (const l of lines.rows) l.image_url = ex[String(l.id)]?.image_url || null;
  const stock = lines.rows.map(l => {
    const e = ex[String(l.id)] || {};
    const qty = Number((l.theirs && l.theirs.qty) ?? (l.ours && l.ours.qty) ?? 0) || 0;
    const per = parseInt(e.bg_bx, 10) || null;
    const bags = Array.isArray(e.bags) ? e.bags : [];
    const bagStock = bags.length ? bags.reduce((a, b) => a + (Number(b.stock) || 0), 0) : null;
    const need = per ? qty * per : null;
    return {
      seq: l.seq, sku: e.sku || null, product_name: l.product_name, qty_ctn: qty, per_ctn: per,
      bags_needed: need, bag_stock: bagStock, bag_codes: bags.map(b => b.code),
      bag_short: (need != null && bagStock != null) ? Math.max(0, need - bagStock) : null,
      fg_stock: e.fg_stock != null ? Number(e.fg_stock) : null,
      stocktook_at: e.stocktook_at || null,
    };
  });

  const missing = countMissing(lines.rows, { ...sheet, factory_profile: profile });
  return res.json({
    valid: true, role: ROLE,
    sheet: {
      // ⛔ 不回 order_no：开头是客户编号，工厂在浏览器开发者工具里也能看到（0926 全流程测试抓到）
      id: sheet.id, factory_name: sheet.factory_name,
      status: sheet.status, template_side: sheet.template_side,
      qc_required: sheet.qc_required,
      factory_delivery_date: sheet.factory_delivery_date,
      factory_remarks: sheet.factory_remarks,
      factory_profile: profile,
      display_no: displayNo, order_date: orderDate,
      has_seal: !!(await pool.query(`SELECT 1 FROM customer_stamps cs JOIN companies c ON c.code = cs.company_code
                                      WHERE c.id=$1 AND cs.is_default AND cs.is_active LIMIT 1`, [sheet.factory_company_id])).rows.length,
      seal: await sealStatus(pool, sheet.factory_company_id),
      siblings: (await pool.query(
        `SELECT s.id, s.status, s.sent_at, s.adopted_at,
                to_char(s.factory_delivery_date, 'YYYY-MM-DD') AS delivery_date,
                COALESCE(NULLIF(o.contract_no,''), NULLIF(o.fs_no,''), NULLIF(o.customer_po,''), '协同单#' || s.id) AS no,
                o.total_qty
           FROM collab.po_sheet s LEFT JOIN orders o ON o.order_no = s.order_no
          WHERE s.factory_company_id = $1 AND s.side = 'factory' AND s.status <> 'void'
          ORDER BY s.sent_at DESC NULLS LAST, s.id DESC LIMIT 100`, [sheet.factory_company_id])).rows,
      return_reason: sheet.status === "returned"
        ? ((await pool.query(`SELECT detail->>'reason' AS r FROM collab.po_event WHERE sheet_id=$1 AND kind='returned'
                               ORDER BY created_at DESC LIMIT 1`, [sheet.id])).rows[0]?.r || null) : null,
      submitted_at: sheet.submitted_at,
      contract_file: (await pool.query(
        `SELECT file_name, file_url, created_at FROM collab.po_file
          WHERE sheet_id=$1 AND kind='signed_back' ORDER BY created_at DESC LIMIT 1`, [sheet.id])).rows[0] || null,
    },
    lines: lines.rows, terms: terms.rows, download_pack: packs.rows, stock,
    history: hist.rows, events: evts.rows,
    last_edit_by: sheet.last_edit_by, last_edit_at: sheet.last_edit_at,
    contact_name: sheet.factory_contact_name,
    missing,
  });
}

// ── 缺什么（右边红框那块的数据）────────────────────────────
function countMissing(lines, sheet) {
  const v = (l, k) => (l.theirs && l.theirs[k] != null && l.theirs[k] !== "")
    ? l.theirs[k] : (l.ours && l.ours[k] != null && l.ours[k] !== "" ? l.ours[k] : null);
  let barcode = 0, box = 0, hs = 0, photo = 0, zeroQty = 0, hsSuspect = 0, gw = 0, nw = 0;
  for (const l of lines) {
    if (!v(l, "barcode")) barcode++;
    if (!v(l, "box_l") || !v(l, "box_w") || !v(l, "box_h")) box++;
    if (!v(l, "hs_code")) hs++;
    if (!v(l, "gw_ctn")) gw++;
    if (!v(l, "nw_ctn")) nw++;
    if (Number(v(l, "qty")) === 0) zeroQty++;
    if (l.hs_suspect) hsSuspect++;
    if (!l.has_photo) photo++;
  }
  const prof = sheet.factory_profile || {};
  const profMiss = ["bank_name", "bank_account"].filter(k => !prof[k]).length;
  const dateMiss = sheet.factory_delivery_date ? 0 : 1;
  return {
    barcode, box, gw, nw, hs_missing: hs, hs_suspect: hsSuspect, photo,
    factory_profile: profMiss, delivery_date: dateMiss, zero_qty: zeroQty,
    // ⛔ 下单闸只数【真正影响发货】的：箱规 + 开户行 + 交货日。
    //    ⛔ 条形码不进闸（Damon 0918：有些产品本来就没有条码，缺的也不影响）
    //    产品图、HS 建议同样不进闸。
    //    ✅ 毛重/净重进闸（Damon 0918：订舱报关都要用）—— 跟页面右边那个数字同一个口径
    gate_total: box + gw + nw + profMiss + dateMiss,
  };
}

// ── 工厂：提交 ───────────────────────────────────────────
async function handleSubmit(req, res, pool) {
  const { sheet, err } = await resolveToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });
  if (!(await factoryGate(req, res, pool, sheet))) return;
  if (sheet.status === "adopted")
    return res.status(409).json({ ok: false, error: "这单我们已经采纳过了，如需改动请联系我们" });

  const { lines, delivery_date, remarks, factory_profile, template_side, contact_name } = req.body || {};
  // ⛔ 交货期必填（Damon 0925「不填写交货时间不可以的」）—— 其它缺项只提醒不拦
  if (!delivery_date && !sheet.factory_delivery_date)
    return res.status(400).json({ ok: false, error: "请先填「可交货日期」再提交", need: "delivery_date" });
  // 经办人：工厂自己填的名字；⛔ 不强制，没填就落工厂名（Damon：缺的也不影响）
  const actorName = String(contact_name || sheet.factory_contact_name || req.user?.username || '').slice(0, 40) || null;
  let histN = 0;
  const bagSkipped = [];
  const facCode = (await pool.query(`SELECT code FROM companies WHERE id = $1`, [sheet.factory_company_id])).rows[0]?.code || null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const row of Array.isArray(lines) ? lines.slice(0, 500) : []) {
      const id = parseInt(row?.id, 10);
      if (!id) continue;
      // ⛔ 只收白名单字段，别的丢掉
      const theirs = {};
      for (const k of FIELD_WL) {
        if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
          theirs[k] = typeof row[k] === "string" ? String(row[k]).slice(0, 200) : row[k];
        }
      }
      // 🧺 袋子库存（Damon 0925「袋子要可以修改库存」）
      //    袋子是工厂自有（0924 定），库存真源 = packaging_stock_by_owner(FACTORY/本厂) + packaging_materials；
      //    ⛔ 不另起表：直接改那一套，每次改都写 packaging_logs(stocktake) 留前后值，可追可撤
      if (row.bag_stock !== undefined && row.bag_stock !== null && String(row.bag_stock).trim() !== "") {
        const nv = Number(String(row.bag_stock).replace(/,/g, ""));
        if (Number.isFinite(nv) && nv >= 0 && nv < 1e8) {
          const m = await client.query(
            `SELECT pm.id AS material_id, pm.sku_code, o.id AS owner_row, o.current_stock, l.seq
               FROM collab.po_line l
               JOIN products p ON p.id = l.product_id
               JOIN packaging_materials pm ON pm.product_skus ? p.sku
               JOIN packaging_stock_by_owner o ON o.material_id = pm.id AND o.owner_code = $3
              WHERE l.id = $1 AND l.sheet_id = $2`, [id, sheet.id, facCode]);
          if (m.rows.length === 1 && Number(m.rows[0].current_stock) !== nv) {
            const b = m.rows[0], ov = Number(b.current_stock);
            await client.query(`UPDATE packaging_stock_by_owner SET current_stock=$2, updated_at=NOW() WHERE id=$1`, [b.owner_row, nv]);
            await client.query(
              `UPDATE packaging_materials SET current_stock =
                 (SELECT COALESCE(SUM(current_stock),0) FROM packaging_stock_by_owner WHERE material_id=$1), updated_at=NOW()
                WHERE id=$1`, [b.material_id]);
            await client.query(
              `INSERT INTO packaging_logs (material_id, type, quantity, before_stock, after_stock, operator, notes)
               VALUES ($1,'stocktake',$2,$3,$2,$4,$5)`,
              [b.material_id, nv, ov, (actorName || sheet.factory_name || "工厂").slice(0, 60),
               `采购单协同 #${sheet.id}（${sheet.order_no}）工厂改袋子库存 ${ov}→${nv}`]);
            await client.query(
              `INSERT INTO collab.po_line_history
                 (sheet_id, line_id, seq, field, old_val, new_val, actor_side, actor_name, actor_org)
               VALUES ($1,$2,$3,'bag_stock',$4,$5,'factory',$6,$7)`,
              [sheet.id, id, b.seq, String(ov), String(nv), actorName, sheet.factory_name]);
            histN++;
          } else if (m.rows.length > 1) {
            bagSkipped.push(id);   // 一款挂了多个袋子，分不清改哪个 → 不改，回给页面提示
          }
        }
      }

      if (!Object.keys(theirs).length) continue;

      // 📝 留痕（Damon 0918）：先读上一版，逐字段比对，变了的才记一行历史。
      //    old_val 第一次是我们发出去的原值(ours)，之后是上一次工厂填的值。
      const prev = await client.query(
        `SELECT seq, ours, theirs FROM collab.po_line WHERE id=$1 AND sheet_id=$2`,
        [id, sheet.id]);
      if (prev.rows.length) {
        const pr = prev.rows[0];
        const before = Object.assign({}, pr.ours || {}, pr.theirs || {});
        for (const k of Object.keys(theirs)) {
          const ov = before[k] == null ? null : String(before[k]);
          const nv = theirs[k] == null ? null : String(theirs[k]);
          if (ov === nv) continue;                       // 没变就不记
          if (ov !== null && nv !== null && Number(ov) === Number(nv) && ov !== '' && nv !== '') continue; // 120 vs 120.00 不算改
          await client.query(
            `INSERT INTO collab.po_line_history
               (sheet_id, line_id, seq, field, old_val, new_val, actor_side, actor_name, actor_org)
             VALUES ($1,$2,$3,$4,$5,$6,'factory',$7,$8)`,
            [sheet.id, id, pr.seq, k, ov, nv, actorName, sheet.factory_name]);
          histN++;
        }
      }

      // diff_keys：跟 ours 不一样的那些 key（给 Damon 看差异用）
      await client.query(
        `UPDATE collab.po_line
            SET theirs = $2::jsonb,
                diff_keys = ARRAY(
                  SELECT k FROM jsonb_object_keys($2::jsonb) k
                   WHERE ours->>k IS DISTINCT FROM ($2::jsonb)->>k),
                updated_at = NOW()
          WHERE id = $1 AND sheet_id = $3`,
        [id, JSON.stringify(theirs), sheet.id]);
    }

    await client.query(
      `UPDATE collab.po_sheet
          SET status='submitted', submitted_at=NOW(), updated_at=NOW(),
              factory_delivery_date = COALESCE($2::date, factory_delivery_date),
              factory_remarks       = COALESCE(NULLIF($3,''), factory_remarks),
              factory_profile       = COALESCE($4::jsonb, factory_profile),
              template_side         = COALESCE(NULLIF($5,''), template_side),
              factory_contact_name  = COALESCE($6, factory_contact_name),
              last_edit_by          = COALESCE($6, factory_name),
              last_edit_at          = NOW()
        WHERE id = $1`,
      [sheet.id, delivery_date || null, String(remarks || "").slice(0, 2000),
       factory_profile ? JSON.stringify(factory_profile) : null,
       template_side === "theirs" ? "theirs" : (template_side === "ours" ? "ours" : null),
       actorName]);

    // 事件流水：这次提交改了几项
    await client.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, actor_org, detail, ip, ua)
       VALUES ($1,'submitted','factory',$2,$3,$4::jsonb,$5,$6)`,
      [sheet.id, actorName, sheet.factory_name,
       JSON.stringify({ lines: Array.isArray(lines) ? lines.length : 0, changed_fields: histN }),
       (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').toString().slice(0,60),
       (req.headers['user-agent'] || '').toString().slice(0,200)]);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
  const status = await maybeConfirm(pool, sheet.id, req.body?.token);
  return res.json({ ok: true, status,
                    message: status === "confirmed" ? "已确认，谢谢！" : "已提交。下一步：请上传确认后的采购合同。",
                    bag_skipped: bagSkipped });
}

// ── 工厂：传文件 ─────────────────────────────────────────
async function handleUpload(req, res, pool) {
  const { sheet, err } = await resolveToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });

  if (!(await factoryGate(req, res, pool, sheet))) return;
  if (sheet.status === "adopted")
    return res.status(409).json({ ok: false, error: "这单我们已经采纳过了，如需改动请联系我们" });
  const { filename, mime, data_base64, kind, line_id, product_id } = req.body || {};
  if (!filename || !data_base64)
    return res.status(400).json({ ok: false, error: "filename / data_base64 必填" });

  let buf;
  try { buf = Buffer.from(String(data_base64).replace(/^data:[^,]*,/, ""), "base64"); }
  catch { return res.status(400).json({ ok: false, error: "base64 解析失败" }); }
  if (buf.length > 8 * 1024 * 1024)
    return res.status(413).json({ ok: false, error: "单个文件不能超过 8MB" });

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.join("/opt/sanlyn-uploads/po-collab", String(sheet.id));
  await fs.mkdir(dir, { recursive: true });
  const safe = String(filename).replace(/[^\w.\-一-鿿]/g, "_").slice(0, 120);
  const name = `${Date.now()}_${safe}`;
  await fs.writeFile(path.join(dir, name), buf);
  const url = `/uploads/po-collab/${sheet.id}/${name}`;

  const okKinds = ["product_photo", "qc_report", "spec", "their_contract", "signed_back", "other"];
  const k = okKinds.includes(kind) ? kind : "other";

  const ins = await pool.query(
    `INSERT INTO collab.po_file (sheet_id, line_id, product_id, kind, file_name, file_url, mime, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [sheet.id, line_id || null, product_id || null, k, safe, url, mime || null, buf.length]);

  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_org, detail)
     VALUES ($1,'uploaded','factory',$2,$3::jsonb)`,
    [sheet.id, sheet.factory_name, JSON.stringify({ file: safe, kind: k, bytes: buf.length })]);

  const status = k === "signed_back" ? await maybeConfirm(pool, sheet.id, req.body?.token) : sheet.status;
  return res.json({ ok: true, file_id: ins.rows[0].id, file_url: url, kind: k, status });
}

export { handleSendLink, handleValidate, handleSubmit, handleUpload, resolveToken, factoryGate, maybeConfirm, isInternal, FACTORY_ROLES };
