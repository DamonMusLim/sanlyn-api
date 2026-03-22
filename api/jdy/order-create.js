/**
 * POST /api/jdy/order-create
 * 
 * Portal下单 → 写入JDY订单主表
 * 
 * Request body:
 * {
 *   companyCode: "PS",
 *   companyNameCN: "PETSOME SDN BHD",
 *   companyNameEN: "PETSOME SDN BHD",
 *   consignee: "PETSOME SDN BHD",
 *   deliveryAddress: "No.1, Jalan xxx, Kuala Lumpur",
 *   destinationPort: "PORT KLANG",
 *   requiredArrivalDate: "2026-08-01",
 *   remarks: "备注",
 *   products: [
 *     {
 *       productName: "Jerky Chicken 100g*12",
 *       code: "WP-JC-100-12",
 *       unitPrice: 12.50,
 *       qty: 200,
 *       unit: "CTN",
 *       subtotal: 2500.00
 *     }
 *   ]
 * }
 */

const JDY_TOKEN    = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP_ID   = "689cb08a93c073210bfc772b";
const JDY_ENTRY_ID = "6419d478b9b91b00091e4d73";  // 订单主表

// 主表字段
const W = {
  companyNameCN:       "_widget_1764468507573",
  companyNameEN:       "_widget_1764468507574",
  companyCode:         "_widget_1764590113940",
  customerAddress:     "_widget_1772452248447",  // textarea
  consignee:           "_widget_1770371550212",
  destinationPort:     "_widget_1764471197748",
  requiredArrivalDate: "_widget_1663812600609",  // datetime (timestamp ms)
  remarks:             "_widget_1762571045801",
  totalAmount:         "_widget_1764467945302",
  totalQty:            "_widget_1764467945301",
  source:              "_widget_1771093417266",  // 标记 "portal"
  portalSubmissionId:  "_widget_1771093417265",
  // 产品子表 Order1
  orderSubform:        "_widget_1764396068557",
  // 子表字段
  sub_productName:     "_widget_1764396068574",
  sub_code:            "_widget_1764396068578",
  sub_unitPrice:       "_widget_1769420815282",  // 客户销售价
  sub_qty:             "_widget_1764396068583",  // Quantity/Ctn
  sub_subtotal:        "_widget_1764467945303",  // 小计（客户）
  sub_unit:            "_widget_1770194186503",  // 客户单位 (combo)
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      companyCode,
      companyNameCN,
      companyNameEN,
      consignee,
      deliveryAddress,
      destinationPort,
      requiredArrivalDate,
      remarks,
      products = [],
    } = req.body;

    if (!companyNameCN && !companyNameEN) {
      return res.status(400).json({ error: "companyName is required" });
    }
    if (!products.length) {
      return res.status(400).json({ error: "products cannot be empty" });
    }

    // 计算汇总
    const totalAmount = products.reduce((s, p) => s + (parseFloat(p.subtotal) || parseFloat(p.unitPrice) * parseFloat(p.qty) || 0), 0);
    const totalQty    = products.reduce((s, p) => s + (parseInt(p.qty) || 0), 0);

    // 生成唯一提交ID（用于追踪，非合同号）
    const submissionId = `PO-${Date.now()}-${(companyCode || "XX").slice(0, 4)}`;

    // 构建JDY数据
    const data = {
      [W.companyNameCN]:       { value: companyNameCN || companyNameEN || "" },
      [W.companyNameEN]:       { value: companyNameEN || companyNameCN || "" },
      [W.companyCode]:         { value: companyCode   || "" },
      [W.consignee]:           { value: consignee     || companyNameEN || "" },
      [W.customerAddress]:     { value: deliveryAddress || "" },
      [W.destinationPort]:     { value: destinationPort || "" },
      [W.remarks]:             { value: remarks || "" },
      [W.totalAmount]:         { value: totalAmount },
      [W.totalQty]:            { value: totalQty },
      [W.source]:              { value: "portal" },
      [W.portalSubmissionId]:  { value: submissionId },
      // Required date of arrival — JDY datetime 需要 timestamp(ms)
      ...(requiredArrivalDate ? {
        [W.requiredArrivalDate]: { value: new Date(requiredArrivalDate).getTime() }
      } : {}),
      // 产品子表
      [W.orderSubform]: products.map(p => {
        const subtotal = parseFloat(p.subtotal) || parseFloat(p.unitPrice) * parseFloat(p.qty) || 0;
        return {
          [W.sub_productName]: { value: p.productName || p.name || "" },
          [W.sub_code]:        { value: p.code || p.sku || "" },
          [W.sub_unitPrice]:   { value: parseFloat(p.unitPrice) || 0 },
          [W.sub_qty]:         { value: parseInt(p.qty) || 0 },
          [W.sub_subtotal]:    { value: subtotal },
          [W.sub_unit]:        { value: p.unit || "CTN" },
        };
      }),
    };

    console.log(`[order-create] submissionId=${submissionId} company=${companyCode} products=${products.length} total=${totalAmount}`);

    const jdyRes = await fetch(
      `https://api.jiandaoyun.com/api/v5/app/${JDY_APP_ID}/entry/${JDY_ENTRY_ID}/data`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${JDY_TOKEN}`,
        },
        body: JSON.stringify({ data }),
      }
    );

    const jdyJson = await jdyRes.json();

    if (!jdyRes.ok || jdyJson.code) {
      console.error("[order-create] JDY error:", jdyJson);
      return res.status(500).json({
        error:   "JDY write failed",
        jdyCode: jdyJson.code,
        jdyMsg:  jdyJson.msg,
      });
    }

    const entryId = jdyJson.data?._id;
    console.log(`[order-create] Success entryId=${entryId}`);

    return res.status(200).json({
      success:      true,
      entryId,
      submissionId,
      totalAmount,
      totalQty,
      message:      "Order submitted. Contract number will be assigned by our sales team within 1 business day.",
    });

  } catch (err) {
    console.error("[order-create] Exception:", err);
    return res.status(500).json({ error: err.message });
  }
}
