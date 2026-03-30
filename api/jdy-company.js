// api/jdy-company.js — Write company record to JDY 公司表 on registration
// POST { company, taxId, address, contact, phone, email, role, licenseUrl }

const JDY_URL = "https://api.jiandaoyun.com/api/v5/app/entry/data/create";
const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const APP_ID = "689cb08a93c073210bfc772b";
const ENTRY_ID = "692a7c7d85918bdb075ee048"; // 公司表

// Widget ID mapping
const W = {
  companyNameCN:    "_widget_1764392061244",  // 公司名称（中文）
  taxId:            "_widget_1764392061247",  // 社会信用代码
  addressCN:        "_widget_1764392061249",  // 地址（中文）
  contact:          "_widget_1764392061252",  // 联系人
  phone:            "_widget_1764392061253",  // 联系电话
  email:            "_widget_1764529916426",  // 联系邮箱
  portalAccount:    "_widget_1771622004941",  // Portal登录账号
  license:          "_widget_1773378143077",  // 营业执照等 (upload)
  companyAttach:    "_widget_1774872761805",  // 公司附件 (upload)
  portalRole:       "_widget_1771814282260",  // Portal角色(复选) combocheck
  dataSource:       "_widget_1764392061261",  // 数据来源 radiogroup
  contactSubform:   "_widget_1771623447948",  // 负责人联系资料 subform
  // subform fields
  sub_account:      "_widget_1771623447951",  // 登录账号（唯一）
  sub_password:     "_widget_1771623447957",  // 密码
  sub_name:         "_widget_1771623447956",  // 姓名
  sub_phone:        "_widget_1771623447955",  // 手机
  sub_email:        "_widget_1771623447954",  // 邮箱
  sub_role:         "_widget_1772930058574",  // 角色 radiogroup
  sub_enabled:      "_widget_1771623447959",  // 是否启用 radiogroup
};

// Role mapping: form role → JDY Portal角色 combocheck values
const ROLE_MAP = {
  customer:  "客户",
  factory:   "工厂",
  logistics: "物流",
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { company, taxId, address, contact, phone, email, role, password, licenseUrl } = req.body || {};
    if (!company || !email) {
      return res.status(400).json({ error: "company and email are required" });
    }

    // Build JDY data payload
    const data = {
      [W.companyNameCN]: { value: company },
      [W.portalAccount]: { value: email },
      [W.email]:         { value: email },
      [W.dataSource]:    { value: "Portal自助注册" },
    };

    // Optional fields
    if (taxId)   data[W.taxId]     = { value: taxId };
    if (address) data[W.addressCN] = { value: address };
    if (contact) data[W.contact]   = { value: contact };
    if (email)   data[W.email]     = { value: email };

    // Phone — JDY number type needs numeric value
    if (phone) {
      const phoneNum = parseFloat(phone.replace(/[^0-9]/g, ""));
      if (!isNaN(phoneNum)) data[W.phone] = { value: phoneNum };
    }

    // Portal角色 — combocheck expects array
    if (role && ROLE_MAP[role]) {
      data[W.portalRole] = { value: [ROLE_MAP[role]] };
    }

    // License upload — JDY upload field expects array of { url, name }
    if (licenseUrl) {
      const fileObj = [{ url: licenseUrl, name: "营业执照.jpg" }];
      data[W.license]      = { value: fileObj };
      data[W.companyAttach] = { value: fileObj };
    }

    // 负责人联系资料 subform — one row for the registrant
    const subRow = {
      [W.sub_account]: { value: email },
      [W.sub_name]:    { value: contact || "" },
      [W.sub_email]:   { value: email },
      [W.sub_enabled]: { value: "启用" },
    };
    if (phone)    subRow[W.sub_phone]    = { value: phone };
    if (password) subRow[W.sub_password] = { value: password };
    if (role && ROLE_MAP[role]) subRow[W.sub_role] = { value: ROLE_MAP[role] };

    data[W.contactSubform] = { value: [subRow] };

    // Call JDY API
    const jdyRes = await fetch(JDY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${JDY_TOKEN}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        entry_id: ENTRY_ID,
        data: data,
      }),
    });

    const jdyData = await jdyRes.json();

    if (!jdyRes.ok) {
      console.error("JDY company create failed:", JSON.stringify(jdyData));
      return res.status(500).json({
        success: false,
        error: "JDY write failed",
        detail: jdyData,
      });
    }

    return res.status(200).json({
      success: true,
      jdyId: jdyData.data?._id || null,
      message: "Company record created in JDY",
    });

  } catch (err) {
    console.error("jdy-company error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
