// /api/db/verify-doc.js — 上传回执单据 AI 核验
// POST { url, expectedDocType, expectedLabel, blNo, contractNo } → { warnings: [{ level, note }] }
//
// FAIL-OPEN 铁律: 任何错误/超时/未配置 → 返回 { warnings: [] } (或 info)。绝不阻断上传。
// 设计(2026-06-05 重构):报关单/放行单的【货物·HS 交叉核验】走**确定性正则**(报关单文本里就有10位HS),
//   即时、零成本、可靠 —— 防上传错报关单的重大事故。MiniMax 只兜底:扫描件(无文本图片)的类型识别。
import { getPool, setCors } from "../db.js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";   // 深层导入绕开 pdf-parse 1.x debug 入口

const MINIMAX_URL = "https://api.minimaxi.com/anthropic/v1/messages";
const MODEL = "MiniMax-M3";

const TYPE_CN = {
  customs_decl: "报关单", decl_auth: "报关委托书", insp_auth: "报检委托书",
  fumigation: "熏蒸/消毒证书", customs_release: "海关放行单/放行通知",
  telex_release: "电放通知书", telex_loi: "电放保函/切结书",
  non_dg_decl: "非危险品承诺书/声明", vgm: "VGM 称重单",
  eir: "设备交接单 EIR", booking_so: "订舱确认/SO",
};
// 报关单/放行单 = 影响申报与退税,传错=重大事故 → 做货物/HS 交叉核验
const GOODS_CHECK_TYPES = new Set(["customs_decl", "customs_release"]);
const hs4 = (h) => String(h || "").replace(/\D/g, "").slice(0, 4);

// 本票订单期望货物(报关品名 + HS 前4位集合)。
// 整票级单据前端传 blNo;订单级单据前端传 contractNo(实为 order_no/contract_no)→ 都要能命中。
async function fetchExpected(blNo, contractNo) {
  if (!blNo && !contractNo) return null;
  try {
    const r = await getPool().query(
      `SELECT DISTINCT declaration_name, hs_code FROM order_line_items
        WHERE order_id IN (
          SELECT id FROM orders
           WHERE ($1::text IS NOT NULL AND bl_no = $1)
              OR ($2::text IS NOT NULL AND (contract_no = $2 OR order_no = $2))
        ) AND declaration_name IS NOT NULL`,
      [blNo || null, contractNo || null]);
    if (!r.rows.length) return null;
    return {
      names: [...new Set(r.rows.map((x) => x.declaration_name).filter(Boolean))],
      hs4set: new Set(r.rows.map((x) => hs4(x.hs_code)).filter(Boolean)),
    };
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const ok = (warnings = []) => res.status(200).json({ warnings });   // fail-open
  if (req.method !== "POST") return ok();

  try {
    const b = req.body || {};
    const { url, expectedDocType, blNo, contractNo } = b;
    if (!url || !expectedDocType) return ok();
    const expLabel = b.expectedLabel || TYPE_CN[expectedDocType] || expectedDocType;
    const doGoodsCheck = GOODS_CHECK_TYPES.has(expectedDocType);

    // 报关单/放行单 = 事故防线:任何"无法核验"都要给可见 warn,绝不静默放过(Codex BLOCK 修正)。
    const cantVerify = (note) => ok(doGoodsCheck ? [{ level: "warn", note: "⚠ " + note + ",请人工核对这张报关单确属本票订单(货物/HS/提单号)" }] : []);

    // 取文件:服务端走 OSS 直连域(快);CDN 域偶发 16s+
    let buf;
    try {
      const fetchUrl = String(url).replace("files.sanlynos.com", "sanlyn-files.oss-cn-hongkong.aliyuncs.com");
      const fr = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
      if (!fr.ok) return cantVerify("取单据文件失败");
      buf = Buffer.from(await fr.arrayBuffer());
    } catch (_) { return cantVerify("取单据文件超时/失败"); }

    const isPdf = /\.pdf(\?|$)/i.test(url) || buf.slice(0, 5).toString("latin1") === "%PDF-";
    let text = "";
    if (isPdf) { try { text = ((await pdfParse(buf)).text || ""); } catch (_) {} }

    const warnings = [];
    const expected = doGoodsCheck ? await fetchExpected(blNo, contractNo) : null;

    // ── A. 文本 PDF:确定性正则核验(即时,主安全网)──
    if (text.trim()) {
      // A1. 货物核验。先正向匹配(单据出现本票货物名或HS→一致);否则在真报关单上抽HS判不符。
      //     排除公司注册编码(10位后跟"/公司名"/括号内)与非HS章节,避免误报(放行单单证号/企业编码)。
      if (doGoodsCheck && expected && expected.hs4set.size) {
        // 正向匹配:报关品名(全名)或 HS(章节+后续数字)出现在单据 → 货物对得上(字体抽不出HS列也能命中)
        const nameHit = expected.names.some((n) => n && n.length >= 2 && text.includes(n));
        const hs4Hit = [...expected.hs4set].some((h) => new RegExp("(?<!\\d)" + h + "\\d{2,6}(?!\\d)").test(text));
        if (nameHit || hs4Hit) {
          // ✓ 单据上出现本票货物名/HS → 一致,不报警
        } else if (/商品编[号码]/.test(text)) {
          // 真报关单但未正向匹配 → 抽HS判不符
          const validChap = (h) => { const c = +String(h).slice(0, 2); return c >= 1 && c <= 97; };
          const scan = (str) => [...String(str).matchAll(/(?<![\d（(])(\d{10})(?![\d/／])/g)].map((m) => m[1]);
          const cands = [...scan(text), ...scan(text.replace(/[ \t]+/g, ""))].filter(validChap);
          const docHs4 = new Set(cands.map(hs4).filter(Boolean));
          if (!docHs4.size) {
            warnings.push({ level: "warn", note: "⚠ 未能自动读取报关单商品编号HS(可能扫描/字体),请人工核对货物是否本票(应为 " + [...expected.hs4set][0] + " " + expected.names[0] + ")" });
          } else if (![...docHs4].some((h) => expected.hs4set.has(h))) {
            warnings.push({ level: "warn", note:
              "🚨 报关单货物与本票订单不符! 报关单 HS[" + [...docHs4].join(",") +
              "] vs 本票应为 [" + [...expected.hs4set].join(",") + " " + expected.names.slice(0, 3).join("/") +
              "]。极可能传错报关单,务必核对!" });
          }
        }
        // 非报关单(无商品编号列)且未正向匹配 → 不强报(放行单/提单本无商品HS)
      } else if (doGoodsCheck && /商品编[号码]/.test(text) && (!expected || !expected.hs4set.size)) {
        warnings.push({ level: "warn", note: "⚠ 系统中本票订单无 HS 可比对,请人工确认报关单货物是否本票" });
      }
      // A2. 提单号核验:文本里若没出现本票 BL 尾号
      if (blNo) {
        const tail = String(blNo).replace(/\s/g, "").slice(-6).toUpperCase();
        if (tail && !text.toUpperCase().replace(/\s/g, "").includes(tail)) {
          warnings.push({ level: doGoodsCheck ? "warn" : "info", note: "单据上未找到本票 BL「" + blNo + "」,请确认是否同一票" });
        }
      }
      return ok(warnings);
    }

    // ── B. 扫描件/图片(无文本):MiniMax-M3 OCR(PDF直接当 document 块 / 图片)→ 识别类型+HS+货物 交叉核验 ──
    const key = process.env.MINIMAX_API_KEY;
    let ocrOk = false;
    if (key) {
      try {
        const block = isPdf
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } }
          : { type: "image", source: { type: "base64", media_type: /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg", data: buf.toString("base64") } };
        const resp = await fetch(MINIMAX_URL, {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: "user", content: [block, { type: "text", text:
            '识别这份单据。只返回JSON:{"actual_type":"中文单据类型","hs_codes":["10位编码"],"goods":["货物名"],"is_match":这是否「' + expLabel + '」(true/false)}' }] }] }),
          signal: AbortSignal.timeout(25000),
        });
        if (resp.ok) {
          const data = await resp.json();
          const t = (Array.isArray(data.content) ? (data.content.find((c) => c && c.type === "text") || {}).text : "") || "";
          const parsed = JSON.parse((t.match(/\{[\s\S]*\}/) || ["{}"])[0]);
          ocrOk = true;
          if (parsed.is_match === false && parsed.actual_type) {
            warnings.push({ level: "warn", note: "这份像是「" + parsed.actual_type + "」，不是「" + expLabel + "」(放错单据格子?)" });
          }
          if (doGoodsCheck && expected && expected.hs4set.size) {
            const docHs4 = new Set((Array.isArray(parsed.hs_codes) ? parsed.hs_codes : []).map(hs4).filter(Boolean));
            const goodsHit = (Array.isArray(parsed.goods) ? parsed.goods : []).some((g) => g && expected.names.some((n) => n && (g.includes(n) || n.includes(g))));
            if (docHs4.size && [...docHs4].some((h) => expected.hs4set.has(h))) {
              // ✓ 扫描件识别出的 HS 对得上本票 → 货物一致
            } else if (goodsHit) {
              // ✓ 货物名对得上
            } else if (docHs4.size) {
              warnings.push({ level: "warn", note: "🚨 报关单货物与本票订单不符! 扫描件识别 HS[" + [...docHs4].join(",") +
                (Array.isArray(parsed.goods) && parsed.goods.length ? " " + parsed.goods.slice(0, 2).join("/") : "") +
                "] vs 本票应为 [" + [...expected.hs4set].join(",") + " " + expected.names.slice(0, 3).join("/") + "]。务必核对!" });
            } else {
              warnings.push({ level: "warn", note: "⚠ 扫描件未能识别商品编号HS,请人工核对货物是否本票(应为 " + [...expected.hs4set][0] + " " + expected.names[0] + ")" });
            }
          }
        }
      } catch (_) { /* fail-open */ }
    }
    if (doGoodsCheck && !ocrOk) {
      warnings.push({ level: "warn", note: "扫描件无法自动核验货物/HS,请人工确认这张报关单确属本票订单(货物/HS/提单号)" });
    }
    return ok(warnings);
  } catch (e) {
    console.error("[verify-doc]", e && e.message);
    // 报关单/放行单:异常也要给可见 warn,绝不静默"通过"(事故防线)
    const crit = GOODS_CHECK_TYPES.has((req.body || {}).expectedDocType);
    return ok(crit ? [{ level: "warn", note: "⚠ 核验过程出错,未能自动核验报关单货物,请人工核对" }] : []);
  }
}
