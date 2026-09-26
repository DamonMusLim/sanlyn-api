// po-collab-seal.js — 采购合同 PDF + 工厂一键盖公章确认（Damon 0926）
//   GET  /contract-pdf?token&sheet  出这张采购合同的 PDF（不盖章；工厂登录或内部员工）
//   POST /seal {token, sheet}        工厂账号用【本厂默认公章】盖在「乙方（盖章）」处 → 算回签合同（SOP 第2步）
//   GET  /contract?token&sheet       看/下载已回签(盖章或上传)的合同
// 🔴 盖章只走 DAS（/api/stamp/straddle-confirm），章图只取 customer_stamps 本厂默认章，⛔ 不本地合成、不带任何人签名
// 🔴 只有本厂工厂账号能盖；内部员工不能替工厂盖章

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { generateToken } from "../../auth.js";
import { ossUploadBuffer } from "../../oss-direct.js";

const UPLOAD_ROOT = "/opt/sanlyn-uploads/po-collab";
const RENDER_ORIGIN = () => process.env.PO_RENDER_ORIGIN
  || `http://127.0.0.1:${process.env.PREVIEW_PORT || process.env.PORT || 9000}`;
const DAS_ORIGIN = () => process.env.PO_DAS_ORIGIN || "http://127.0.0.1:9000";   // DAS 在主服务上
// A4 + 页边距（跟 page.pdf 的参数一致，量章的位置要用同一套）
const MM = 96 / 25.4, PAGE_W = 210 * MM, PAGE_H = 297 * MM, M_TOP = 10 * MM, M_BOTTOM = 10 * MM, M_SIDE = 8 * MM;

// 在生成好的 PDF 里找「（盖章）」那几个字的真实位置（页 + 坐标，左上为原点，0–1）。
// ⛔ 别再按屏幕高度推算页码：多页合同分页跟屏幕排版对不上，0926 全流程测试章盖进了第 1 页表格中间
async function locateSealInPdf(pdf) {
  const tmp = path.join(os.tmpdir(), `po-seal-${process.pid}-${Date.now()}.pdf`);
  try {
    await fs.writeFile(tmp, pdf);
    const { stdout } = await promisify(execFile)("pdftotext", ["-bbox", tmp, "-"], { maxBuffer: 20 * 1024 * 1024 });
    let page = -1, W = 0, H = 0, hit = null;
    for (const line of stdout.split("\n")) {
      const pm = line.match(/<page width="([\d.]+)" height="([\d.]+)"/);
      if (pm) { page++; W = +pm[1]; H = +pm[2]; continue; }
      const wm = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">（盖章）<\/word>/);
      if (wm) hit = { page, x: (+wm[1] + +wm[3]) / 2 / W, y: (+wm[2] + +wm[4]) / 2 / H };   // 取最后一个 = 签章栏
    }
    return hit;
  } catch { return null; } finally { fs.unlink(tmp).catch(() => {}); }
}

// 用工厂看到的那一页，在打印版式下出 PDF；顺便量「乙方（盖章）」格子落在第几页、什么位置
async function renderContract(token, sheetId, bearer) {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome", headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem("po_factory_jwt", t); } catch (e) {} }, bearer);
    await page.setViewport({ width: Math.round(PAGE_W - 2 * M_SIDE), height: 1200 });
    await page.emulateMediaType("print");
    const url = `${RENDER_ORIGIN()}/public/collab-po.html?c=${encodeURIComponent(token)}&sheet=${encodeURIComponent(sheetId)}&pdf=1`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(() => document.getElementById("wrap") && document.getElementById("wrap").style.display !== "none"
      && document.querySelectorAll("#tb tr[data-id]").length > 0, { timeout: 20000 });
    const spot = await page.evaluate(() => {
      const el = document.getElementById("sealSpot"); if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2 + window.scrollX, cy: r.top + r.height / 2 + window.scrollY };
    });
    const pdf = Buffer.from(await page.pdf({
      format: "A4", printBackground: true, preferCSSPageSize: false,
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    }));
    let sig = null;
    if (spot) {
      const contentH = PAGE_H - M_TOP - M_BOTTOM;
      const pageIdx = Math.floor(spot.cy / contentH);
      sig = { page: pageIdx, x: (spot.cx + M_SIDE) / PAGE_W, y: (spot.cy - pageIdx * contentH + M_TOP) / PAGE_H };
    }
    sig = (await locateSealInPdf(pdf)) || sig;   // 以 PDF 里的真实位置为准，找不到才用估算
    return { pdf, sig };
  } finally { await browser.close(); }
}

function bearerOf(req) { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }

async function handleContractPdf(req, res, pool, sheet) {
  const { pdf } = await renderContract(req.query?.token, sheet.id, bearerOf(req));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(`采购合同-${sheet.id}.pdf`)}`);
  return res.end(pdf);
}

async function handleSeal(req, res, pool, sheet, maybeConfirm) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!["factory", "supplier"].includes(role))
    return res.status(403).json({ ok: false, error: "只能由工厂账号用本厂公章确认" });
  if (sheet.status === "adopted") return res.status(409).json({ ok: false, error: "这单已经采纳过了" });
  if (!sheet.submitted_at || !sheet.factory_delivery_date)
    return res.status(409).json({ ok: false, error: "请先填「可交货日期」并点「保存并提交」，再盖章确认" });
  const co = (await pool.query(`SELECT code FROM companies WHERE id=$1`, [sheet.factory_company_id])).rows[0];
  const stamp = co && (await pool.query(
    `SELECT id FROM customer_stamps WHERE company_code=$1 AND is_default AND is_active LIMIT 1`, [co.code])).rows[0];
  if (!stamp) return res.status(409).json({ ok: false, error: "贵司还没有在我们系统登记公章，请改用「上传合同」" });

  // ① 出合同 PDF + 量章位
  const { pdf, sig } = await renderContract(req.body?.token, sheet.id, bearerOf(req));
  if (!sig) return res.status(500).json({ ok: false, error: "合同上找不到盖章位置" });
  const nPages = (await PDFDocument.load(pdf)).getPageCount();
  if (sig.page >= nPages) sig.page = nPages - 1;
  // ② 原件上 OSS（DAS 按 URL 取）
  const stamp8 = Date.now();
  const srcUrl = await ossUploadBuffer(`documents/po-collab/${sheet.id}/unsigned-${stamp8}.pdf`, pdf, "application/pdf");
  // ③ DAS 盖章：只盖本厂默认公章，不带签名，不盖骑缝
  // DAS 要求调用账号在 accounts 里真实存在（ACCOUNT_NOT_FOUND）；用现成服务账号 svc-agent(id 90)，操作人另记 operator
  const svc = generateToken({ uid: 90, username: "svc-agent", role: "admin", company_code: null });
  const r = await fetch(`${DAS_ORIGIN()}/api/stamp/straddle-confirm`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc}` },
    body: JSON.stringify({
      pdfUrl: srcUrl, companyCode: co.code, operator: `po-collab:${req.user?.username || "factory"}`,
      documentId: `po-sheet-${sheet.id}`, documentName: `采购合同 协同单#${sheet.id} · ${sheet.factory_name}`,
      // ⛔ DAS 的 page 从 1 数（传 0 起的下标会盖到前一页；0926 两页合同章盖进了第 1 页）
      gaps: [], signature: { page: sig.page + 1, x: sig.x, y: sig.y, withSignature: false },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.stampedUrl) return res.status(502).json({ ok: false, error: "盖章失败：" + (j.error || j.detail || r.status) });
  // ④ 盖好的存本地 + 记为回签合同（signed_back）
  const got = await fetch(j.stampedUrl);
  if (!got.ok) return res.status(502).json({ ok: false, error: "盖章件取回失败" });
  const buf = Buffer.from(await got.arrayBuffer());
  const dir = path.join(UPLOAD_ROOT, String(sheet.id));
  await fs.mkdir(dir, { recursive: true });
  const name = `${stamp8}_采购合同-盖章.pdf`;
  await fs.writeFile(path.join(dir, name), buf);
  await pool.query(
    `INSERT INTO collab.po_file (sheet_id, kind, file_name, file_url, mime, size_bytes)
     VALUES ($1,'signed_back',$2,$3,'application/pdf',$4)`,
    [sheet.id, "采购合同（盖章）.pdf", `/uploads/po-collab/${sheet.id}/${name}`, buf.length]);
  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, actor_org, detail)
     VALUES ($1,'sealed','factory',$2,$3,$4::jsonb)`,
    [sheet.id, req.user?.username || null, sheet.factory_name,
     JSON.stringify({ stamp_id: stamp.id, stamp_log_id: j.logId || null, stamped_url: j.stampedUrl, position: sig })]);
  const status = maybeConfirm ? await maybeConfirm(pool, sheet.id, req.body?.token) : null;
  return res.json({ ok: true, status });
}

async function handleContract(req, res, pool, sheet) {
  const f = (await pool.query(
    `SELECT file_name, file_url, mime FROM collab.po_file WHERE sheet_id=$1 AND kind='signed_back' ORDER BY created_at DESC LIMIT 1`,
    [sheet.id])).rows[0];
  if (!f) return res.status(404).json({ ok: false, error: "还没有回签合同" });
  const full = path.join(UPLOAD_ROOT, String(sheet.id), path.basename(String(f.file_url || "")));
  try {
    const buf = await fs.readFile(full);
    res.setHeader("Content-Type", f.mime || "application/pdf");
    res.setHeader("Content-Disposition", `${req.query?.dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.file_name || "合同.pdf")}`);
    return res.end(buf);
  } catch { return res.status(404).json({ ok: false, error: "文件不在服务器上" }); }
}

// ── POST /seal-upload {token, sheet, filename, mime, data_base64} ──
// 工厂上传本厂公章 → customer_stamps 里先存【未启用】（⛔ 没审核不能盖）→ 给艾莎建「审核公章」任务
// 审核通过才设为默认章（po-collab-review.js handleSealApprove）。Damon 0926「新增上传公章…帮我闭环」
async function handleSealUpload(req, res, pool, sheet) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!["factory", "supplier"].includes(role)) return res.status(403).json({ ok: false, error: "只能由工厂账号上传本厂公章" });
  const { filename, mime, data_base64 } = req.body || {};
  if (!/^image\/(png|jpe?g)$/i.test(String(mime || ""))) return res.status(400).json({ ok: false, error: "公章请上传 PNG 或 JPG 图片（透明底 PNG 最好）" });
  let buf; try { buf = Buffer.from(String(data_base64 || ""), "base64"); } catch { buf = null; }
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: "图片是空的" });
  if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ ok: false, error: "公章图片不能超过 2MB" });
  const co = (await pool.query(`SELECT code, name_cn FROM companies WHERE id=$1`, [sheet.factory_company_id])).rows[0];
  if (!co) return res.status(404).json({ ok: false, error: "找不到本厂档案" });
  const ext = /png/i.test(mime) ? "png" : "jpg";
  const url = await ossUploadBuffer(`stamps/customer/${co.code}/factory-upload-${Date.now()}.${ext}`, buf, mime);
  const ins = await pool.query(
    `INSERT INTO customer_stamps (username, company_code, name, url, uploaded_at, is_active, shape, is_default)
     VALUES ($1,$2,$3,$4,NOW(),false,'circle',false) RETURNING id`,
    [req.user?.username || "factory", co.code, `${co.name_cn || co.code}公章（工厂上传·待审核）`, url]);
  const stampId = ins.rows[0].id;
  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, actor_org, detail)
     VALUES ($1,'seal_uploaded','factory',$2,$3,$4::jsonb)`,
    [sheet.id, req.user?.username || null, sheet.factory_name, JSON.stringify({ stamp_id: stampId, file: String(filename || "").slice(0, 120) })]);
  const reviewBase = process.env.PO_REVIEW_BASE || `${process.env.APP_BASE || "https://ai.sanlyn.cn"}/po-review?sheet=`;
  await pool.query(
    `INSERT INTO tasks (id, title, task_type, level, status, domain, priority, assigned_staff_no, related_order_no, source,
                        dedupe_key, due_at, reason, next_action, raw, created_at, updated_at)
     VALUES ($1,$2,'公章审核','L3','open','外贸','p1','WM-01',$3,'po-collab',$4,NOW()+interval '1 day',$5,$6,$7::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO NOTHING`,
    [`seal-approve-${stampId}`, `${sheet.factory_name}上传了新公章，请审核`.slice(0, 100), sheet.order_no, `company:seal_approve:${co.code}:${stampId}`,
     `公章 #${stampId}（${co.code}）· 上传人 ${req.user?.username || "?"} · 来自协同单#${sheet.id}`,
     "打开审核页看公章图片 → 通过（设为本厂默认章）或驳回（写原因）",
     JSON.stringify({ task_class: "业务", subclass: "公章审核", canonical_domain: "order", owner: "WM-01 艾莎", reviewer: "D-00",
       deep_link: reviewBase + sheet.id, event: `${sheet.factory_name}上传了新公章，等我方审核后才能用来盖章`,
       facts: `customer_stamps #${stampId} · ${url}`, severity: "P2", stamp_id: stampId, sheet_id: sheet.id })]);
  return res.json({ ok: true, stamp_id: stampId, status: "pending" });
}

// 本厂公章状态：active 有已启用默认章 / pending 有待审核 / rejected 最近一次被驳回 / none
async function sealStatus(pool, factoryCompanyId) {
  const r = await pool.query(
    `SELECT cs.id, cs.is_active, cs.is_default, cs.name, cs.url, cs.uploaded_at FROM customer_stamps cs
       JOIN companies c ON c.code = cs.company_code WHERE c.id = $1 ORDER BY cs.uploaded_at DESC`, [factoryCompanyId]);
  const act = r.rows.find(x => x.is_active && x.is_default);
  const last = r.rows[0];
  if (act) {
    // 换章：在用章照常能盖，最新上传的那枚单独显示审核状态
    const pend = last && last.id !== act.id && /待审核/.test(last.name || "") ? { url: last.url } : null;
    const rej = last && last.id !== act.id && /已驳回/.test(last.name || "")
      ? (last.name.split("已驳回：")[1] || "").replace(/）$/, "") : null;
    return { status: "active", url: act.url || null, pending: pend, rejected_reason: rej };
  }
  if (last && /待审核/.test(last.name || "")) return { status: "pending", stamp_id: last.id, url: last.url || null };
  if (last && /已驳回/.test(last.name || "")) return { status: "rejected", reason: (last.name.split("已驳回：")[1] || "").replace(/）$/, "") };
  return { status: "none" };
}

export { locateSealInPdf, handleContractPdf, handleSeal, handleContract, handleSealUpload, sealStatus };
