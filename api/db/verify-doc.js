// /api/db/verify-doc.js — 上传回执单据 AI 核验 (MiniMax)
// POST { url, expectedDocType, expectedLabel, blNo, contractNo }
//   → { warnings: [{ level:"warn"|"info", note }] }
//
// FAIL-OPEN 铁律: 任何错误/超时/未配置 → 返回 { warnings: [] } (或 info 级提示),
//   绝不阻断上传/显示。前端只在有 warn 时挂 ⚠️。
// 用 process.env.MINIMAX_API_KEY (绝不硬编码 key)。PDF 优先 pdf-parse 抽文本(免渲染),
//   图片走 MiniMax 视觉; 扫描件无文本 → info "请人工核对"。
import { setCors } from "../db.js";
// 深层导入绕开 pdf-parse 1.x 的 debug 入口(ESM 下 module.parent=undefined 会读测试文件抛错)
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const MINIMAX_URL = "https://api.minimaxi.com/anthropic/v1/messages";
const MODEL = "MiniMax-M2.7-highspeed";

const TYPE_CN = {
  customs_decl: "报关单", decl_auth: "报关委托书", insp_auth: "报检委托书",
  fumigation: "熏蒸/消毒证书", customs_release: "海关放行单/放行通知",
  telex_release: "电放通知书", telex_loi: "电放保函/切结书",
  non_dg_decl: "非危险品承诺书/声明", vgm: "VGM 称重单",
  eir: "设备交接单 EIR", booking_so: "订舱确认/SO",
};

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const ok = (warnings = []) => res.status(200).json({ warnings });   // fail-open
  if (req.method !== "POST") return ok();

  try {
    const b = req.body || {};
    const { url, expectedDocType, blNo } = b;
    if (!url || !expectedDocType) return ok();
    const expLabel = b.expectedLabel || TYPE_CN[expectedDocType] || expectedDocType;

    const key = process.env.MINIMAX_API_KEY;
    if (!key) return ok();   // 未配置 → 静默 fail-open

    // 取文件
    let buf;
    try {
      const fr = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!fr.ok) return ok();
      buf = Buffer.from(await fr.arrayBuffer());
    } catch (_) { return ok(); }

    const isPdf = /\.pdf(\?|$)/i.test(url) || buf.slice(0, 5).toString("latin1") === "%PDF-";
    let content;
    if (isPdf) {
      let text = "";
      try { const p = await pdfParse(buf); text = (p.text || "").replace(/\s+\n/g, "\n").slice(0, 6000); } catch (_) {}
      if (!text.trim()) return ok([{ level: "info", note: "扫描件无法自动核验，请人工核对单据类型" }]);
      content = [{ type: "text", text: "这是一份单据的文本内容:\n" + text }];
    } else {
      const mt = /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg";
      content = [{ type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } }];
    }

    content.push({ type: "text", text:
      "任务: 判断这份单据【实际是什么类型】, 并提取其中的【提单号BL或合同号】。\n" +
      "用户把它归类为「" + expLabel + "」。\n" +
      (blNo ? "这票货的提单号应为: " + blNo + "。\n" : "") +
      "只返回 JSON, 不要任何解释: " +
      '{"actual_type":"中文单据类型","bl_or_no":"单据中的提单号/合同号(没有则空字符串)","is_match":true或false(实际类型是否就是上面用户归类的那种)}',
    });

    let data;
    try {
      const resp = await fetch(MINIMAX_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(11000),
      });
      if (!resp.ok) return ok();
      data = await resp.json();
    } catch (_) { return ok(); }

    const txt = (data && data.content && data.content[0] && data.content[0].text) || "";
    let parsed;
    try { parsed = JSON.parse((txt.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (_) { return ok(); }

    const warnings = [];
    if (parsed.is_match === false && parsed.actual_type) {
      warnings.push({ level: "warn", note: "这份像是「" + parsed.actual_type + "」，不是「" + expLabel + "」" });
    }
    if (blNo && parsed.bl_or_no) {
      const a = String(parsed.bl_or_no).replace(/\s/g, ""), e = String(blNo).replace(/\s/g, "");
      const tail = e.slice(-6);
      if (tail && !a.includes(tail) && !e.includes(a.slice(-6))) {
        warnings.push({ level: "warn", note: "单据上的单号「" + parsed.bl_or_no + "」与这票 BL「" + blNo + "」对不上" });
      }
    }
    return ok(warnings);
  } catch (e) {
    console.error("[verify-doc]", e && e.message);
    return ok();   // fail-open
  }
}
