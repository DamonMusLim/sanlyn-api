// /api/db/receipt-doc.js
// 收款证明 — 跨境业务人民币结算收款说明（2016版）
// 银行官方合规单据：不重画排版，只在原版 docx 母版里灌数据。
// 母版 = public/templates/receipt-master.docx（银行原件 + {字段} 占位符，未改任何格子/边框/字体）。
// 铁律：只有系统查得到、确定属实的字段才自动填；其余一律留空，绝不猜金额/贸易方式/国际收支编码。

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { PDFDocument } from "pdf-lib";
import { loadSellerCfg } from "./doc-data.js";

const execFileAsync = promisify(execFile);
const TEMPLATE_PATH = path.join(process.cwd(), "public/templates/receipt-master.docx");
const DEFAULT_FILLER_NAME = "林志凌"; // Damon 指定:所有收款证明的填报人都是这个名字

function stripCompanyPrefix(s) {
  if (!s) return "";
  return String(s).replace(/^\d+-/, "");
}

// 表格填写说明：组织机构代码栏填"统一社会信用代码第9-18位"，不是完整18位代码
function orgCodeSegment(taxNo) {
  if (!taxNo) return "";
  return String(taxNo).slice(-10);
}

// 收款日期栏填打印/生成当天日期（银行单上的"收款日期"经常跟实际处理日期对不上，就填打印这份文件当天）
function formatReceiptDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}年${m}月${day}日`;
}

// 公司抬头模版（Damon 保存的"模版1/模版2..."，可编辑，见 receipt_company_templates 表）
export async function loadReceiptCompanyTemplate(pool, templateKey) {
  const r = await pool.query(`SELECT * FROM receipt_company_templates WHERE template_key=$1`, [templateKey]);
  return r.rows[0] || null;
}

export async function listReceiptCompanyTemplates(pool) {
  const r = await pool.query(`SELECT template_key, label, company_name, trade_type FROM receipt_company_templates ORDER BY id`);
  return r.rows;
}

// 把 docx 灌好的数据转成 PDF（走 LibreOffice headless，tencent 已装 /usr/bin/soffice）
async function docxBufferToPdf(docxBuffer) {
  const tmpDir = path.join(os.tmpdir(), "receipt-doc-" + randomUUID());
  fs.mkdirSync(tmpDir, { recursive: true });
  const docxPath = path.join(tmpDir, "filled.docx");
  fs.writeFileSync(docxPath, docxBuffer);
  try {
    await execFileAsync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, docxPath], { timeout: 30000 });
    const pdfPath = path.join(tmpDir, "filled.pdf");
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 把公章图叠到"单位公章或财务专用章"那一行附近（近似定位，母版排版固定，坐标基于A4 150dpi实测换算）
async function stampSeal(pdfBuffer, sealUrl) {
  if (!sealUrl) return pdfBuffer;
  try {
    const imgRes = await fetch(sealUrl);
    if (!imgRes.ok) return pdfBuffer;
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const page = pages[0];
    let img;
    try { img = await pdfDoc.embedPng(imgBytes); }
    catch (e) { img = await pdfDoc.embedJpg(imgBytes); }
    const dims = img.scale(1);
    const w = 60, h = (dims.height / dims.width) * 60;
    // 定位在"单位公章或财务专用章"印刷字样右侧的空白处，避免盖住上方"备注/申明"文字行
    // 注：seal_url 原图无透明通道(RGB无alpha)，降低透明度减轻底色遮挡——图片本身待补透明版
    page.drawImage(img, { x: 155, y: 138, width: w, height: h, opacity: 0.5 });
    return Buffer.from(await pdfDoc.save());
  } catch (e) {
    console.error("[receipt-doc] stampSeal failed:", e.message);
    return pdfBuffer; // 盖章失败不阻断整份单据的生成
  }
}

// refs: 单个 shipment id/BL，或数组(银行一笔汇款合并覆盖多票，如 FI-CY00365+FI-CY00362 一起汇)
// overrides: 来自真实收款凭证(入账通知书)的字段，比 shipping_plans 的报价金额更权威——
//   银行实际到账金额(amount_total)/汇款人名称(payer_name)/收款日期(receipt_date)。
//   有 override 就用 override，没有才退回系统查到的值；不覆盖=不是没查到，是"这个字段银行单没给，系统值更可信"。
export async function renderReceiptDoc(pool, refs, overrides = {}) {
  const refList = Array.isArray(refs) ? refs.filter(Boolean) : [refs].filter(Boolean);
  if (!refList.length) return null;

  const ph = refList.map((_, i) => `$${i + 1}`).join(",");
  const planRes = await pool.query(
    `SELECT * FROM shipping_plans WHERE _id IN (${ph}) OR shipment_no IN (${ph}) OR id::text IN (${ph}) OR bl_no IN (${ph})`,
    refList
  );
  if (!planRes.rows.length) return null;
  const plans = planRes.rows;
  const p = plans[0]; // 主票：用于卖方/客户口径判定，多票时金额/合同号取全部汇总

  let orders = [];
  const allOrderNos = plans.flatMap(pl => pl.order_nos || pl.contract_nos || []);
  if (allOrderNos.length > 0) {
    const ph2 = allOrderNos.map((_, i) => `$${i + 1}`).join(",");
    const oRes = await pool.query(
      `SELECT _id, order_no, contract_no, customer_po, raw FROM orders
       WHERE order_no IN (${ph2}) OR contract_no IN (${ph2}) OR _id::text IN (${ph2})`,
      allOrderNos
    );
    orders = oRes.rows;
  }

  const sellerCfg = await loadSellerCfg(pool, {}, null, { shipping: true });
  const customerName = p.customer_cn || p.customer_en || p.customer || "";
  const contractNos = [...new Set(orders.map(o => stripCompanyPrefix(o.contract_no)).filter(Boolean))];
  const contractNo = contractNos.length
    ? contractNos.join(", ")
    : plans.flatMap(pl => Array.isArray(pl.contract_nos) ? pl.contract_nos.map(stripCompanyPrefix) : []).join(", ");
  // 系统报价金额(单票 freight_total_cny 求和)——仅在银行单没给实收金额时兜底
  const quotedAmount = plans.reduce((s, pl) => s + Number(pl.freight_total_cny || 0), 0);
  const amountCny = overrides.amount_total != null && overrides.amount_total !== ""
    ? Number(overrides.amount_total).toFixed(2)
    : (quotedAmount > 0 ? quotedAmount.toFixed(2) : "");

  const currency = (overrides.currency || "CNY").toUpperCase();
  const data = {
    receipt_date: overrides.receipt_date || formatReceiptDate(),
    receipt_company_name: sellerCfg.nameCN || sellerCfg.nameEN || "",
    receipt_org_code: orgCodeSegment(sellerCfg.taxNo),
    payer_name: overrides.payer_name || customerName,
    payer_country: overrides.payer_country || "",
    contract_no: contractNo,
    amount_total: amountCny,
    service_trade_amount: amountCny,
    service_trade_bop_code: "222011", // 出口海运费固定BOP编码(照真实填报案例)
    service_trade_contract_no: contractNo,
    receipt_nature: "出口海运费",
    filler_tel: sellerCfg.tel || "",
    filler_name: (overrides.filler_name || DEFAULT_FILLER_NAME) + "      ", // 后面留空格,不然跟紧挨着的"联系电话"标签挤在一起
    // 已报关/人民币报关那组勾选是"货物报关"专用的，海运费/服务贸易不适用，不勾
    rmb_check: "□",
    fx_check: "□",
    // 货物贸易那组字段这条(海运费/服务贸易)路径不适用，留空
    goods_trade_amount: "",
    goods_desc: "",
    customs_broker_name: "",
    customs_broker_org_code: "",
  };

  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  const filledDocx = doc.getZip().generate({ type: "nodebuffer" });

  let pdfBuffer = await docxBufferToPdf(filledDocx);
  if (overrides.stamp_seal !== false) {
    pdfBuffer = await stampSeal(pdfBuffer, sellerCfg.seal_url);
  }

  const shipmentLabel = plans.map(pl => pl.shipment_no).filter(Boolean).join("+") || refList[0];
  return {
    pdfBuffer,
    docxBuffer: filledDocx,
    filename: `收款证明_${shipmentLabel}.pdf`,
    matchedShipments: plans.map(pl => pl.shipment_no).filter(Boolean),
    missingFields: {
      receipt_org_code: !data.receipt_org_code,
      amount_total: !data.amount_total,
      payer_name: !data.payer_name,
    },
    usedBankOverride: !!(overrides.amount_total || overrides.payer_name),
  };
}

// 按 Damon 保存的"公司抬头模版"(receipt_company_templates)生成——不依赖 shipping_plans/refs 匹配，
// 适用于：货物贸易收款(无海运票号可关联)、或想直接指定抬头而不经系统查询的场景。
// templateKey: 'template1_xiamen_babi' | 'template2_shanghai_oceanbaby' | 未来新增的模版
// overrides: amount_total(必填,银行实收金额) / payer_name(必填,汇款人) / contract_no / goods_desc(货物贸易场景用,如"宠物食品")
//   / trade_classification(货物贸易场景,"一般贸易"/"预收货款",默认"一般贸易") / currency(默认CNY) / receipt_date
export async function renderReceiptDocByTemplate(pool, templateKey, overrides = {}) {
  const tpl = await loadReceiptCompanyTemplate(pool, templateKey);
  if (!tpl) return null;
  if (overrides.amount_total == null || overrides.amount_total === "") return null;

  const amountCny = Number(overrides.amount_total).toFixed(2);
  const currency = (overrides.currency || "CNY").toUpperCase();
  const isGoods = tpl.trade_type === "goods";
  const orgCode = orgCodeSegment(tpl.org_code_full);

  const data = {
    receipt_date: overrides.receipt_date || formatReceiptDate(),
    receipt_company_name: tpl.company_name,
    receipt_org_code: orgCode,
    payer_name: overrides.payer_name || "",
    payer_country: overrides.payer_country || "",
    contract_no: overrides.contract_no || "",
    amount_total: amountCny,
    filler_tel: tpl.filler_tel || "",
    filler_name: (overrides.filler_name || DEFAULT_FILLER_NAME) + "      ", // 后面留空格,不然跟紧挨着的"联系电话"标签挤在一起
    // 已报关/人民币报关那组勾选是"货物报关"专用的，海运费/服务贸易(isGoods=false)不勾
    rmb_check: isGoods ? (currency === "CNY" ? "☑" : "□") : "□",
    fx_check: isGoods ? (currency === "CNY" ? "□" : "☑") : "□",
    // 服务贸易(海运费)字段
    service_trade_amount: isGoods ? "" : amountCny,
    service_trade_bop_code: isGoods ? "" : "222011",
    service_trade_contract_no: isGoods ? "" : (overrides.contract_no || ""),
    // 货物贸易字段
    goods_trade_amount: isGoods ? amountCny : "",
    goods_desc: isGoods ? (overrides.goods_desc || "") : "",
    customs_broker_name: isGoods ? tpl.company_name : "",
    customs_broker_org_code: isGoods ? orgCode : "",
    receipt_nature: isGoods
      ? `${overrides.goods_desc || ""} ${overrides.trade_classification || "一般贸易"}`.trim()
      : "出口海运费",
  };

  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  const filledDocx = doc.getZip().generate({ type: "nodebuffer" });

  let pdfBuffer = await docxBufferToPdf(filledDocx);
  if (overrides.stamp_seal && tpl.seal_url) {
    pdfBuffer = await stampSeal(pdfBuffer, tpl.seal_url);
  }

  return {
    pdfBuffer,
    docxBuffer: filledDocx,
    filename: `收款证明_${tpl.label}_${overrides.payer_name || ""}.pdf`.replace(/\s+/g, ""),
    templateUsed: tpl.template_key,
    missingFields: {
      payer_name: !data.payer_name,
      contract_no: !data.contract_no,
      goods_desc: isGoods && !data.goods_desc,
    },
  };
}
