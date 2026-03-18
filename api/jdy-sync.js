// /api/jdy-sync.js
// Vercel Serverless Function — JDY Webhook → OSS Upsert
// JDY pushes on form change → upserts record into matching JSON on OSS
// Auth: JDY Secret field in payload body matched against JDY_SYNC_SECRET env var

import OSS from "ali-oss";

// ── 上传 JDY 附件到 OSS（返回永久 URL）────────────────────────
async function uploadAttachmentsToOSS(client, attachments, contractNo, companyCode) {
  if (!attachments) return {};
  const result = {};
  const bucket = process.env.OSS_BUCKET || "sanlyn-files";
  const region = process.env.OSS_REGION || "oss-cn-hongkong";
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const folder = "documents/" + year + "/" + month + "/" + (companyCode || "UNKNOWN") + "/" + contractNo;

  for (const [key, att] of Object.entries(attachments)) {
    if (!att || !att.url) continue;
    try {
      const resp = await fetch(att.url);
      if (!resp.ok) { console.warn("[jdy-sync] attachment fetch failed:", key, resp.status); continue; }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const ext = att.name ? att.name.split(".").pop() : "xlsx";
      const ossKey = folder + "/" + key.toUpperCase() + "_" + contractNo + "." + ext;
      await client.put(ossKey, buffer, {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers: { "Cache-Control": "public, max-age=31536000" },
      });
      const ossUrl = "https://" + bucket + "." + region + ".aliyuncs.com/" + ossKey;
      result[key] = { url: ossUrl, name: att.name, ossKey };
      console.log("[jdy-sync] uploaded attachment:", key, "->", ossKey);
    } catch (e) {
      console.error("[jdy-sync] attachment upload error:", key, e.message);
      result[key] = att; // 降级用 JDY 原始 URL
    }
  }
  return result;
}

// ── CORS ────────────────────────────────────────────────────
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── OSS client ──────────────────────────────────────────────
function getOSSClient() {
  return new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
}

// ── OSS read/write ──────────────────────────────────────────
async function readJSON(client, ossKey) {
  try {
    const result = await client.get(ossKey);
    const text = result.content.toString("utf-8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed
      : parsed.orders || parsed.data || parsed.payments || parsed.invoices || parsed.documents || parsed.customers || parsed.products || [];
  } catch (e) {
    console.warn(`[jdy-sync] readJSON ${ossKey} empty/missing:`, e.message);
    return [];
  }
}

async function writeJSON(client, ossKey, arr) {
  const jsonString = JSON.stringify(arr, null, 2);
  await client.put(ossKey, Buffer.from(jsonString, "utf-8"), {
    mime: "application/json",
    headers: { "Cache-Control": "no-cache" },
  });
}

// ── Tracking fields preserved on upsert ─────────────────────
const TRACKING_FIELDS = ["currentStatus","currentStatusCn","trackingUpdatedAt","atd","vessel","voyage","eta","pdfUrls"];

// ── Table config ─────────────────────────────────────────────
const ENTRY_CONFIG = {
  "6912a100e6f679d3089bd434": { ossKey: "data/shipping_plans.json", mapper: mapShippingPlan },
  "6419d478b9b91b00091e4d73": { ossKey: "data/orders.json",           mapper: mapOrder },
  "692a7c7d85918bdb075ee048": { ossKey: "data/customers.json",        mapper: mapCustomer },
  "691e74ea175dfbf0607cc820": { ossKey: "data/customs.json",          mapper: mapCustoms },
  "694a4c10c530d677dc4ca0ef": { ossKey: "data/finance_payments.json", mapper: mapPayment },
  "694a48730faafd8a569db179": { ossKey: "data/finance_invoices.json", mapper: mapInvoice },
  "68b8070a2c88a206947652d4": { ossKey: "data/credit_notes.json",     mapper: mapCreditNote },
  "691e76b3cb637ee7ef1f25ca": { ossKey: "data/documents.json",        mapper: mapDocs },
};

// ── Mappers ──────────────────────────────────────────────────

function mapShippingPlan(r) {
  return {
    _id: r._id,
    shipmentNo: r._widget_1762828544749 || "",
    contractNo: r._widget_1765451948626 || "",
    orderNos: r._widget_1767084770362 || "",
    customerCompanyEN: r._widget_1766568840023 || r._widget_1766913567261 || "",
    shippingLine: r._widget_1765450157283 || "",
    pol: r._widget_1764591553171 || "",
    pod: r._widget_1764591553172 || "",
    containerQty: r._widget_1765450157285 || null,
    containerType: r._widget_1766895482504 || "",
    routeType: r._widget_1767156945734 || "",
    voyageNo: r._widget_1765450157284 || r._widget_1771626741569 || "",
    shipmentDate: r._widget_1764582236204 ? r._widget_1764582236204.slice(0,10) : null,
    eta: r._widget_1769075239993 ? r._widget_1769075239993.slice(0,10) : (r._widget_1771626741567 ? r._widget_1771626741567.slice(0,10) : null),
    cutoffDate: r._widget_1771626741547 ? r._widget_1771626741547.slice(0,10) : null,
    etd: r._widget_1771626741566 ? r._widget_1771626741566.slice(0,10) : null,
    blNo: r._widget_1771626741557 || "",
    containerNo: r._widget_1771626741552 || "",
    vessel: r._widget_1771626741568 || "",
    freightSaleUSD: r._widget_1766566622260 || 0,
    freightCost: r._widget_1768299925392 || 0,
    portSurchargeTotal: r._widget_1766460409789 || 0,
    customsCostTotal: r._widget_1768641952534 || 0,
    truckingCostTotal: r._widget_1768641952536 || 0,
    status: (r._widget_1769075239993 && (new Date() - new Date(r._widget_1769075239993)) > 30*24*60*60*1000) ? "completed" : "in_progress",
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
    factoryName: r._widget_1773256056291 || "",
    tradeTerms: r._widget_1766977056109 || "",
  };
}

function mapOrder(r) {
  const extractFile = (files) => files && files.length > 0 ? { url: files[0].url, name: files[0].name } : null;
  const CATEGORY_MAP = {"湿粮":"Wet Food","干粮":"Dry Food","零食":"Treats","猫砂":"Cat Litter","豆腐猫砂":"Tofu Cat Litter","膨润土猫砂":"Bentonite Litter","矿砂":"Mineral Litter","保健品":"Health Supplements","药品":"Medication"};
  const COMPANY_CODE = n => {
    const u = (n||"").toUpperCase();
    if (u.includes("PETSOME (EU)") || u.includes("PETSOME EU")) return "PETSOME_EU";
    if (u.includes("PETSOME")) return "PETSOME";
    if (u.includes("DIBAQ")) return "DIBAQ";
    if (u.includes("HARMONIOUS")) return "HARMONIOUS";
    if (u.includes("ENRICH CHAMPION")) return "ENRICH";
    if (u.includes("JJ PET")) return "JJ_PET";
    if (u.includes("FORTUNESANLYN")) return "FORTUNESANLYN";
    if (u.includes("EVERSPARKLES")) return "EVERSPARKLES";
    if (u.includes("MAGROS")) return "MAGROS";
    return "";
  };
  const companyNameEN = r._widget_1764468507574 || "";
  const rawCat = ((r._widget_1764396068557||[])[0]||{})._widget_1766565146298 || "";
  return {
    _id: r._id,
    contractNo: r._widget_1679903024720 || "",
    customerPO: r._widget_1756914144559 || "",
    companyNameEN,
    companyCode: COMPANY_CODE(companyNameEN),
    pol: r._widget_1764591186973 || "",
    pod: r._widget_1764471197748 || "",
    orderDate: r._widget_1663812600609 ? r._widget_1663812600609.substring(0,10) : "",
    deliveryDate: r._widget_1765186212190 ? r._widget_1765186212190.substring(0,10) : "",
    actDelivery: r._widget_1766462809214 ? r._widget_1766462809214.substring(0,10) : "",
    containerType: r._widget_1766564550881 || "",
    totalBoxes: r._widget_1764467945301 || null,
    grossWeight: r._widget_1766897323225 || null,
    category: CATEGORY_MAP[rawCat] || rawCat,
    shipperCompany: r._widget_1765194153605 || r._widget_1769078795960 || "",
    shipperCompanyEN: r._widget_1769078795960 || "",
    factoryName: r._widget_1765186212182 || "",
    totalAmount: r._widget_1764467945302 || 0,
    totalAmountFactory: r._widget_1765186561849 || 0,
    subCategory: r._widget_1766653844751 || "",
    markupPct: r._widget_1770617111967 || 0,
    currency: r._widget_1766977056108 || "USD",
    tradeTerms: r._widget_1766977056109 || "",
    productionStatus: r._widget_1769075239994 || "",
    products: (r._widget_1764396068557||[]).map(p => ({
      name: p._widget_1764396068574 || "",
      qty: p._widget_1764396068583 || 0,
      category: p._widget_1766565146298 || "",
      factory: p._widget_1765186212182 || "",
    })),
    attachments: {
      sc: extractFile(r._widget_1771709164165),
      iv: extractFile(r._widget_1769078158887),
      pl: extractFile(r._widget_1771709164164),
      pi: extractFile(r._widget_1769418068618),
      po: extractFile(r._widget_1769417235037),
    },
  };
}

function mapCustomer(r) {
  const bankRows = r._widget_1764393728384 || [];
  const cnyBank = bankRows.find(b => (b._widget_1764393728388||"").includes("CNY")) || bankRows[0] || {};
  const usdBank = bankRows.find(b => (b._widget_1764393728388||"").toUpperCase().includes("USD")) || {};
  const nameEN = r._widget_1764392061245 || "";
  const companyCode = r._widget_1771622004938 || "";
  return {
    _id: r._id,
    code: r._widget_1759129660625 || companyCode || "",
    name: nameEN || r._widget_1764392061244 || "",
    nameCN: r._widget_1764392061244 || "",
    nameEN,
    companyCode,
    groupId: r._widget_1764478692414 || companyCode,
    country: r._widget_1768475611585 || "",
    roleType: r._widget_1764394732264 || "",
    invoice: {
      nameEN,
      nameCN: r._widget_1764392061244 || "",
      taxNo: r._widget_1764392061247 || "",
      addressCN: r._widget_1764392061249 || "",
      addressEN: r._widget_1764394732272 || "",
      phone: String(r._widget_1764392061253 || ""),
      bankCNY: {
        beneficiary: r._widget_1764392061244 || "",
        bankNameCN: cnyBank._widget_1764393728390 || "",
        bankNameEN: cnyBank._widget_1764393728391 || "",
        account: cnyBank._widget_1764393728392 || "",
        swift: cnyBank._widget_1764393728393 || "",
      },
      bankUSD: {
        beneficiary: nameEN || r._widget_1764392061244 || "",
        bankNameEN: usdBank._widget_1764393728391 || usdBank._widget_1764393728390 || "",
        account: usdBank._widget_1764393728392 || "",
        swift: usdBank._widget_1764393728393 || "",
        iban: usdBank._widget_1764393728396 || "",
        bankAddress: usdBank._widget_1764393728398 || "",
      },
    },
  };
}

function mapCustoms(r) {
  return {
    _id: r._id,
    contractNo: r._widget_1679903024720 || "",
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
  };
}

function mapPayment(r) {
  return {
    _id: r._id,
    contractNo: r._widget_1770376270481 || "",
    orderNo: r._widget_1766476278615 || "",
    companyNameEN: r._widget_1766476278616 || "",
    companyNameCN: r._widget_1766476278617 || "",
    totalAmountCustomer: r._widget_1766476278618 || 0,
    shipperCompany: r._widget_1766476278620 || "",
    receivedAmount: r._widget_1766476278621 || 0,
    pendingReceiveAmount: r._widget_1766476278622 || 0,
    paidAmount: r._widget_1766476278623 || 0,
    pendingPayAmount: r._widget_1766476278624 || 0,
    thisReceiveAmount: r._widget_1766475873245 || 0,
    thisPayAmount: r._widget_1766475873250 || 0,
    paymentDate: r._widget_1773494537707 ? r._widget_1773494537707.slice(0,10) : null,
    paymentType: r._widget_1771922194701 || "",
    receiveOrPay: r._widget_1771922194703 || "",
    receiveCompany: r._widget_1773487115555 || "",
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
  };
}

function mapInvoice(r) {
  return {
    _id: r._id,
    orderNo: r._widget_1766476278615 || "",
    companyNameEN: r._widget_1766476278616 || "",
    shipperCompany: r._widget_1766476278620 || "",
    invoicedAmount: r._widget_1766476278621 || 0,
    pendingInvoiceAmount: r._widget_1766476278622 || 0,
    thisInvoiceAmount: r._widget_1766475873245 || 0,
    invoiceNo: r._widget_1766745799869 || "",
    invoiceDate: r._widget_1771921880530 ? r._widget_1771921880530.slice(0,10) : null,
    invoiceType: r._widget_1771921880525 || "",
    sellerName: r._widget_1771921880536 || "",
    totalWithTax: r._widget_1771921880543 || 0,
    category: r._widget_1766475873240 || "",
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
  };
}

function mapCreditNote(r) {
  return {
    _id: r._id,
    cnNo: r._widget_1679938239123 || "",
    contractNo: r._widget_1770885459992 || "",
    customerCompanyEN: r._widget_1770885459993 || "",
    returnDate: r._widget_1676572614781 ? r._widget_1676572614781.slice(0,10) : null,
    returnReason: r._widget_1676565713095 || "",
    totalQty: r._widget_1681104220671 || 0,
    totalAmount: r._widget_1770885459984 || 0,
    approvalResult: r._widget_1676572750827 || "",
    products: (r._widget_1676565328823 || []).map(p => ({
      name: p._widget_1676565328824 || "",
      code: p._widget_1679466841907 || "",
      returnQty: p._widget_1770885459981 || 0,
      unitPrice: p._widget_1770885459983 || 0,
      returnAmount: p._widget_1770885459982 || 0,
    })),
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
  };
}

function mapDocs(r) {
  const getFile = (files) => files && files.length > 0
    ? { url: files[0].url, name: files[0].name, size: files[0].size }
    : null;
  const doc = {
    _id: r._id,
    contractNo: r._widget_1769161081476 || "",
    orderNo: r._widget_1766730818801 || "",
    updatedAt: r.updateTime ? r.updateTime.slice(0,10) : null,
  };
  const fields = {
    pi:          "_widget_1771739769157",
    invoice:     "_widget_1771737294158",
    packingList: "_widget_1763604147206",
    bl:          "_widget_1763604147209",
    customs:     "_widget_1767008538949",
    hc:          "_widget_1767008538946",
    vc:          "_widget_1767008538947",
    co:          "_widget_1763604147210",
    slipCargo:   "_widget_1771737294142",
    slipFreight: "_widget_1771737294143",
  };
  for (const [key, widget] of Object.entries(fields)) {
    const f = getFile(r[widget] || []);
    if (f) doc[key] = f;
  }
  return doc;
}

// ── Upsert ───────────────────────────────────────────────────
function upsertRecord(arr, newRecord) {
  const idx = arr.findIndex(x => x._id === newRecord._id);
  if (idx >= 0) {
    const old = arr[idx];
    const merged = { ...old, ...newRecord };
    for (const f of TRACKING_FIELDS) {
      if (!newRecord[f] && old[f]) merged[f] = old[f];
    }
    arr[idx] = merged;
  } else {
    arr.push(newRecord);
  }
  return arr;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const body = req.body;

    // JDY secret auth
    const secret = body.secret || body.Secret || "";
    if (process.env.JDY_SYNC_SECRET && secret !== process.env.JDY_SYNC_SECRET) {
      console.warn("[jdy-sync] Unauthorized secret:", secret);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const op = body.op || "data_create";
    const entryId = body.data?.entryId || body.entryId || "";
    const recordId = body.data?._id || body._id || null;

    const conf = ENTRY_CONFIG[entryId];
    if (!conf) {
      return res.status(200).json({ success: true, skipped: true, reason: "unknown entryId", entryId });
    }

    const client = getOSSClient();
    let arr = await readJSON(client, conf.ossKey);

    if (op === "data_remove") {
      if (!recordId) return res.status(400).json({ success: false, error: "no _id for delete" });
      arr = arr.filter(r => r._id !== recordId);
      await writeJSON(client, conf.ossKey, arr);
      return res.status(200).json({ success: true, op, deleted: recordId, total: arr.length });
    }

    const raw = body.data || body;
    const newRecord = conf.mapper(raw);
    if (!newRecord || !newRecord._id) {
      return res.status(400).json({ success: false, error: "mapper returned no _id" });
    }

    // 如果是订单主表且有附件，上传到 OSS 替换 JDY 临时 URL
    if (entryId === "6419d478b9b91b00091e4d73" && newRecord.attachments) {
      const hasAtt = Object.values(newRecord.attachments).some(Boolean);
      if (hasAtt) {
        console.log("[jdy-sync] uploading attachments for", newRecord.contractNo);
        newRecord.attachments = await uploadAttachmentsToOSS(
          client,
          newRecord.attachments,
          newRecord.contractNo,
          newRecord.companyCode
        );
      }
    }

    arr = upsertRecord(arr, newRecord);
    await writeJSON(client, conf.ossKey, arr);

    console.log(`[jdy-sync] ${op} entryId=${entryId} _id=${newRecord._id} → ${conf.ossKey} (${arr.length} records)`);
    return res.status(200).json({ success: true, op, entryId, _id: newRecord._id, total: arr.length });

  } catch (err) {
    console.error("[jdy-sync] error:", err);
    return res.status(500).json({ success: false, error: err.message || "Sync failed" });
  }
}
