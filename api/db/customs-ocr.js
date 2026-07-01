// api/db/customs-ocr.js — 报关单 OCR 抽取管道
// 报关单PDF(OSS) → pdftoppm → MiniMax-M3 → customs_declarations + customs_declaration_items
// 退税/对账镜像真实报关单。范本: slip-ocr.js。2026-06-20
// POST {doc_id}  或  {declaration_no}  [+ {dry_run:true} 只抽不存]
import { getPool, setCors } from "../db.js";
import OSS from "ali-oss";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

function ossClient() {
  return new OSS({
    region:          process.env.OSS_REGION           || "oss-cn-hongkong",
    accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket:          process.env.OSS_BUCKET           || "sanlyn-files",
  });
}

function pdfToJpeg(pdfPath) {
  return new Promise((resolve, reject) => {
    const tmpBase = path.join(os.tmpdir(), "cdecl_" + process.pid + "_" + Math.floor(performance.now()));
    execFile("pdftoppm", ["-jpeg", "-r", "160", "-f", "1", "-l", "1", pdfPath, tmpBase], (err) => {
      if (err) return reject(new Error("pdftoppm failed: " + err.message));
      for (const c of [tmpBase + "-1.jpg", tmpBase + "-01.jpg", tmpBase + "-001.jpg"]) {
        if (fs.existsSync(c)) { const d = fs.readFileSync(c); fs.unlinkSync(c); return resolve(d); }
      }
      reject(new Error("pdftoppm: output not found"));
    });
  });
}

function num(v) { const n = parseFloat(String(v ?? "").replace(/[, ]/g, "")); return isFinite(n) ? n : null; }
function s(v) { return (v == null ? "" : String(v)).trim(); }

const OCR_PROMPT = `这是一张中华人民共和国海关出口货物报关单。提取所有字段，只回 valid JSON，不要 markdown。报关单的"数量及单位"列通常有两行：第一行是法定第一数量+单位(如千克)，第二行是第二数量+单位(如个/包)。两个都要抽。金额按报关单币制(常见人民币CNY)。不要编造，未知文本用""，未知数字用null。
{
  "declaration_no": "海关编号(右上18位)",
  "pre_entry_no": "预录入编号",
  "export_date": "出口日期 YYYY-MM-DD",
  "declare_date": "申报日期 YYYY-MM-DD",
  "domestic_shipper": "境内发货人名称",
  "overseas_consignee": "境外收货人名称",
  "producer_seller": "生产销售单位名称",
  "contract_no": "合同协议号",
  "trade_country": "贸易国(地区)",
  "arrive_country": "运抵国(地区)",
  "dest_port": "指运港",
  "transaction_term": "成交方式(FOB/CIF/CFR等)",
  "transport_mode": "运输方式",
  "supervision_mode": "监管方式",
  "duty_exemption": "征免性质",
  "total_packages": "件数(数字)",
  "gross_weight_kg": "毛重千克(数字)",
  "net_weight_kg": "净重千克(数字)",
  "container_nos": "集装箱号",
  "total_amount": "申报总价合计(数字)",
  "total_currency": "币制(如人民币/CNY/USD)",
  "items": [
    {
      "hs_code": "商品编号(HS,10位)",
      "name_cn": "商品名称",
      "spec": "规格型号/申报要素(整段照抄)",
      "qty1": "法定第一数量(数字)",
      "unit1": "法定第一单位(如千克)",
      "qty2": "第二数量(数字,如包/个)",
      "unit2": "第二单位(如包)",
      "unit_price": "单价(数字)",
      "amount": "总价/金额(数字)",
      "currency": "币制",
      "origin_country": "原产国(地区)",
      "dest_country": "最终目的国(地区)",
      "source_region": "境内货源地"
    }
  ]
}`;

async function ocr(imgBytes) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const b64 = imgBytes.toString("base64");
  const resp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "MiniMax-M3", max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: OCR_PROMPT },
      ]}],
    }),
  });
  if (!resp.ok) throw new Error("MiniMax HTTP " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in OCR reply: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}


export async function runCustomsOcr(pool, { doc_id, declaration_no, dry_run = false, contract_no: bodyContractNo } = {}) {
  const q = doc_id
    ? await pool.query(`SELECT id, doc_id, url, name, contract_no FROM document_uploads WHERE doc_id=$1 AND doc_type IN ('customs_decl','customs_declaration') ORDER BY uploaded_at DESC LIMIT 1`, [doc_id])
    : await pool.query(`SELECT id, doc_id, url, name, contract_no FROM document_uploads WHERE (name ILIKE '%'||$1||'%' OR url ILIKE '%'||$1||'%') AND doc_type IN ('customs_decl','customs_declaration') ORDER BY uploaded_at DESC LIMIT 1`, [declaration_no || ""]);
  if (!q.rows.length) {
    const err = new Error("找不到报关单PDF (document_uploads)");
    err.status = 404;
    throw err;
  }
  const doc = q.rows[0];

  const ord = await pool.query(`SELECT shipping_plan_id, contract_no, factory_company_id FROM orders WHERE order_no=$1 LIMIT 1`, [doc.doc_id]);
  const shippingPlanId = ord.rows[0]?.shipping_plan_id || null;
  const contractNo = ord.rows[0]?.contract_no || doc.contract_no || bodyContractNo || null;

  let objKey = doc.url;
  try { objKey = new URL(doc.url).pathname.replace(/^\/+/, ""); } catch {}
  const obj = await ossClient().get(objKey);
  const tmpPdf = path.join(os.tmpdir(), "cdecl_" + process.pid + ".pdf");
  fs.writeFileSync(tmpPdf, obj.content);
  let jpeg;
  try { jpeg = await pdfToJpeg(tmpPdf); } finally { try { fs.unlinkSync(tmpPdf); } catch {} }

  const parsed = await ocr(jpeg);
  if (dry_run) return { success: true, dry_run: true, doc: doc.doc_id, parsed };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const declNo = s(parsed.declaration_no) || s(declaration_no);

    let rebateMatched = 0;
    let fobCnyAction = "need_manual";
    let fobCnyWritten = null;

    if (contractNo) {
      const u = await client.query(
        `UPDATE finance_export_rebates SET raw=$1, updated_at=NOW() WHERE contract_no=$2 RETURNING id`,
        [JSON.stringify(parsed), contractNo]
      );
      rebateMatched = u.rows.length;

      const currency = s(parsed.total_currency).toUpperCase();
      const isCny = ["CNY", "RMB", "人民币"].includes(currency);
      const cny = num(parsed.total_amount);

      if (!isCny) {
        fobCnyAction = "skip_non_cny";
      } else if (rebateMatched !== 1 || cny == null) {
        fobCnyAction = "need_manual";
      } else {
        const f = await client.query(
          `UPDATE finance_export_rebates
              SET fob_cny=$1,
                  rebate_expected=ROUND(($1 * COALESCE(rebate_rate,0.09))::numeric, 2),
                  updated_at=NOW()
            WHERE contract_no=$2
              AND COALESCE(fob_cny,0)=0
            RETURNING fob_cny`,
          [cny, contractNo]
        );
        if (f.rows.length) {
          fobCnyAction = "filled";
          fobCnyWritten = Number(f.rows[0].fob_cny);
        } else {
          fobCnyAction = "already";
        }
      }
    }

    let declId = null;
    if (shippingPlanId) {
      const h = await client.query(`
        INSERT INTO customs_declarations
          (declaration_no, shipping_plan_id, trade_country, arrive_country, transaction_term, transport_mode,
           supervision_mode, duty_exemption, total_declaration_amount, total_declaration_currency,
           container_nos, declared_at, source_system, raw, created_at, updated_at)
        VALUES ($1,$13,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'customs-ocr',$12,NOW(),NOW())
        ON CONFLICT (declaration_no) DO UPDATE SET
          total_declaration_amount=EXCLUDED.total_declaration_amount, raw=EXCLUDED.raw, updated_at=NOW()
        RETURNING id`,
        [declNo || ("SP" + shippingPlanId), s(parsed.trade_country), s(parsed.arrive_country), s(parsed.transaction_term),
         s(parsed.transport_mode), s(parsed.supervision_mode), s(parsed.duty_exemption),
         num(parsed.total_amount), s(parsed.total_currency) || "CNY",
         s(parsed.container_nos) ? s(parsed.container_nos).split(/[,，\s]+/).filter(Boolean) : null,
         parsed.export_date || null, JSON.stringify(parsed), shippingPlanId]);
      declId = h.rows[0].id;

      await client.query(`DELETE FROM customs_declaration_items WHERE declaration_id=$1 AND source_system='customs-ocr'`, [declId]);
      let sort = 0;
      for (const it of (parsed.items || [])) {
        await client.query(`
          INSERT INTO customs_declaration_items
            (declaration_id, hs_code, declaration_name_cn, declaration_elements,
             qty, unit, gross_weight_kg, net_weight_kg, declaration_amount, declaration_currency,
             unit_price, country_of_origin, destination_country, factory_address,
             source_type, sort_order, source_system, raw, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'customs_ocr',$15,'customs-ocr',$16,NOW(),NOW())`,
          [declId, s(it.hs_code), s(it.name_cn), s(it.spec),
           num(it.qty1), s(it.unit1), num(parsed.gross_weight_kg), num(parsed.net_weight_kg),
           num(it.amount), s(it.currency) || s(parsed.total_currency) || "CNY",
           num(it.unit_price), s(it.origin_country), s(it.dest_country), s(it.source_region),
           sort++, JSON.stringify({ qty2: it.qty2, unit2: it.unit2, total_packages: parsed.total_packages })]);
      }
    }

    await client.query(`UPDATE document_uploads SET ocr_status='done', ocr_raw=$1 WHERE id=$2`, [JSON.stringify(parsed), doc.id]);
    await client.query("COMMIT");

    return {
      success: true,
      declaration_no: declNo,
      contract_no: contractNo,
      rebate_matched: rebateMatched,
      customs_decl_id: declId,
      items: (parsed.items || []).length,
      fob_cny_action: fobCnyAction,
      fob_cny_written: fobCnyWritten,
      parsed,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  try {
    const result = await runCustomsOcr(getPool(), req.body || {});
    return res.status(200).json(result);
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
