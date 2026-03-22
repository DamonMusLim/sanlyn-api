/**
 * GET /api/jdy/customer-addresses?companyCode=PS
 * 
 * 从JDY客户档案查该客户的地址明细子表
 * 返回格式：
 * {
 *   success: true,
 *   addresses: [
 *     {
 *       country: "Malaysia",
 *       port: "PORT KLANG",
 *       addressShort: "No.1 Jalan xxx",
 *       addressFull: "No.1 Jalan xxx, 41000 Klang, Selangor, Malaysia",
 *       consignee: "PETSOME SDN BHD",
 *       label: "PETSOME SDN BHD — PORT KLANG, Malaysia"
 *     }
 *   ]
 * }
 */

const JDY_TOKEN          = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP_ID         = "689cb08a93c073210bfc772b";
const JDY_CUSTOMER_ENTRY = "68da2738987870a88c839d6e";  // 客户档案

// 客户档案字段
const W_CUST = {
  companyCode:    "_widget_1771622930859",  // 客户代号（用于查询过滤）
  addressSubform: "_widget_1770371120291",  // 地址明细子表
  // 子表字段
  sub_country:    "_widget_1770371120295",  // 国家英文名
  sub_port:       "_widget_1771523439038",  // 目的港
  sub_addrShort:  "_widget_1771815411179",  // 地址（短，text）
  sub_addrFull:   "_widget_1770371120312",  // 地址（详细，textarea）
  sub_consignee:  "_widget_1770371120343",  // 收货人公司名
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { companyCode } = req.query;
  if (!companyCode) return res.status(400).json({ error: "companyCode is required" });

  try {
    // JDY list API，按客户代号过滤
    const jdyRes = await fetch(
      `https://api.jiandaoyun.com/api/v5/app/${JDY_APP_ID}/entry/${JDY_CUSTOMER_ENTRY}/data/list`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${JDY_TOKEN}`,
        },
        body: JSON.stringify({
          limit: 5,
          filter: {
            rel: "and",
            cond: [
              {
                field: W_CUST.companyCode,
                type:  "text",
                method: "eq",
                value: [companyCode],
              }
            ]
          },
          fields: [W_CUST.companyCode, W_CUST.addressSubform],
        }),
      }
    );

    const jdyJson = await jdyRes.json();

    if (!jdyRes.ok || jdyJson.code) {
      return res.status(500).json({
        error:   "JDY query failed",
        jdyCode: jdyJson.code,
        jdyMsg:  jdyJson.msg,
      });
    }

    const records = jdyJson.data || [];
    if (!records.length) {
      return res.status(200).json({ success: true, addresses: [] });
    }

    // 取第一条匹配记录的地址子表
    const record       = records[0];
    const subformData  = record[W_CUST.addressSubform]?.value || [];

    const addresses = subformData
      .map(row => {
        const country    = row[W_CUST.sub_country]?.value   || "";
        const port       = row[W_CUST.sub_port]?.value      || "";
        const addrShort  = row[W_CUST.sub_addrShort]?.value || "";
        const addrFull   = row[W_CUST.sub_addrFull]?.value  || "";
        const consignee  = row[W_CUST.sub_consignee]?.value || "";

        // 拼接显示用地址
        const fullAddress = addrFull || addrShort || "";
        const label = [consignee, port, country].filter(Boolean).join(" — ");

        return { country, port, addrShort, addrFull, consignee, fullAddress, label };
      })
      .filter(a => a.label); // 过滤掉空行

    return res.status(200).json({ success: true, addresses });

  } catch (err) {
    console.error("[customer-addresses] Exception:", err);
    return res.status(500).json({ error: err.message });
  }
}
