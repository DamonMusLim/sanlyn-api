import { getPool, setCors } from "../db.js";
const TABLES = ["orders","finance_payments","shipping_plans","accounts"];

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
  // 保留非 widget 字段
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
      // JDY 原始数据自动 normalize
      const hasWidgets = Object.keys(rawRecord).some(k => k.startsWith("_widget_"));
      const record = hasWidgets ? _normalizeJDYOrder(rawRecord) : rawRecord;

      // products 子表 — ⚠️ _widget_1764396068580 = CBM，不是 category
      const prodSource = record.products || [];
      const rawProducts = (Array.isArray(prodSource) ? prodSource : []).map(p => {
        const pv = (k) => _jdyVal(p[k]);
        return {
          name:     p.name    || pv("_widget_1764396068574") || "",
          qty:      p.qty     || pv("_widget_1764396068583") || 0,
          barcode:  p.barcode || pv("_widget_1764396068578") || "",
          category: p.category || pv("_widget_1766565146298") || "",  // 二级分类
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
    } else {
      sql = `INSERT INTO shipping_plans (_id,bl_no,vessel,voyage,etd,eta,cutoff_date,container_no,customs_cn,trucking_cn,customer,created_by,raw,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (_id) DO UPDATE SET bl_no=$2,vessel=$3,voyage=$4,etd=$5,eta=$6,cutoff_date=$7,container_no=$8,customs_cn=$9,trucking_cn=$10,customer=$11,created_by=$12,raw=$13,updated_at=NOW() RETURNING *`;
      vals = [rawRecord._id,rawRecord.blNo||rawRecord.bl_no,rawRecord.vessel,rawRecord.voyage,rawRecord.etd||null,rawRecord.eta||null,rawRecord.cutoffDate||rawRecord.cutoff_date||null,rawRecord.containerNo||rawRecord.container_no,rawRecord.customsCN||rawRecord.customs_cn,rawRecord.truckingCN||rawRecord.trucking_cn,rawRecord.customer,rawRecord.createdBy||rawRecord.created_by,JSON.stringify(rawRecord)];
    }
    const result = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
