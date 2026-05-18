// /api/db/marketplace?type=freight|ddp
//
// Returns marketplace-shared routes for the calling customer.
// Per Marketplace Protocol v1.0: rows are filtered by raw.sharing.enabled
// AND ((scope='open' AND admin_approved) OR (scope='whitelist' AND viewer.companyCode in authorized_companies)).
//
// Until freight_rates.raw.sharing column is populated we fall back to seed mock
// data so the customer-side Marketplace renders end-to-end. Frontend can be
// pointed at this endpoint today; data sources fill in later without UI churn.
import { getPool, setCors } from "../db.js"; // prod has db.js at /opt/sanlyn-api-test/api/db.js — one level up from api/db/

// ── Mock seed (mirrors Sanlyn-OS/screens/customer/logistics/marketplace/mockData.js) ──
// Keep in sync until DB-backed rates land.
const MOCK_FREIGHT = [
  {
    id: 'rt-qingdao-portklang',
    pol: 'Qingdao', pod: 'Port Klang Westport',
    polFlag: '🇨🇳', podFlag: '🇲🇾',
    region: 'sea', badge: 'hot',
    nextSailingDate: '2026-05-28', nextSailingContainers: '5×40HQ',
    cargoCategory: '食品',
    cutoffMs: Date.now() + 4 * 3600e3 + 36 * 60e3,
    carriers: [
      { name: 'COSCO', voyage: 'V2324', isBest: true, isBooked: true, portSurchargeCny: 4000,
        priceGrid: [
          { ctype: '20GP', rates: [
            { date: '5/28', usd: 400, win: true },
            { date: '6/9',  usd: 420 },
            { date: '6/22', usd: null, label: '未报' },
          ]},
          { ctype: '40HQ', rates: [
            { date: '5/28', usd: 500, win: true },
            { date: '6/9',  usd: 520 },
            { date: '6/22', usd: null, label: '未报' },
          ]},
        ]},
      { name: 'MSC', voyage: 'V324', isBest: false, isBooked: false, portSurchargeCny: 4000,
        priceGrid: [
          { ctype: '20GP', rates: [
            { date: '5/28', usd: 420 },
            { date: '6/9',  usd: null, label: '未报' },
            { date: '6/22', usd: null, label: '未报' },
          ]},
          { ctype: '40HQ', rates: [
            { date: '5/28', usd: 540 },
            { date: '6/9',  usd: null, label: '未报' },
            { date: '6/22', usd: null, label: '未报' },
          ]},
        ]},
    ],
  },
  {
    id: 'rt-shanghai-la',
    pol: 'Shanghai', pod: 'Los Angeles',
    polFlag: '🇨🇳', podFlag: '🇺🇸',
    region: 'namer', badge: 'urgent',
    nextSailingDate: '2026-06-14', nextSailingContainers: '3×40HQ',
    cargoCategory: '一般货',
    cutoffMs: Date.now() + 1 * 86400e3 + 8 * 3600e3,
    carriers: [
      { name: 'EMC', voyage: 'EVER GIVEN', isBest: true, isBooked: false, portSurchargeCny: 3200,
        priceGrid: [
          { ctype: '40HQ', rates: [
            { date: '6/7',  usd: null, label: '未报' },
            { date: '6/14', usd: 2080, win: true },
            { date: '6/21', usd: null, label: '未报' },
          ]},
          { ctype: '40HC', rates: [
            { date: '6/7',  usd: null, label: '未报' },
            { date: '6/14', usd: 2100, win: true },
            { date: '6/21', usd: null, label: '未报' },
          ]},
        ]},
    ],
  },
  {
    id: 'rt-ningbo-hamburg',
    pol: 'Ningbo', pod: 'Hamburg',
    polFlag: '🇨🇳', podFlag: '🇩🇪',
    region: 'europe', badge: 'normal',
    nextSailingDate: '2026-06-17', nextSailingContainers: '4×40HQ',
    cargoCategory: '一般货',
    cutoffMs: Date.now() + 5 * 86400e3 + 2 * 3600e3,
    carriers: [
      { name: 'HAPAG', voyage: 'RIO BLANCO', isBest: true, isBooked: false, portSurchargeCny: 3500,
        priceGrid: [
          { ctype: '40HQ', rates: [
            { date: '6/3',  usd: null, label: '未报' },
            { date: '6/10', usd: null, label: '未报' },
            { date: '6/17', usd: 1650, win: true },
          ]},
        ]},
    ],
  },
];

const MOCK_DDP = [
  {
    id: 'ddp-shanghai-chengdu',
    pol: 'Shanghai', pod: 'Chengdu (DC)',
    polFlag: '🇨🇳', podFlag: '🇨🇳',
    region: 'sea', badge: 'hot',
    nextSailingDate: '2026-05-29', nextSailingContainers: 'truck 9.6m',
    cargoCategory: '宠物食品',
    cutoffMs: Date.now() + 6 * 3600e3,
    carriers: [
      { name: '德邦', voyage: 'SH-CD-001', isBest: true, isBooked: false, slaDays: 4,
        priceGrid: [
          { ctype: '一般货', rates: [
            { date: '5/29 ↓', usd: null, cny: 2.8, win: true, unit: '/kg' },
            { date: '6/2',    usd: null, cny: 2.9, unit: '/kg' },
            { date: '6/5',    usd: null, cny: null, label: '未报' },
          ]},
          { ctype: '食品', rates: [
            { date: '5/29 ↓', usd: null, cny: 3.2, win: true, unit: '/kg' },
            { date: '6/2',    usd: null, cny: 3.3, unit: '/kg' },
            { date: '6/5',    usd: null, cny: null, label: '未报' },
          ]},
        ]},
      { name: '顺丰', voyage: 'SF-EXP-021', isBest: false, isBooked: false, slaDays: 2,
        priceGrid: [
          { ctype: '一般货', rates: [
            { date: '5/29 ↓', usd: null, cny: 4.5, unit: '/kg' },
            { date: '6/2',    usd: null, cny: 4.5, unit: '/kg' },
            { date: '6/5',    usd: null, cny: 4.6, unit: '/kg' },
          ]},
          { ctype: '食品', rates: [
            { date: '5/29 ↓', usd: null, cny: 5.0, unit: '/kg' },
            { date: '6/2',    usd: null, cny: 5.0, unit: '/kg' },
            { date: '6/5',    usd: null, cny: 5.1, unit: '/kg' },
          ]},
        ]},
    ],
  },
  {
    id: 'ddp-xiamen-guangzhou',
    pol: 'Xiamen', pod: 'Guangzhou (Bonded WH)',
    polFlag: '🇨🇳', podFlag: '🇨🇳',
    region: 'sea', badge: 'normal',
    nextSailingDate: '2026-06-03', nextSailingContainers: 'truck 6.8m',
    cargoCategory: '一般货',
    cutoffMs: Date.now() + 2 * 86400e3,
    carriers: [
      { name: '安能', voyage: 'AN-XM-007', isBest: true, isBooked: false, slaDays: 2,
        priceGrid: [
          { ctype: '一般货', rates: [
            { date: '6/3 ↓', usd: null, cny: 1.9, win: true, unit: '/kg' },
            { date: '6/7',   usd: null, cny: 2.0, unit: '/kg' },
          ]},
        ]},
    ],
  },
];

// Determine whether a freight_rates row is visible to the calling viewer.
// Mirrors the in-app sharing util at lib/marketplace/sharing.js.
function isVisible(rowSharing, viewerCodes) {
  if (!rowSharing || !rowSharing.enabled) return false;
  if (rowSharing.scope === 'open') return rowSharing.admin_approved === true;
  if (rowSharing.scope === 'whitelist') {
    const allow = Array.isArray(rowSharing.authorized_companies) ? rowSharing.authorized_companies : [];
    return allow.some(c => viewerCodes.includes(String(c).toUpperCase()));
  }
  return false;
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  const type = String(req.query.type || 'freight').toLowerCase();

  // Viewer scope from JWT (set by global auth middleware)
  const viewerCodes = []
    .concat(req.user?.companyCode || [])
    .concat(req.user?.companyCodes || [])
    .map(c => String(c || '').toUpperCase()).filter(Boolean);

  // ── DDP branch — domestic supply chain, no DB-backed table yet ──
  if (type === 'ddp') {
    // No ddp_rates table yet — return empty so the UI shows a real empty
    // state instead of mock catalog entries that mislead the operator.
    return res.status(200).json({ ok: true, source: 'empty', type, routes: [] });
  }

  // ── Freight (ocean) branch — try DB first, fall back to mock ──
  if (type === 'freight') {
    try {
      const pool = getPool();
      // Probe for the column. freight_rates.raw is JSONB; raw->>'sharing'
      // returns the sub-object as text. If the table or column doesn't exist
      // (PG: undefined_column or undefined_table), we catch + fall back.
      const sql = `
        SELECT id, pol, pod, carrier, raw
        FROM freight_rates
        WHERE raw ? 'sharing' AND (raw->'sharing'->>'enabled')::boolean = true
        LIMIT 100
      `;
      const result = await pool.query(sql);
      const visible = result.rows
        .filter(r => isVisible(r.raw?.sharing, viewerCodes))
        // Group / shape to RouteCard expectations
        .map(r => ({
          id: `db-${r.id}`,
          pol: r.pol, pod: r.pod,
          polFlag: '🇨🇳', podFlag: '🏳',
          region: r.raw?.region || 'other',
          badge: r.raw?.badge || 'normal',
          nextSailingDate: r.raw?.nextSailingDate || null,
          nextSailingContainers: r.raw?.nextSailingContainers || '',
          cargoCategory: r.raw?.cargoCategory || '',
          cutoffMs: r.raw?.cutoffMs || (Date.now() + 7 * 86400e3),
          carriers: r.raw?.carriers || [],
        }));

      return res.status(200).json({ ok: true, source: 'db', type, routes: visible });
    } catch (err) {
      // PG 42P01 (undefined_table) or 42703 (undefined_column) → return empty
      // (UI renders an empty state) instead of mock seed data that misleads.
      return res.status(200).json({ ok: true, source: 'empty', type, routes: [], fallback_reason: err.code || err.message });
    }
  }

  return res.status(400).json({ error: `Unknown marketplace type: ${type}` });
}
