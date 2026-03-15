const JDY_TOKEN = 'qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU';
const JDY_APP = '689cb08a93c073210bfc772b';
const JDY_ENTRY = '691e76b3cb637ee7ef1f25ca';

const DOC_MAP = {
  invoice:     '_widget_1771737294158',
  bl:          '_widget_1763604147209',
  packingList: '_widget_1763604147206',
  pi:          '_widget_1771739769157',
  customs:     '_widget_1767008538949',
  hc:          '_widget_1767008538946',
  vc:          '_widget_1767008538947',
  co:          '_widget_1763604147210',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { contractNo } = req.query;
  if (!contractNo) return res.status(400).json({ error: 'contractNo required' });

  try {
    const jdyRes = await fetch('https://api.jiandaoyun.com/api/v5/app/entry/data/list', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${JDY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: JDY_APP, entry_id: JDY_ENTRY, limit: 1,
        filter: { rel: 'and', cond: [{ field: '_widget_1769161081476', type: 'eq', val: [contractNo] }] }
      }),
    });
    const data = await jdyRes.json();
    const row = (data.data || [])[0];
    if (!row) return res.status(200).json({ contractNo, docs: {} });

    const docs = {};
    for (const [key, widget] of Object.entries(DOC_MAP)) {
      const files = row[widget] || [];
      if (files.length > 0) docs[key] = { url: files[0].url, name: files[0].name, size: files[0].size };
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ contractNo, docs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
