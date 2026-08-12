// collab-files.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import fs from "fs";
import path from "path";
import { generateToken } from "../../auth.js";
import { rawToHash } from "./collab-shared.js";

// ── 角色 token 解析（车队/报关行 文件口共用）──────────────
async function resolveRoleToken(pool, raw, roles) {
  if (!raw || raw.length < 10) return null;
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role = ANY($2)
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw), roles]
  );
  if (!rows.length) return null;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return null;
  return { role: rows[0].recipient_role, planId, segments: meta.segments || null, meta };
}

// ── GET /file?token=&type=so|cd&ref= — 文档下载代理 ─────────
// magic token 换内部 JWT，服务端转发 documents 渲染，JWT 不出服务器。
// 车队只能拿 SO（托书）；报关行 SO + CD（报关底稿，ref 必须是本票挂的订单号）。
const FILE_TYPES_BY_ROLE = { trucking_booking: ["so"], broker_booking: ["so", "pack", "customs_decl", "quarantine"], customer_booking: ["pack"],
  factory_booking: ["upload"],
  supplier_portal: ["so", "cd", "pack", "nondg", "telex", "transfer", "upload", "customs_decl", "quarantine"] };

async function handleFileProxy(req, res, pool) {
  const { token: raw, type, ref, aud } = req.query || {};
  const auth = await resolveRoleToken(pool, raw, ["trucking_booking", "broker_booking", "supplier_portal", "customer_booking", "factory_booking"]);
  if (!auth) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const allowed = FILE_TYPES_BY_ROLE[auth.role] || [];
  if (!allowed.includes(type)) return res.status(403).json({ ok: false, error: "无权下载该类型" });

  let docId;
  // 电放/SWB 保函：真源是 documents?type=tr（渲染「电放申请书暨保函」）。
  // 旧路由错把 telex 发给 shipping-plan-pdf，而它没有 telex 渲染器→回退成「海运计划确认书」(Damon 0812 指出)。
  if (type === "telex") {
    const { rows: pr } = await pool.query(
      `SELECT bl_no, primary_contract_no, order_contract_nos FROM shipping_plans WHERE id = $1`, [auth.planId]);
    const blno = (pr[0] && pr[0].bl_no) || "";
    const contract = (pr[0] && (pr[0].primary_contract_no || String(pr[0].order_contract_nos || "").split(",")[0].trim())) || "";
    if (!blno && !contract) return res.status(404).json({ ok: false, error: "本票暂无提单/合同号，无法生成保函" });
    const jwtX = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 });
    const q = blno ? `bl_no=${encodeURIComponent(blno)}` : `contract_no=${encodeURIComponent(contract)}`;
    const urlX = `http://127.0.0.1:9000/api/db/documents?type=tr&${q}&token=${encodeURIComponent(jwtX)}`;
    try {
      const up = await fetch(urlX);
      res.status(up.status);
      const ct = up.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) { return res.status(502).json({ ok: false, error: "保函服务不可用" }); }
  }
  // 非危声明/内转外/报关单：shipping-plan-pdf 端点（关联字段=计划 id）
  if (type === "nondg" || type === "transfer" || type === "customs_decl") {
    const jwtX = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 }); // documents 鉴权核 accounts 表,虚构 uid 会 ACCOUNT_NOT_FOUND → 用真实服务账号 svc-agent(id=90)
    const urlX = `http://127.0.0.1:9000/api/db/shipping-plan-pdf?id=${auth.planId}&type=${type}&token=${encodeURIComponent(jwtX)}`;
    try {
      const up = await fetch(urlX);
      res.status(up.status);
      const ct = up.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) { return res.status(502).json({ ok: false, error: "文档服务不可用" }); }
  }
  // 回传/上传文件下载（MSDS/检疫等）：stored 名必须在本票 collab_uploads 清单内（防越权拉文件）
  if (type === "upload") {
    const { rows: upl } = await pool.query(
      `SELECT raw->'collab_uploads' AS u FROM shipping_plans WHERE id = $1`, [auth.planId]);
    const list = (upl[0] && upl[0].u) || [];
    const hit = Array.isArray(list) ? list.find(x => x && x.stored === String(ref || "")) : null;
    if (!hit) return res.status(403).json({ ok: false, error: "文件不属于本票" });
    const fp = path.join(UPLOAD_DIR, String(auth.planId), hit.stored);
    if (!fs.existsSync(fp)) {
      // 已转 NAS 冷存:回"已存档"占位图(不再破图),顾客可点"申请提取"发邮箱
      res.setHeader("Content-Type", "image/svg+xml");
      return res.end('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"120\"><rect width=\"120\" height=\"120\" fill=\"#fdf1ea\"/><rect x=\"42\" y=\"38\" width=\"36\" height=\"26\" rx=\"3\" fill=\"#e7c8b4\"/><rect x=\"42\" y=\"33\" width=\"16\" height=\"7\" rx=\"2\" fill=\"#e7c8b4\"/><text x=\"60\" y=\"80\" font-size=\"11\" fill=\"#9a3412\" text-anchor=\"middle\" font-family=\"sans-serif\">\u5df2\u5b58\u6863</text><text x=\"60\" y=\"96\" font-size=\"9\" fill=\"#b45309\" text-anchor=\"middle\" font-family=\"sans-serif\">\u7533\u8bf7\u63d0\u53d6</text></svg>');
    }
    res.setHeader("Content-Type", hit.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(hit.filename)}`);
    return res.end(fs.readFileSync(fp));
  }
  // 检疫报告：真源 document_uploads(doc_type=quarantine_report)，按本票 plan→orders 的 contract_no 或 order_no 匹配（防越权拉别票）
  if (type === "quarantine") {
    const qref = parseInt(ref, 10);   // ref=du.id 指定某一份；无 ref 取最新（向后兼容）
    const { rows: qd } = await pool.query(
      `SELECT COALESCE(du.stamped_url, du.url) AS url, du.mime, du.name
         FROM document_uploads du
         JOIN orders o ON (o.contract_no = du.contract_no OR o.order_no = du.contract_no)
        WHERE o.shipping_plan_id = $1 AND du.doc_type = 'quarantine_report'
          AND COALESCE(du.stamped_url, du.url) IS NOT NULL
          AND ($2::int IS NULL OR du.id = $2::int)
        ORDER BY du.id DESC LIMIT 1`, [auth.planId, qref > 0 ? qref : null]);
    if (!qd.length) return res.status(404).json({ ok: false, error: "本票暂无检疫报告" });
    let qurl = String(qd[0].url);
    if (!/^https?:\/\//i.test(qurl)) qurl = "https://files.sanlynos.com/" + qurl.replace(/^\/+/, ""); // 相对路径挂 files base
    try {
      const up = await fetch(qurl);
      res.status(up.status);
      const ct = up.headers.get("content-type") || qd[0].mime || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(qd[0].name || "quarantine_report")}`);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) { return res.status(502).json({ ok: false, error: "检疫报告服务不可用" }); }
  }
  let extraQ = "";
  if (type === "so") {
    docId = auth.planId; // 计划级文档按 id 精确解析
  } else if (type === "pack") {
    // 报关资料/客户资料合并版：id=首单 + ids=本票全部订单（与管理端同一关联，绝不只合一单）
    const { rows: ords } = await pool.query(
      `SELECT order_no FROM orders WHERE shipping_plan_id = $1 AND order_no IS NOT NULL ORDER BY order_no`, [auth.planId]);
    if (!ords.length) return res.status(404).json({ ok: false, error: "本票无订单" });
    docId = ords[0].order_no;
    extraQ = `&ids=${encodeURIComponent(ords.map(o => o.order_no).join(","))}&style=v2&audience=customer` +
             (aud === "customs" ? "&customs=1" : "");
  } else {
    // CD 按订单号；必须属于本票（防横向拉别票资料）
    const { rows } = await pool.query(
      `SELECT 1 FROM orders o JOIN shipping_plans sp ON sp.id = $1
        WHERE o.shipping_plan_id = sp.id AND o.order_no = $2 LIMIT 1`,
      [auth.planId, String(ref || "")]
    );
    if (!rows.length) return res.status(403).json({ ok: false, error: "订单不属于本票" });
    docId = String(ref);
  }
  const jwt = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 }); // 同上：真实服务账号,虚构 uid 会 401 ACCOUNT_NOT_FOUND
  const audQ = (type !== "pack" && (aud === "customs" || aud === "customer")) ? `&audience=${aud}` : "";
  const url = `http://127.0.0.1:9000/api/db/documents?type=${type}&id=${encodeURIComponent(docId)}&token=${encodeURIComponent(jwt)}${audQ}${extraQ || ""}`;
  try {
    const up = await fetch(url);
    res.status(up.status);
    const ct = up.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
    const cd = up.headers.get("content-disposition"); if (cd) res.setHeader("Content-Disposition", cd);
    const buf = Buffer.from(await up.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "文档服务不可用" });
  }
}

// ── POST /upload — 车队传装柜照/磅单，报关行传报关单回执 ────
// base64 JSON（≤8MB），存 /opt/sanlyn-uploads/collab/<planId>/，raw.collab_uploads 留痕
const UPLOAD_DIR = "/opt/sanlyn-uploads/collab";

// ── 全员提交后总量一致性闸：不一致 → ntfy 警报（Damon 规则：提交完还不平=必须有人看） ──
async function alertIfTotalsMismatch(pool, planId) {
  try {
    const { rows } = await pool.query(
      `SELECT sp.shipment_no, sp.bl_no, sp.total_cartons, sp.gross_weight_kg, sp.total_cbm,
              sp.factory_submitted, sp.customer_submitted,
              (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(sp.raw->'collab_uploads','[]'::jsonb)) u
                WHERE u->>'role' = 'broker') AS broker_uploads,
              SUM(o.total_qty) AS o_qty, SUM(o.gross_weight) AS o_gw, SUM(o.net_weight) AS o_nw,
              (SELECT ROUND(SUM(COALESCE(oli.gw_ctn,0)*COALESCE(oli.qty_ctn,0))::numeric,1)
                 FROM order_line_items oli JOIN orders oo ON oo.id = oli.order_id
                WHERE oo.shipping_plan_id = sp.id) AS oli_gw
         FROM shipping_plans sp LEFT JOIN orders o ON o.shipping_plan_id = sp.id
        WHERE sp.id = $1 GROUP BY sp.id`, [planId]);
    if (!rows.length) return;
    const r = rows[0];
    if (!(r.factory_submitted && r.customer_submitted && Number(r.broker_uploads) > 0)) return; // 没全交不吵
    const issues = [];
    const near = (a, b) => a == null || b == null || Math.abs(Number(a) - Number(b)) <= Math.max(1, Number(b) * 0.001);
    if (r.o_qty != null && r.total_cartons != null && !near(r.o_qty, r.total_cartons))
      issues.push(`箱数 orders=${r.o_qty} vs 计划=${r.total_cartons}`);
    if (r.o_gw != null && r.gross_weight_kg != null && !near(r.o_gw, r.gross_weight_kg))
      issues.push(`毛重 orders=${r.o_gw} vs 计划=${r.gross_weight_kg}`);
    if (r.oli_gw != null && r.o_gw != null && Number(r.oli_gw) > 0 && !near(r.oli_gw, r.o_gw))
      issues.push(`毛重 明细Σ=${r.oli_gw} vs orders=${r.o_gw}`);
    if (r.o_qty == null || r.o_gw == null) issues.push("订单总量字段缺失（空白单未填）");
    // 单柜 CBM 红线：申报超 76 易被查验（2026-06-12 Damon）
    try {
      const { rows: cv } = await pool.query(
        `SELECT cb.container_no, ROUND(SUM(oli.cbm_ctn*oli.qty_ctn)::numeric,2) AS cbm
           FROM container_bookings cb
           JOIN orders o ON o.contract_no = cb.contract_no
           JOIN order_line_items oli ON oli.order_id = o.id
          WHERE cb.shipping_plan_id = $1 GROUP BY cb.container_no`, [planId]);
      for (const v of cv) if (Number(v.cbm) > 76)
        issues.push(`${v.container_no} 申报CBM ${v.cbm} 超76红线（易查验）`);
    } catch (e) {}
    // 过磅交叉核对：货重+皮重 vs VGM磅重，差>2% 必有一边错
    try {
      const { rows: wb } = await pool.query(
        `SELECT container_no, cargo_weight_kg, tare_weight_kg, vgm_weight_kg FROM container_bookings
          WHERE shipping_plan_id = $1 AND cargo_weight_kg IS NOT NULL AND vgm_weight_kg IS NOT NULL`, [planId]);
      for (const w of wb) {
        const calc = Number(w.cargo_weight_kg) + Number(w.tare_weight_kg || 0);
        if (Math.abs(calc - Number(w.vgm_weight_kg)) > Number(w.vgm_weight_kg) * 0.02)
          issues.push(`${w.container_no} 过磅不符：货重+皮重=${calc} vs 车队磅=${w.vgm_weight_kg}`);
      }
    } catch (e) {}
    if (!issues.length) return;
    await fetch("https://ntfy.sh/sanlyn-damon-alert", { method: "POST",
      headers: { Title: encodeURIComponent(`报关硬规则未过 ${r.shipment_no || ""}`), Priority: "high" },
      body: `${r.shipment_no} / BL ${r.bl_no || "-"} 三方全部提交但总量不一致：\n` + issues.join("\n") }).catch(() => {});
  } catch (e) { console.error("[totals-alert]", e.message); }
}

async function handleCollabUpload(req, res, pool) {
  const { token: raw, filename, mime, data_base64 } = req.body || {};
  const auth = await resolveRoleToken(pool, raw, ["trucking_booking", "broker_booking", "supplier_portal", "factory_booking", "customer_booking"]);
  if (!auth) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  if (!filename || !data_base64) return res.status(400).json({ ok: false, error: "filename / data_base64 必填" });
  const purpose = String((req.body && req.body.purpose) || "").slice(0, 40) || null;
  const seqRaw = parseInt(req.body && req.body.container_seq, 10);
  const containerSeq = seqRaw > 0 ? seqRaw : null;
  const fScope = auth.role === "factory_booking" && auth.meta ? auth.meta.factory_scope : null;
  const scopeSeqs = fScope && Array.isArray(fScope.seqs) ? fScope.seqs.map(Number).filter(Boolean) : [];
  if (containerSeq && scopeSeqs.length && !scopeSeqs.includes(containerSeq))
    return res.status(403).json({ ok: false, error: "无权上传该柜文件" });

  let buf;
  try { buf = Buffer.from(String(data_base64).replace(/^data:[^,]*,/, ""), "base64"); }
  catch (e) { return res.status(400).json({ ok: false, error: "base64 解析失败" }); }
  if (!buf.length || buf.length > 8 * 1024 * 1024)
    return res.status(413).json({ ok: false, error: "文件需在 8MB 以内" });

  const safe = String(filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 80) || "file";
  const dir = path.join(UPLOAD_DIR, String(auth.planId));
  fs.mkdirSync(dir, { recursive: true });
  const fname = Date.now() + "_" + auth.role.replace("_booking", "") + "_" + safe;
  fs.writeFileSync(path.join(dir, fname), buf);

  const rec = {
    role: auth.role.replace("_booking", ""), filename: safe, stored: fname,
    mime: String(mime || "").slice(0, 60) || null, size: buf.length,
    uploaded_at: new Date().toISOString(),
  };
  if (purpose) rec.purpose = purpose;
  if (containerSeq) rec.container_seq = containerSeq;
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw,'{}'::jsonb) ||
                  jsonb_build_object('collab_uploads',
                    COALESCE(raw->'collab_uploads','[]'::jsonb) || $1::jsonb),
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify([rec]), auth.planId]
  );
  if (rec.role === "broker") alertIfTotalsMismatch(pool, auth.planId); // 异步，不阻塞响应
  return res.json({ ok: true, file: rec });
}

export { handleFileProxy, handleCollabUpload };
