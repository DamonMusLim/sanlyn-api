// /api/jdy-driver-update.js
// 司机提交登记后写回 JDY 报关资料表 → 装通知子表单（追加一行）

const JDY_TOKEN = 'qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU';
const JDY_BASE  = 'https://api.jiandaoyun.com/api/v5/app/entry';
const APP_ID    = '689cb08a93c073210bfc772b';
const ENTRY_ID  = '691e74ea175dfbf0607cc820';

const F_CONTRACT_NO  = '_widget_1767082183891';
const SUBFORM        = '_widget_1766473197615';
const F_DRIVER_NAME  = '_widget_1773088074404';
const F_DRIVER_PLATE = '_widget_1773088074405';
const F_CONTAINER_NO = '_widget_1773088074406';
const F_SEAL_NO      = '_widget_1773088074407';
const F_PHOTOS       = '_widget_1773088074434';
const F_STAFF        = '_widget_1773088074435';
const F_STAFF_PHONE  = '_widget_1773088074436';
const F_WEIGHT       = '_widget_1766824437653';
const F_LOADING_TIME = '_widget_1766473743211';
const F_REMARK       = '_widget_1766824437650';

const HEADERS = {
  'Authorization': `Bearer ${JDY_TOKEN}`,
  'Content-Type':  'application/json',
};

async function findRecordByContractNo(contractNo) {
  const res = await fetch(`${JDY_BASE}/data/list`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      app_id: APP_ID, entry_id: ENTRY_ID, limit: 1,
      filter: { rel: 'and', cond: [{ field: F_CONTRACT_NO, type: 'text', method: 'eq', value: [contractNo] }] },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`JDY list error: ${JSON.stringify(data)}`);
  const list = data.data_list || data.data || [];
  if (!list.length) throw new Error(`合同号 ${contractNo} 未找到对应报关资料记录`);
  return list[0]._id;
}

async function appendLoadingRow(dataId, p) {
  const newRow = {
    [F_DRIVER_NAME]:  { value: p.driverName  || '' },
    [F_DRIVER_PLATE]: { value: p.driverPlate || '' },
    [F_WEIGHT]:       { value: p.weight ? Number(p.weight) : null },
    [F_LOADING_TIME]: { value: p.loadingTime || p.submittedAt || null },
    [F_STAFF]:        { value: p.factoryStaff || '' },
    [F_STAFF_PHONE]:  { value: p.staffPhone   || '' },
    [F_CONTAINER_NO]: { value: p.containerNo  || '' },
    [F_SEAL_NO]:      { value: p.sealNo       || '' },
    [F_REMARK]:       { value: p.remark       || '' },
    [F_PHOTOS]: { value: Array.isArray(p.photos) ? p.photos.map(url => ({ name: url.split('/').pop(), url })) : [] },
  };
  const res = await fetch(`${JDY_BASE}/data/update`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      app_id: APP_ID, entry_id: ENTRY_ID, data_id: dataId,
      data: { [SUBFORM]: { value: [newRow] } },
      transaction_data: { subform_update_type: 'append' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`JDY update error: ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { contractNo, driverName, driverPlate, weight, loadingTime,
            factoryStaff, staffPhone, containerNo, sealNo, submittedAt, photos, remark } = req.body;
    if (!contractNo)  return res.status(400).json({ error: '缺少 contractNo' });
    if (!driverName)  return res.status(400).json({ error: '缺少 driverName' });
    if (!driverPlate) return res.status(400).json({ error: '缺少 driverPlate' });
    const dataId = await findRecordByContractNo(contractNo);
    const result = await appendLoadingRow(dataId, { driverName, driverPlate, weight, loadingTime,
      factoryStaff, staffPhone, containerNo, sealNo, submittedAt, photos, remark });
    return res.status(200).json({ success: true, dataId, message: `司机信息已写入 JDY（合同号: ${contractNo}）`, jdyResult: result });
  } catch (err) {
    console.error('[jdy-driver-update]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
