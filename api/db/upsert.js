import { getPool, setCors } from "../db.js";
const TABLES = ["orders","finance_payments","shipping_plans","accounts","customs_data"];

// ─── JDY 订单主表 widget ID → 业务字段（从表单数据结构确认） ───
const ORDER_WIDGETS = {
  "_widget_1679903024720": "contractNo",
  "_widget_1756914144559": "customerPO",          // 合同号 (sn)
  "_widget_1764468507574": "companyNameEN",        // 公司名称（英文）
  "_widget_1764468507573": "companyNameCN",        // 公司名称（中文）
  "_widget_1764590113940": "companyCode",          // Company_Code
  "_widget_1764578480945": "groupCode",            // 客户集团代码
  "_widget_1770371550212": "consignee",            // Consignee
  "_widget_1764471197748": "destination",          // 目的港
  "_widget_1764591186973": "pol",                  // 起运港
  "_widget_1663812600609": "requireArrivalDate",   // Required date of arrival
  "_widget_1765186212190": "deliveryDate",         // 预计交货日期
  "_widget_1766462809214": "actDelivery",          // 工厂交货确认
  "_widget_1773467773240": "productionStatus",     // status生产状态
  "_widget_1772321728293": "customerConfirmStatus",// 客户确认状态
  "_widget_1764467945302": "totalAmount",          // 总金额（客户）
  "_widget_1765186561849": "totalAmountFactory",   // 总金额（工厂）
  "_widget_1764467945301": "totalQty",             // 总数量
  "_widget_1766897323225": "grossWeight",          // 总毛重
  "_widget_1766897323226": "netWeight",            // 总净重
  "_widget_1772451090157": "totalCBM",             // 总CBM
  "_widget_1766564550881": "containerType",        // 建议柜型
  "_widget_1768218310025": "containerQty",         // 柜子数量
  "_widget_1770797914842": "currency",             // 交易币种
  "_widget_1766977056108": "currencyAlt",          // 币种
  "_widget_1762571045801": "remarks",              // 备注
  "_widget_1766653844751": "category",             // 二级类目
  "_widget_1768475646834": "country",              // Country
  "_widget_1770371550210": "countryOther",         // country（Other）
  "_widget_1771947148663": "portOther",            // Port（Other）
  "_widget_1771815489798": "address",              // 地址
  "_widget_1772452248447": "customerAddress",      // 客户地址
  "_widget_1769423792123": "phone",                // 联系电话
  "_widget_1769423792125": "email",                // 联系邮箱
  "_widget_1764396068557": "products",             // Order1 子表
  "_widget_1768218309979": "products2",            // Order2 子表
  "_widget_1768218310002": "products3",            // Order3 子表
  "_widget_1766747364528": "paymentPlan",          // 付款计划子表
  "_widget_1765194153605": "issuingCompany",       // 出单公司
  "_widget_1769078795960": "issuingCompanyEN",     // 出单公司(英文)
  "_widget_1765186212182": "factory",              // 工厂
  "_widget_1767068173069": "truckingCompany",      // 拖车公司
  "_widget_1770194186548": "customsBroker",        // 报关行
  "_widget_1770882800051": "profit",               // 利润
  "_widget_1770887264333": "exchangeRate",         // 汇率
  "_widget_1771629244589": "delayReason",          // 延期原因
  // 附件
  "_widget_1769418068618": "piUrl",                // PI文件
  "_widget_1771709164165": "contractUrl",          // 合同SC
  "_widget_1769078158887": "invoiceUrl",           // 发票IV
  "_widget_1771709164164": "packingListUrl",       // 箱单PL
  "_widget_1769417235037": "purchaseContractUrl",  // 采购合同
  "_widget_1771628524623": "factoryContractUrl",   // 工厂上传合同
  "_widget_1771093417264": "tenantId",             // tenant_id
  "_widget_1771093417265": "portalSubmissionId",   // portal_submission_id
  "_widget_1771093417266": "source",               // source
};

// ─── S65: 海运计划表 widget ID → 业务字段 ───
const SHIPPING_WIDGETS = {
  "_widget_1762828544749": "shipmentNo",           // 出运编号
  "_widget_1773399157196": "blNo",                 // BL单号
  "_widget_1768820368507": "contractNo",           // 合同号
  "_widget_1765450157283": "shippingLine",         // 船公司
  "_widget_1771626741568": "vessel",               // 船名
  "_widget_1771626741569": "voyageNo",             // 航次
  "_widget_1765450157284": "voyageNoAlt",          // 航次（备用）
  "_widget_1764591553171": "pol",                  // 起运港（默认）
  "_widget_1764591553172": "pod",                  // 目的港（默认）
  "_widget_1764582236204": "shipmentDate",         // 出运日期
  "_widget_1769075239993": "eta",                  // 预计到港时间
  "_widget_1771626741566": "etd",                  // ETD（开船日）
  "_widget_1771626741567": "etaSO",                // ETA（预计到港日）
  "_widget_1771626741547": "cutoffDate",           // 截港日
  "_widget_1765450157285": "containerQty",         // 柜数量
  "_widget_1766895482504": "containerType",        // 建议柜型
  "_widget_1771626741552": "containerNo",          // 柜号
  "_widget_1771626741551": "sealNo",               // 封签
  "_widget_1764582236205": "status",               // 状态
  "_widget_1766568840023": "customerCompany",      // 客户公司名称
  "_widget_1766913567261": "customerCompanyEN",    // 公司名称（英文）（客户公司）
  "_widget_1764591553170": "forwarderCN",          // 公司名称（中文）（货代公司）
  "_widget_1765191742170": "forwarderEN",          // 公司名称（英文）（货代公司）
  "_widget_1773486880174": "issuingCompany",       // 出单公司
  // ★ S65: 供应商字段 ★
  "_widget_1765450157291": "oceanForwarder",       // 选择海运（lookup → 货代）
  "_widget_1768645113405": "truckingCN",           // 拖车公司（中文）
  "_widget_1768645113406": "customsBroker",        // 报关行
  "_widget_1772454275251": "customsBrokerSelect",  // 选择报关行（combo）
  // 费用
  "_widget_1768299925392": "freightCost",          // 海运费（成本）
  "_widget_1766566622260": "freightSaleUSD",       // 海运费（销售）
  "_widget_1766460409789": "portSurchargeTotal",   // 港杂总金额
  "_widget_1772454275249": "truckingCostTotal",    // 拖车总费用（成本）
  "_widget_1772454275250": "truckingCostSale",     // 拖车总费用（销售）
  "_widget_1768641952534": "customsCostTotal",     // 报关费用（成本）
  "_widget_1768641952535": "customsCostSale",      // 报关费用（销售）
  "_widget_1772454275255": "customsSaleAlt",       // 报关费销售
  // 收付
  "_widget_1766569134331": "freightPaidAmount",    // 海运已付金额
  "_widget_1766569134332": "freightPendingPay",    // 海运未付金额
  "_widget_1766569134329": "freightReceivedAmount",// 海运已收金额
  "_widget_1766569134330": "freightPendingReceive",// 海运未收金额
  "_widget_1766567302495": "portSurchargePaid",    // 港杂已付金额
  "_widget_1766567302496": "portSurchargePending", // 港杂剩余未付金额
  "_widget_1766566948893": "portSurchargeReceived", // 港杂已收金额
  "_widget_1766567079062": "portSurchargePendingReceive", // 港杂剩余未收金额
  "_widget_1768643215093": "truckingCostPaid",     // 拖车总费用（成本）已付
  "_widget_1768643215094": "truckingCostPending",  // 拖车总费用（成本）未付
  "_widget_1768643215097": "customsCostPaid",      // 报关费用（成本）已付
  "_widget_1768643215098": "customsCostPending",   // 报关费用（成本）未付
  // 订单子表
  "_widget_1762828544751": "orderSubform",         // 订单号子表
  "_widget_1765451948626": "orderNos",             // 辅助订单号集合
  "_widget_1767084770362": "orderNosAlt",          // 订单号集合
  // 其他
  "_widget_1764582236207": "remarks",              // 备注
  "_widget_1770884051962": "profit",               // 利润
  "_widget_1773730136761": "insuranceSale",        // 保险销售价
  "_widget_1766814081887": "businessType",         // 业务类型
  "_widget_1766814081889": "transportMode",        // 运输方式
};

// ─── S61: 报关资料表 widget ID → 业务字段 ───
const CUSTOMS_WIDGETS = {
  "_widget_1763603690386": "customsNo",
  "_widget_1767082183888": "shipmentNo",
  "_widget_1773088074376": "customsDecOfficial",
  "_widget_1773088074377": "releaseNote",
  "_widget_1766823510929": "bookingNote",
  "_widget_1769072140465": "blDraft",
  "_widget_1768815958469": "blFinal",
  "_widget_1768818743679": "customsDec",
  "_widget_1769162177987": "originCert",
  "_widget_1766474587096": "quarantineReport",
  "_widget_1769763783948": "sealPhotos",
  "_widget_1766824437654": "factorySign",
  "_widget_1766473197615": "loadingSubform",
};

const LOADING_SUBFORM_WIDGETS = {
  "_widget_1767069458550": "contractNo",
  "_widget_1766473743213": "orderNo",
  "_widget_1766473743210": "containerType",
  "_widget_1766473743211": "loadingDate",
  "_widget_1766824437653": "totalWeightKG",
  "_widget_1773088074435": "factoryContact",
  "_widget_1773088074436": "factoryPhone",
  "_widget_1773088074404": "driverName",
  "_widget_1773088074405": "driverPlate",
  "_widget_1773088074406": "containerNo",
  "_widget_1774349445978": "weightTicket",
  "_widget_1773088074407": "sealNo",
  "_widget_1773088074434": "photos9grid",
};

function _jdyVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !Array.isArray(v) && v.value !== undefined) return v.value ?? "";
  return v;
}

function _normalizeJDYOrder(r) {
  const out = { _id: r._id };
  for (const [wid, field] of Object.entries(ORDER_WIDGETS)) {
    if (r[wid] !== undefined) out[field] = _jdyVal(r[wid]);
  }
  for (const key of Object.keys(r)) {
    if (!key.startsWith("_widget_") && !(key in out)) out[key] = r[key];
  }
  return out;
}

// ─── S65: Normalize JDY shipping plan ───
function _normalizeJDYShipping(r) {
  const out = { _id: r._id };
  for (const [wid, field] of Object.entries(SHIPPING_WIDGETS)) {
    if (r[wid] !== undefined) out[field] = _jdyVal(r[wid]);
  }
  // 保留非 widget 字段
  for (const key of Object.keys(r)) {
    if (!key.startsWith("_widget_") && !(key in out)) out[key] = r[key];
  }
  // Derived fields
  out.voyageNo = out.voyageNo || out.voyageNoAlt || "";
  out.eta = out.etaSO || out.eta || null;
  out.customer = out.customerCompanyEN || out.customerCompany || "";
  // customsBroker fallback: combo selection → text field
  out.customsCN = out.customsBroker || out.customsBrokerSelect || "";
  out.truckingCN = out.truckingCN || "";
  out.forwarderCN = out.forwarderCN || "";
  // flowStatus from status
  out.flowStatus = out.status || "";
  return out;
}

function _normalizeCustomsRecord(r) {
  const out = { _id: r._id };
  for (const [wid, field] of Object.entries(CUSTOMS_WIDGETS)) {
    if (r[wid] !== undefined) {
      if (field === "loadingSubform") {
        const arr = Array.isArray(r[wid]) ? r[wid] : [];
        out.loadingDetails = arr.map(item => {
          const row = {};
          for (const [swid, sfield] of Object.entries(LOADING_SUBFORM_WIDGETS)) {
            if (item[swid] !== undefined) row[sfield] = _jdyVal(item[swid]);
          }
          for (const k of Object.keys(item)) {
            if (!k.startsWith("_widget_") && !(k in row)) row[k] = item[k];
          }
          return row;
        });
      } else {
        out[field] = _jdyVal(r[wid]);
      }
    }
  }
  for (const key of Object.keys(r)) {
    if (!key.startsWith("_widget_") && !(key in out)) out[key] = r[key];
  }
  return out;
}

function _dt(v) {
  if (!v) return null;
  if (typeof v === "number" && v > 1e12) return new Date(v).toISOString().slice(0, 10);
  if (typeof v === "string") return v.slice(0, 10) || null;
  return null;
}

function _fileVal(v) {
  if (!v) return null;
  if (typeof v === "string") return JSON.stringify([{ url: v }]);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v.url) return JSON.stringify([v]);
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { table, record: rawRecord } = req.body;
    if (!TABLES.includes(table)) return res.status(400).json({ success: false, error: "Invalid table" });
    let sql, vals;
    if (table === "accounts") {
      sql = `INSERT INTO accounts (username,password,role,company,supplier_role,permissions,department,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (username) DO UPDATE SET password=$2,role=$3,company=$4,supplier_role=$5,permissions=$6,department=$7,raw=$8,updated_at=NOW() RETURNING *`;
      vals = [rawRecord.username,rawRecord.password,rawRecord.role,rawRecord.company,rawRecord.supplierRole||rawRecord.supplier_role,rawRecord.permissions,rawRecord.department,JSON.stringify(rawRecord)];
    } else if (table === "orders") {
      const hasWidgets = Object.keys(rawRecord).some(k => k.startsWith("_widget_"));
      const record = hasWidgets ? _normalizeJDYOrder(rawRecord) : rawRecord;

      const prodSource = record.products || [];
      const rawProducts = (Array.isArray(prodSource) ? prodSource : []).map(p => {
        const pv = (k) => _jdyVal(p[k]);
        return {
          name:     p.name    || pv("_widget_1764396068574") || "",
          qty:      p.qty     || pv("_widget_1764396068583") || 0,
          barcode:  p.barcode || pv("_widget_1764396068578") || "",
          category: p.category || pv("_widget_1766565146298") || "",
          cbm:      p.cbm     || pv("_widget_1764396068580") || "",
          factory:  p.factory || pv("_widget_1764571997306") || "",
          size:     p.size    || pv("_widget_1764396068575") || "",
          unitPrice:    p.unitPrice    || pv("_widget_1769420815282") || 0,
          factoryPrice: p.factoryPrice || pv("_widget_1765186212200") || 0,
          subtotal:     p.subtotal     || pv("_widget_1764467945303") || 0,
          grossWeight:  p.grossWeight  || pv("_widget_1764396068581") || 0,
          netWeight:    p.netWeight    || pv("_widget_1765194153609") || 0,
        };
      });

      const topCategory = record.category || "";
      const enrichedRecord = { ...record, products: rawProducts, category: topCategory };

      sql = `INSERT INTO orders (_id,contract_no,customer_po,customer,destination,etd,eta,status,production_status,total_amount,currency,plan_id,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (_id) DO UPDATE SET contract_no=$2,customer_po=$3,customer=$4,destination=$5,etd=$6,eta=$7,status=$8,production_status=$9,total_amount=$10,currency=$11,plan_id=$12,raw=$13,updated_at=NOW() RETURNING *`;
      vals = [
        record._id,
        record.contractNo || record.contract_no || null,
        record.customerPO || record.customer_po || null,
        record.customer || record.companyNameEN || record.companyNameCN || null,
        record.destination || null,
        _dt(record.etd) || null,
        _dt(record.eta) || null,
        record.status || null,
        record.productionStatus || record.production_status || null,
        record.totalAmount || record.total_amount || null,
        record.currency || record.currencyAlt || "USD",
        record.planId || record.plan_id || null,
        JSON.stringify(enrichedRecord),
      ];
    } else if (table === "finance_payments") {
      sql = `INSERT INTO finance_payments (_id,plan_id,customer,amount,currency,paid_date,status,tt_slip_url,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT (_id) DO UPDATE SET plan_id=$2,customer=$3,amount=$4,currency=$5,paid_date=$6,status=$7,tt_slip_url=$8,raw=$9,updated_at=NOW() RETURNING *`;
      vals = [rawRecord._id,rawRecord.planId||rawRecord.plan_id,rawRecord.customer,rawRecord.amount||null,rawRecord.currency||"USD",rawRecord.paidDate||rawRecord.paid_date||null,rawRecord.status,rawRecord.ttSlipUrl||rawRecord.tt_slip_url,JSON.stringify(rawRecord)];
    } else if (table === "customs_data") {
      const hasWidgets = Object.keys(rawRecord).some(k => k.startsWith("_widget_"));
      const record = hasWidgets ? _normalizeCustomsRecord(rawRecord) : rawRecord;
      const contractNo = record.contractNo || (record.loadingDetails?.[0]?.contractNo) || null;
      sql = `INSERT INTO customs_data (_id,customs_no,shipment_no,contract_no,customs_dec_official,release_note,booking_note,bl_draft,bl_final,customs_dec,origin_cert,quarantine_report,seal_photos,factory_sign,loading_details,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW()) ON CONFLICT (_id) DO UPDATE SET customs_no=$2,shipment_no=$3,contract_no=$4,customs_dec_official=$5,release_note=$6,booking_note=$7,bl_draft=$8,bl_final=$9,customs_dec=$10,origin_cert=$11,quarantine_report=$12,seal_photos=$13,factory_sign=$14,loading_details=$15,raw=$16,updated_at=NOW() RETURNING *`;
      vals = [
        record._id,
        record.customsNo || record.customs_no || null,
        record.shipmentNo || record.shipment_no || null,
        contractNo,
        _fileVal(record.customsDecOfficial),
        _fileVal(record.releaseNote),
        _fileVal(record.bookingNote),
        _fileVal(record.blDraft),
        _fileVal(record.blFinal),
        _fileVal(record.customsDec),
        _fileVal(record.originCert),
        _fileVal(record.quarantineReport),
        _fileVal(record.sealPhotos),
        _fileVal(record.factorySign),
        JSON.stringify(record.loadingDetails || []),
        JSON.stringify(record),
      ];
    } else {
      // ★ S65: shipping_plans — auto-normalize JDY widget IDs ★
      const hasWidgets = Object.keys(rawRecord).some(k => k.startsWith("_widget_"));
      const record = hasWidgets ? _normalizeJDYShipping(rawRecord) : rawRecord;

      sql = `INSERT INTO shipping_plans (_id,bl_no,vessel,voyage,etd,eta,cutoff_date,container_no,customs_cn,trucking_cn,customer,created_by,shipment_no,contract_no,container_type,forwarder_cn,freight_cost,freight_sale_usd,port_surcharge_total,trucking_cost_total,customs_cost_total,flow_status,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()) ON CONFLICT (_id) DO UPDATE SET bl_no=$2,vessel=$3,voyage=$4,etd=$5,eta=$6,cutoff_date=$7,container_no=$8,customs_cn=$9,trucking_cn=$10,customer=$11,created_by=$12,shipment_no=$13,contract_no=$14,container_type=$15,forwarder_cn=$16,freight_cost=$17,freight_sale_usd=$18,port_surcharge_total=$19,trucking_cost_total=$20,customs_cost_total=$21,flow_status=$22,raw=$23,updated_at=NOW() RETURNING *`;
      vals = [
        record._id,
        record.blNo || record.bl_no || null,
        record.vessel || null,
        record.voyageNo || record.voyage || null,
        _dt(record.etd) || null,
        _dt(record.eta) || null,
        _dt(record.cutoffDate || record.cutoff_date) || null,
        record.containerNo || record.container_no || null,
        record.customsCN || record.customs_cn || null,
        record.truckingCN || record.trucking_cn || null,
        record.customer || record.customerCompanyEN || record.customerCompany || null,
        record.createdBy || record.created_by || null,
        record.shipmentNo || record.shipment_no || null,
        record.contractNo || record.contract_no || null,
        record.containerType || record.container_type || null,
        record.forwarderCN || record.forwarder_cn || null,
        Number(record.freightCost || record.freight_cost) || null,
        Number(record.freightSaleUSD || record.freight_sale_usd) || null,
        Number(record.portSurchargeTotal || record.port_surcharge_total) || null,
        Number(record.truckingCostTotal || record.trucking_cost_total) || null,
        Number(record.customsCostTotal || record.customs_cost_total) || null,
        record.flowStatus || record.flow_status || null,
        JSON.stringify(record),
      ];
    }
    const result = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
