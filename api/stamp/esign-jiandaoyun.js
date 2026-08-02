// api/stamp/esign-jiandaoyun.js
// DAS「正规电子签章」通道 = 简道云 E签宝(e签宝) 自动落章。法律效力/证据链,用于对外正规单据。
// 机制(见记忆 reference_jiandaoyun_esign_api):不是直连签PDF的REST,是驱动简道云表单+流程插件:
//   传PDF拿fileKey → 建表单记录(把PDF放"待签署文件"字段, is_start_workflow:true)触发流程 →
//   流程e签宝节点自动落章(企业章·单方) → 轮询记录"签署完成"附件字段拿签好PDF。
// ⚠️gated:未配置简道云凭证(下面的env)时 esignConfigured()=false,DAS走模拟章不受影响。
// ⚠️前置(法人办,代码办不了):洋宝宝e签宝企业实名认证 + 印章授权(自动落章) + 建简道云App/表单/流程(挂e签宝节点·自动落章=是)。
// 配好后在 .env 填:JDY_API_KEY / JDY_ESIGN_APP_ID / JDY_ESIGN_ENTRY_ID / JDY_ESIGN_FILE_FIELD / JDY_ESIGN_RESULT_FIELD
//   (字段=简道云表单里"待签署文件"和"签署完成合同"两个控件的 widget id,如 _widget_1432728651408)
const JDY_BASE = process.env.JDY_BASE || "https://api.jiandaoyun.com";

export function esignConfig() {
  const c = {
    apiKey:      process.env.JDY_API_KEY || "",
    appId:       process.env.JDY_ESIGN_APP_ID || "",
    entryId:     process.env.JDY_ESIGN_ENTRY_ID || "",
    fileField:   process.env.JDY_ESIGN_FILE_FIELD || "",     // 待签署文件 控件id
    resultField: process.env.JDY_ESIGN_RESULT_FIELD || "",   // 签署完成合同 控件id
  };
  c.configured = Boolean(c.apiKey && c.appId && c.entryId && c.fileField && c.resultField);
  return c;
}
export function esignConfigured() { return esignConfig().configured; }

function hdr(apiKey) { return { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 取上传凭证 → 2) 上传PDF → 返回 fileKey(建记录附件字段用)
async function uploadPdf(cfg, pdfBuffer, fileName, transactionId) {
  const tokRes = await fetch(`${JDY_BASE}/api/v5/app/entry/file/get_upload_token`, {
    method: "POST", headers: hdr(cfg.apiKey),
    body: JSON.stringify({ app_id: cfg.appId, entry_id: cfg.entryId, transaction_id: transactionId }),
  });
  const tokJson = await tokRes.json();
  if (!tokRes.ok) throw new Error("get_upload_token失败:" + JSON.stringify(tokJson).slice(0, 200));
  const slot = (tokJson.token_and_url_list || tokJson.data || [])[0];
  if (!slot || !slot.url || !slot.token) throw new Error("上传凭证结构异常:" + JSON.stringify(tokJson).slice(0, 200));
  const fd = new FormData();
  fd.append("token", slot.token);
  fd.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), fileName || "bill.pdf");
  const upRes = await fetch(slot.url, { method: "POST", body: fd });
  const upJson = await upRes.json().catch(() => ({}));
  if (!upRes.ok) throw new Error("上传文件失败:" + JSON.stringify(upJson).slice(0, 200));
  const key = upJson.key || upJson.data?.key || slot.key;
  if (!key) throw new Error("上传后无fileKey:" + JSON.stringify(upJson).slice(0, 200));
  return key;
}

// 建记录+触发流程签署
async function createSignRecord(cfg, fileKey, transactionId, extraData) {
  const data = { [cfg.fileField]: { value: [fileKey] }, ...(extraData || {}) };
  const res = await fetch(`${JDY_BASE}/api/v5/app/entry/data/create`, {
    method: "POST", headers: hdr(cfg.apiKey),
    body: JSON.stringify({
      app_id: cfg.appId, entry_id: cfg.entryId, data,
      is_start_workflow: true,       // ← 命门:触发绑定流程(e签宝节点自动落章)
      transaction_id: transactionId,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error("建记录失败:" + JSON.stringify(json).slice(0, 200));
  const dataId = json.data?._id || json.data?.data_id || json._id;
  if (!dataId) throw new Error("建记录无data_id:" + JSON.stringify(json).slice(0, 200));
  return dataId;
}

// 轮询记录直到"签署完成"字段回填(流程异步落章)
async function pollSigned(cfg, dataId, { tries = 20, intervalMs = 6000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${JDY_BASE}/api/v5/app/entry/data/get`, {
      method: "POST", headers: hdr(cfg.apiKey),
      body: JSON.stringify({ app_id: cfg.appId, entry_id: cfg.entryId, data_id: dataId }),
    });
    const json = await res.json().catch(() => ({}));
    const field = json.data?.[cfg.resultField];
    const val = field && (field.value ?? field);
    const url = Array.isArray(val) ? (val[0]?.url || val[0]) : (val?.url || (typeof val === "string" ? val : null));
    if (url) return url;
    await sleep(intervalMs);
  }
  return null; // 超时未回填(可能落章慢或流程配置问题);调用方按未完成处理
}

// 对外主函数:给PDF buffer,走E签宝自动落章,返回签好PDF的URL(简道云侧)。
// 返回 {configured, ok, signedUrl?, dataId?, error?}
export async function signPdfViaEsign({ pdfBuffer, fileName, docName, companyCode, transactionId } = {}) {
  const cfg = esignConfig();
  if (!cfg.configured) return { configured: false, ok: false, error: "E签宝未配置(缺JDY_*环境变量);需法人先办实名+印章授权+建简道云表单流程" };
  if (!pdfBuffer || !pdfBuffer.length) return { configured: true, ok: false, error: "缺pdfBuffer" };
  const tid = transactionId || `esign_${cfg.entryId}_${pdfBuffer.length}_${fileName || "d"}`;
  try {
    const fileKey = await uploadPdf(cfg, pdfBuffer, fileName || (docName ? docName + ".pdf" : "bill.pdf"), tid);
    const dataId = await createSignRecord(cfg, fileKey, tid, docName ? {} : {});
    const signedUrl = await pollSigned(cfg, dataId);
    if (!signedUrl) return { configured: true, ok: false, dataId, error: "签署未在超时内完成(检查流程/自动落章配置);记录已建dataId=" + dataId };
    return { configured: true, ok: true, signedUrl, dataId };
  } catch (e) {
    return { configured: true, ok: false, error: e && e.message };
  }
}
