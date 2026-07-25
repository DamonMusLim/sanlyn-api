import { callMiniMaxVision } from "./slip-core.js";
import { lookupShipmentCandidatesByNos } from "./slip-ocr.js";

export const CLASSIFY_PROMPT = `Identify this ocean-shipping related document and extract matching keys. Use this dispatch table exactly:
- 货代账单: 费用逐列(THC/EDI/VGM/封条/拖车...)+提单号列,常xls; extract bl_no.
- BL提单: "Bill of Lading"/B/L No/Shipper/Consignee; extract bl_no.
- 报关单: 18位海关编号(PDF内文); extract customs_no(18位数字), contract_no.
- 进项发票: 发票代码/号码+税号+购买方; extract invoice_no, tax_no.
- 销项发票: 我司开出+客户抬头; extract invoice_no, customer.
- 装箱单: 柜号+铅封+件毛体; extract container_no, seal_no.
- EIR: EIR字样+柜号+提还箱; extract container_no.
- 托书: Booking确认字样; extract bl_no, booking_no.
- CO: 原产地证; extract contract_no, invoice_no.
- PI/SC/PO: 商品行+金额+客户; extract contract_no, customer.

Reply with ONLY valid JSON, no markdown:
{
  "doc_type": "货代账单|BL提单|报关单|进项发票|销项发票|装箱单|EIR|托书|CO|PI/SC/PO|无法识别",
  "confidence": "high|medium|low",
  "bl_no": "提单号或空",
  "container_no": "柜号或空(多个用逗号分隔)",
  "seal_no": "铅封号或空",
  "customs_no": "18位海关编号或空",
  "contract_no": "合同号或空",
  "invoice_no": "发票号或空",
  "booking_no": "订舱号或空",
  "customer": "客户名或空",
  "raw_text_summary": "这份文件上看到的关键信息简述,不要编造"
}
Do not invent data. 识别不出的字段留空字符串，别猜。低置信度(比如字迹模糊/信息不全)标confidence=low`;

const DOC_TYPES = new Set(["货代账单", "BL提单", "报关单", "进项发票", "销项发票", "装箱单", "EIR", "托书", "CO", "PI/SC/PO", "无法识别"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

function clean(v, max = 240) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : "";
}

function splitIds(v) {
  const seen = new Set();
  return String(v || "")
    .split(/[,，;；\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => {
      const key = s.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function splitContracts(v) {
  const seen = new Set();
  return String(v || "")
    .split(/[,，;；/]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => {
      const key = s.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function normalizeExtracted(parsed) {
  const out = {
    doc_type: clean(parsed?.doc_type, 40),
    confidence: clean(parsed?.confidence, 20).toLowerCase(),
    bl_no: clean(parsed?.bl_no),
    container_no: clean(parsed?.container_no),
    seal_no: clean(parsed?.seal_no),
    customs_no: clean(parsed?.customs_no, 40),
    contract_no: clean(parsed?.contract_no),
    invoice_no: clean(parsed?.invoice_no),
    booking_no: clean(parsed?.booking_no),
    customer: clean(parsed?.customer),
    raw_text_summary: clean(parsed?.raw_text_summary, 1000)
  };
  if (!DOC_TYPES.has(out.doc_type)) out.doc_type = "无法识别";
  if (!CONFIDENCE.has(out.confidence)) out.confidence = "low";
  return out;
}

export async function classifyAndExtract(fileBytes, filename, absPath, minimaxApiKey) {
  const { rawText, parsed } = await callMiniMaxVision(fileBytes, filename, absPath, minimaxApiKey, CLASSIFY_PROMPT);
  return { rawText, extracted: normalizeExtracted(parsed) };
}

async function candidatesFromPlans(pool, rows, matchedBy) {
  const candidates = [];
  const seenPlan = new Set();
  for (const plan of rows) {
    if (seenPlan.has(plan.id)) continue;
    seenPlan.add(plan.id);
    const orderNos = Array.isArray(plan.order_nos) ? plan.order_nos.filter(Boolean) : [];
    let contractNos = splitContracts(plan.contract_no);
    let issuingCompany = null;
    if (orderNos.length) {
      const orders = await pool.query(
        `SELECT order_no, contract_no,
                raw->>'issuingCompanyEN' AS issuing_en,
                raw->>'issuingCompany' AS issuing
           FROM orders
          WHERE order_no = ANY($1::text[])
          ORDER BY array_position($1::text[], order_no)`,
        [orderNos]
      );
      contractNos = [...new Set(contractNos.concat(orders.rows.map(r => r.contract_no).filter(Boolean)))].sort();
      issuingCompany = orders.rows.map(r => r.issuing_en || r.issuing).find(Boolean) || null;
    }
    const cb = await pool.query(
      `SELECT container_no
         FROM container_bookings
        WHERE shipping_plan_id=$1 AND COALESCE(container_no,'') <> ''
        ORDER BY container_no`,
      [plan.id]
    );
    let containerNos = cb.rows.map(r => r.container_no).filter(Boolean);
    if (!containerNos.length && plan.container_no) {
      containerNos = splitIds(plan.container_no);
    }
    candidates.push({
      shipment_no: plan.shipment_no || null,
      shipping_plan_id: plan.id,
      customer: plan.customer || plan.customer_cn || plan.customer_en || null,
      customer_cn: plan.customer_cn || null,
      customer_en: plan.customer_en || null,
      order_nos: orderNos,
      contract_nos: contractNos,
      container_nos: containerNos,
      bl_no: plan.bl_no || null,
      issuing_company: issuingCompany,
      matched_by: matchedBy
    });
  }
  return candidates;
}

async function matchByBlNo(pool, blNos) {
  const out = [];
  for (const blNo of blNos) {
    const r = await pool.query(
      `SELECT id, shipment_no, customer, customer_cn, customer_en,
              order_nos, bl_no, container_no, contract_no
         FROM shipping_plans
        WHERE bl_no ILIKE $1
        ORDER BY id DESC
        LIMIT 20`,
      [`%${blNo}%`]
    );
    out.push(...await candidatesFromPlans(pool, r.rows, "bl_no"));
  }
  return out;
}

async function matchByContainers(pool, containerNos) {
  const r = await pool.query(
    `SELECT DISTINCT sp.id, sp.shipment_no, sp.customer, sp.customer_cn, sp.customer_en,
            sp.order_nos, sp.bl_no, sp.container_no, sp.contract_no
       FROM container_bookings cb
       JOIN shipping_plans sp ON sp.id = cb.shipping_plan_id
      WHERE UPPER(BTRIM(cb.container_no)) = ANY($1::text[])
      ORDER BY sp.id DESC
      LIMIT 50`,
    [containerNos.map(v => v.toUpperCase())]
  );
  return candidatesFromPlans(pool, r.rows, "container_no");
}

async function matchByContractNo(pool, contractNos, matchedBy = "contract_no") {
  if (!contractNos.length) return [];
  const patterns = contractNos.map(v => `%${v}%`);
  const orders = await pool.query(
    `SELECT order_no, contract_no
       FROM orders
      WHERE contract_no ILIKE ANY($1::text[])
         OR order_no ILIKE ANY($1::text[])
      ORDER BY id DESC
      LIMIT 50`,
    [patterns]
  );
  const orderCandidates = orders.rows.map(row => ({
    shipment_no: null,
    shipping_plan_id: null,
    customer: null,
    order_nos: row.order_no ? [row.order_no] : [],
    contract_nos: row.contract_no ? [row.contract_no] : [],
    container_nos: [],
    bl_no: null,
    matched_by: matchedBy
  }));
  const orderNos = [...new Set(orders.rows.map(r => r.order_no).filter(Boolean))];
  if (!orderNos.length) return orderCandidates;
  const plans = await pool.query(
    `SELECT id, shipment_no, customer, customer_cn, customer_en,
            order_nos, bl_no, container_no, contract_no
       FROM shipping_plans
      WHERE order_nos && $1::text[]
      ORDER BY id DESC
      LIMIT 50`,
    [orderNos]
  );
  const planCandidates = await candidatesFromPlans(pool, plans.rows, matchedBy);
  return planCandidates.length ? planCandidates : orderCandidates;
}

async function matchByCustomsNo(pool, customsNo) {
  const no = clean(customsNo, 40);
  if (!/^\d{18}$/.test(no)) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT contract_no
         FROM finance_export_rebates
        WHERE customs_no=$1 AND COALESCE(contract_no,'') <> ''
        LIMIT 20`,
      [no]
    );
    return matchByContractNo(pool, r.rows.map(row => row.contract_no), "customs_no");
  } catch (_) {
    return [];
  }
}

export async function matchOceanDocCandidates(pool, extracted) {
  const candidates = [];
  const seen = new Set();
  const push = rows => {
    for (const c of rows) {
      const key = [c.shipping_plan_id || "", c.shipment_no || "", (c.contract_nos || []).join(","), c.bl_no || ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }
  };

  const cyNos = splitIds(extracted?.booking_no).filter(v => /^CY\d+$/i.test(v));
  if (cyNos.length) push(await lookupShipmentCandidatesByNos(pool, cyNos, "cy_no"));

  const blNos = splitIds(extracted?.bl_no);
  if (blNos.length) push(await matchByBlNo(pool, blNos));

  const containerNos = splitIds(extracted?.container_no);
  if (containerNos.length) push(await matchByContainers(pool, containerNos));

  if (clean(extracted?.customs_no)) push(await matchByCustomsNo(pool, extracted.customs_no));

  const contractNos = splitContracts(extracted?.contract_no);
  if (contractNos.length) push(await matchByContractNo(pool, contractNos));

  return candidates.slice(0, 50);
}
