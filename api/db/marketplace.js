// /api/db/marketplace?type=freight|ddp
//
// Ocean Marketplace routes for Logistics Hub.
// 2026-06-11 rewrite (Damon 拍板):
//   · Data source = freight_rates (active + 船期未过期), grouped by POL+POD lane.
//   · Customer sees ONLY customer_* sell prices — 成本列只在服务端用于算 lane 中间价，绝不输出.
//   · Visibility = lanes matching the viewer's historical order PODs
//     (orders.raw.pod, normalized: KELANG/KLANG→same family). No history →
//     show all lanes (filter is anti-clutter, rates are not per-customer secrets).
//   · Internal (admin/finance) sees all; ?company=CN-000xx lets internal view
//     the hub as that company (company selector in HubHome).
//   · All MOCK seed data removed — empty DB renders a real empty state.
import { getPool, setCors } from "../db.js";
import {
  loadLaneSailings,
  pickSailing,
  pickSailings,
  SCHEDULE_POD_CODE_ALIAS,
  normCarrier,
} from "./_market-sailing-dates.js";

const MY_FAMILIES = new Set(["KLANG", "KK", "PASIR"]);
const LANE_MID_FLOOR_MARKUP_USD = 50;
const DERIVED_ETD_OFFSET_DAYS = 1;

// Normalize messy POD spellings to a port family key.
// "PORT KELANG WEST" / "Port Klang Westport" / "PORT KLANG" → KLANG
function podFamily(p) {
  const s = String(p || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  if (s.includes("KLANG") || s.includes("KELANG")) return "KLANG";
  if (s.includes("KINABALU") || s === "KK") return "KK";
  if (s.includes("PASIR") || s.includes("GUDANG")) return "PASIR";
  return s;
}

function toISODate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function rateDateISO(r) {
  return toISODate(r.valid_from) || toISODate(r.created_at);
}

function isHistoricalRate(r) {
  const d = rateDateISO(r);
  return !!d && (Date.now() - new Date(d + "T00:00:00Z").getTime()) > 30 * 864e5;
}

function addDaysISO(v, days) {
  const iso = toISODate(v);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function laneMid(rows, costKey, isHistoricalFn) {
  const freshCosts = rows
    .filter(r => !isHistoricalFn(r))
    .map(r => positiveNumber(r[costKey]))
    .filter(n => n != null);
  if (!freshCosts.length) return null;
  const minCost = Math.min(...freshCosts);
  const maxCost = Math.max(...freshCosts);
  return Math.max(
    Math.round((minCost + maxCost) / 2),
    minCost + LANE_MID_FLOOR_MARKUP_USD
  );
}

export function shouldShowLane(rows) {
  return rows.some(r => positiveNumber(r.customer_hq40) != null || positiveNumber(r.customer_gp20) != null);
}

export function lockPublicPrices(route) {
  return {
    ...route,
    floorSellGp20: null,
    floorSellHq40: null,
    priceLocked: true,
    // 未登录不许按价格/真报价排序(排序本身会泄露谁是真报价、谁最便宜):改按船期、再按船司名
    carriers: [...(route.carriers || [])]
      .sort((a, b) => String(a.sailingDate || "9999").localeCompare(String(b.sailingDate || "9999")) || String(a.name || "").localeCompare(String(b.name || "")))
      .map(carrier => ({
      ...carrier,
      sellHq40: null,
      sellGp20: null,
      isBest: false,
      // historical/rateDate 会暴露哪些是旧报价派生行;rateId 公开态无用
      historical: false,
      rateDate: null,
      rateId: null,
      priceGrid: (carrier.priceGrid || []).map(row => ({
        ...row,
        rates: (row.rates || []).map(rate => ({
          date: rate.date,
          usd: null,
          label: "login",
        })),
      })),
    })),
  };
}

function floorSell(rows, key, isHistoricalFn) {
  const prices = rows
    .filter(r => !isHistoricalFn(r))
    .map(r => positiveNumber(r[key]))
    .filter(n => n != null);
  return prices.length ? Math.min(...prices) : null;
}

function publicRateFields(r) {
  return {
    id: r.id,
    pol: r.pol,
    pod: r.pod,
    pod_port_id: r.pod_port_id,
    pol_port_id: r.pol_port_id,
    carrier: r.carrier,
    route_code: r.route_code,
    via: r.via,
    transit_days: r.transit_days,
    next_sailing: r.next_sailing,
    eta_date: r.eta_date,
    doc_cutoff: r.doc_cutoff,
    cargo_cutoff: r.cargo_cutoff,
    free_days_base: r.free_days_base,
    free_days_ext: r.free_days_ext,
    freetime: r.freetime,
    customer_hq40: r.customer_hq40,
    customer_gp20: r.customer_gp20,
    valid_from: r.valid_from,
    created_at: r.created_at,
    pod_canonical_name: r.pod_canonical_name,
  };
}

export function priceLane(rows, isHistoricalFn = isHistoricalRate) {
  const laneMidHq40 = laneMid(rows, "hq40", isHistoricalFn);
  const laneMidGp20 = laneMid(rows, "gp20", isHistoricalFn);
  const floorSellHq40 = floorSell(rows, "customer_hq40", isHistoricalFn);
  const floorSellGp20 = floorSell(rows, "customer_gp20", isHistoricalFn);
  const byCarrier = new Map();

  for (const raw of rows) {
    if (!raw.carrier || !String(raw.carrier).trim()) continue; // 无船司的行不上牌
    const historical = isHistoricalFn(raw);
    const ownHq = !historical ? positiveNumber(raw.customer_hq40) : null;
    const ownGp = !historical ? positiveNumber(raw.customer_gp20) : null;
    const displayHq = ownHq != null ? ownHq : laneMidHq40;
    const displayGp = ownGp != null ? ownGp : laneMidGp20;
    const source = ownHq != null || ownGp != null
      ? "customer_rate"
      : (displayHq != null || displayGp != null ? "lane_mid" : "inquiry");
    const priority = source === "customer_rate" ? 0 : 1;
    const cmp = displayHq != null ? displayHq : (displayGp != null ? displayGp * 2 : Infinity);
    const cur = byCarrier.get(raw.carrier);
    if (!cur || priority < cur._priority || (priority === cur._priority && cmp < cur._cmp)) {
      byCarrier.set(raw.carrier, {
        ...publicRateFields(raw),
        _priority: priority,
        _cmp: cmp,
        _ownHq40: ownHq,
        _ownGp20: ownGp,
        _displayHq40: displayHq,
        _displayGp20: displayGp,
        _source: source,
      });
    }
  }

  const pricedRows = [...byCarrier.values()];
  let bestId = null;
  let bestPrice = Infinity;
  for (const r of pricedRows) {
    const p = r._ownHq40 != null ? Number(r._ownHq40) : null;
    if (p != null && p < bestPrice) {
      bestPrice = p;
      bestId = r.id;
    }
  }

  return { rows: pricedRows, bestId, laneMidHq40, laneMidGp20, floorSellHq40, floorSellGp20 };
}

function minTransit(laneRows, sailings, carrier) {
  const carrierTransit = (sailings || [])
    .filter(s => normCarrier(s.carrier) === normCarrier(carrier))
    .map(s => positiveNumber(s.transit_days))
    .filter(n => n != null);
  if (carrierTransit.length) return Math.min(...carrierTransit);
  const laneTransit = laneRows
    .map(r => positiveNumber(r.transit_days))
    .filter(n => n != null);
  return laneTransit.length ? Math.min(...laneTransit) : null;
}

function withScheduleMeta(dates, meta = {}) {
  for (const [key, value] of Object.entries({
    vessel: meta.vessel || null,
    voyage: meta.voyage || null,
    matched: meta.matched === true,
  })) {
    Object.defineProperty(dates, key, { value, enumerable: false });
  }
  return dates;
}

export function rowDates(row, laneRows, isHistoricalFn = isHistoricalRate, sailings = [], todayISO = null) {
  const pick = pickSailing({ ...row, next_sailing: null }, sailings, todayISO); // 0914 Damon:船期以维运网为准,不用货代报的日期(货代多报进港/截单日)
  if (pick) return withScheduleMeta({ sailingDate: pick.sailingDate, etaDate: pick.etaDate }, pick);

  const realEtd = toISODate(row.next_sailing);
  let sailingDate = realEtd;

  if (!sailingDate && row._source === "lane_mid") {
    const base = laneRows
      .filter(r => !isHistoricalFn(r))
      .filter(r => positiveNumber(r.customer_hq40) != null || positiveNumber(r.customer_gp20) != null)
      .map(r => toISODate(r.next_sailing))
      .filter(Boolean)
      .sort()[0] || null;
    sailingDate = addDaysISO(base, DERIVED_ETD_OFFSET_DAYS);
  }

  let etaDate = toISODate(row.eta_date);
  if (!etaDate && sailingDate) {
    const transit = positiveNumber(row.transit_days) || minTransit(laneRows, sailings, row.carrier);
    etaDate = transit != null ? addDaysISO(sailingDate, transit) : null;
  }

  return withScheduleMeta({ sailingDate, etaDate });
}

// ports 表 MYJHB/MYPGU 是同一码头两条记录——牌价层先折叠，根治归港口命名项目
const POD_FOLD = { "johor (pasir gudang)": "Pasir Gudang" };
function normalizePodName(pod) {
  const t = String(pod || "").trim();
  return POD_FOLD[t.toLowerCase()] || t;
}
// 2026-07-23：同一份已知重复主数据在 port_id 层的折叠（MYJHB id=129 → 并入 MYPGU id=227 的桶）。
// 这条只用于"确认是同一码头的重复 ports 记录"这一具体案例，绝不能用来合并 Westport(131)/Northport(132)
// 这种真实不同码头——那两个 code 不在这张表里，永远各自独立分组。
const POD_PORT_ID_FOLD = { 129: 227 };
function podMeta(pod) {
  const f = podFamily(pod);
  const isMy = MY_FAMILIES.has(f);
  return { flag: isMy ? "🇲🇾" : "🏳", region: isMy ? "sea" : "other" };
}

function fmtSailing(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function todayShanghaiISO() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function scheduleCodes(row) {
  const polCode = String(row?.pol_unlocode || "").trim().toUpperCase();
  const rawPodCode = String(row?.pod_unlocode || "").trim().toUpperCase();
  const podCode = SCHEDULE_POD_CODE_ALIAS[rawPodCode] || rawPodCode;
  return polCode && podCode ? { polCode, podCode } : null;
}

function laneSailingKey(row) {
  const codes = scheduleCodes(row);
  return codes ? `${codes.polCode}→${codes.podCode}` : null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });

  const type = String(req.query.type || "freight").toLowerCase();

  const role = String(req.user?.role || "").toLowerCase();
  const isInternal = role === "admin" || role === "finance" || role === "internal_ops";
  let viewerCodes = []
    .concat(req.user?.companyCode || [])
    .concat(req.user?.companyCodes || [])
    .map(c => String(c || "").toUpperCase()).filter(Boolean);

  // Internal company-selector override: view the hub as a specific company.
  const companyOverride = String(req.query.company || "").toUpperCase().trim();
  const viewAsCompany = isInternal && companyOverride ? companyOverride : null;
  if (viewAsCompany) viewerCodes = [viewAsCompany];

  // 公开牌价（未登录）：/api/public/marketplace 挂同一 handler。卖价牌不是秘密（下方 anti-clutter
  // 注释同口径），无身份=不做订单史过滤直接全量在售航线；本 handler 本来就只吐 customer_* 卖价。
  const isPublic = !req.user && String(req.path || req.url || "").startsWith("/api/public/marketplace");

  if (type === "ddp") {
    // No ddp_rates table yet — real empty state, never mock.
    return res.status(200).json({
      ok: true,
      source: "empty",
      type,
      routes: [],
      ...(isPublic ? { priceLocked: true } : {}),
    });
  }

  if (type !== "freight") {
    return res.status(400).json({
      error: `Unknown marketplace type: ${type}`,
      ...(isPublic ? { priceLocked: true } : {}),
    });
  }

  try {
    const pool = getPool();

    // 1. Viewer's historical POD families (skip for unscoped internal view).
    let allowedFamilies = null; // null = no lane filter
    if (!isPublic && (!isInternal || viewAsCompany)) {
      if (viewerCodes.length === 0) {
        // Fail-closed: external viewer with no scope sees nothing.
        return res.status(200).json({ ok: true, source: "db", type, routes: [] });
      }
      const hist = await pool.query(
        `SELECT DISTINCT raw->>'pod' AS pod FROM orders
         WHERE upper(company_code) = ANY($1) AND raw->>'pod' IS NOT NULL AND raw->>'pod' <> ''`,
        [viewerCodes]
      );
      const fams = new Set(hist.rows.map(r => podFamily(r.pod)).filter(Boolean));
      // History exists → filter to those lanes. No history → show all
      // (anti-clutter filter only; sell-price cards are not secrets).
      if (fams.size > 0) allowedFamilies = fams;
    }

    // 2. Active, non-expired rate cards. customer_* sell prices are output;
    //    hq40/gp20 costs are selected only for server-side laneMid calculation.
    // 2026-07-23 港口规范化补齐：join ports 拿 pod_port_id 的 canonical_name，
    // 分组优先按 pod_port_id（同一真实港口的不同写法归一条 lane）。
    const rates = await pool.query(`
      SELECT r.id, r.pol, r.pod, r.pod_port_id, r.pol_port_id, r.carrier, r.route_code, r.via, r.transit_days,
             r.next_sailing, r.eta_date, r.doc_cutoff, r.cargo_cutoff,
             r.free_days_base, r.free_days_ext, r.freetime, r.gp20, r.hq40,
             r.customer_hq40, r.customer_gp20, r.valid_from, r.created_at,
             pp.unlocode AS pol_unlocode, p.unlocode AS pod_unlocode,
             p.name_en AS pod_canonical_name
      FROM freight_rates r
      LEFT JOIN ports pp ON pp.id = r.pol_port_id
      LEFT JOIN ports p ON p.id = r.pod_port_id
      WHERE r.status = 'active'
        AND (r.next_sailing IS NULL
             OR r.next_sailing::date >= (now() AT TIME ZONE 'Asia/Singapore')::date)
      ORDER BY r.pol, r.pod, r.next_sailing NULLS LAST, r.id DESC
    `);

    // 3. Group by POL + POD into lane cards.
    //    pod_port_id 存在 → 用 port_id 分组(同港口不同写法归一);
    //    NULL(未解析) → 回退旧的文本折叠(POD_FOLD band-aid 兜底)。
    const lanes = new Map();
    for (const r of rates.rows) {
      if (allowedFamilies && !allowedFamilies.has(podFamily(r.pod))) continue;
      r.pod = normalizePodName(r.pod_canonical_name || r.pod); // 港口规范名优先，仍过 POD_FOLD 兜底折叠已知重复记录
      const foldedPortId = r.pod_port_id != null ? (POD_PORT_ID_FOLD[r.pod_port_id] || r.pod_port_id) : null;
      const podKey = foldedPortId != null ? `pid:${foldedPortId}` : r.pod;
      const key = `${r.pol}→${podKey}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(r);
    }

    const todayISO = todayShanghaiISO();
    const sailingLanes = [];
    const seenSailingLanes = new Set();
    for (const allRows of lanes.values()) {
      const codes = scheduleCodes(allRows[0]);
      if (!codes) continue;
      const key = `${codes.polCode}→${codes.podCode}`;
      if (seenSailingLanes.has(key)) continue;
      seenSailingLanes.add(key);
      sailingLanes.push(codes);
    }
    const laneSailings = await loadLaneSailings(pool, sailingLanes);

    let routes = [...lanes.entries()].map(([key, allRows]) => {
      const laneCutoff = allRows
        .map(r => toISODate(r.doc_cutoff) || toISODate(r.cargo_cutoff))
        .filter(Boolean)
        .sort()[0] || null;

      if (!shouldShowLane(allRows)) return null;
      const { rows, bestId, floorSellHq40, floorSellGp20 } = priceLane(allRows, isHistoricalRate);
      if (!rows.length) return null;
      const { flag, region } = podMeta(rows[0].pod);
      const laneScheduleRows = laneSailings.get(laneSailingKey(allRows[0])) || [];

      const carriers = rows.map(r => {
        const realEtd = toISODate(r.next_sailing);
        const dateInfo = rowDates(r, allRows, isHistoricalRate, laneScheduleRows, todayISO);
        const sailingOptions = pickSailings(r, laneScheduleRows, todayISO);
        const { sailingDate, etaDate } = dateInfo;
        const date = fmtSailing(sailingDate) || "—";
        const isBest = r._source === "customer_rate"; // 0914 Damon:★=真有报价的实际船公司(可多家),不再只标最低价
        const grid = [];
        const hq = r._displayHq40 != null ? Number(r._displayHq40) : null;
        grid.push({ ctype: "40HQ", rates: [hq != null ? { date, usd: hq, win: isBest } : { date, usd: null, label: "询价" }] });
        const gp = r._displayGp20 != null ? Number(r._displayGp20) : null;
        if (gp != null) grid.push({ ctype: "20GP", rates: [{ date, usd: gp }] });
        const row = {
          name: r.carrier || "—",
          isBest,
          isBooked: false,
          // 建单用（BookSheet）：ISO 船期 + 卖价 + 运价卡 id（全是卖方侧字段，客户可见无泄漏）
          rateId: r.id,
          sailingDate,
          date: sailingDate,
          etaDate,
          sailings: sailingOptions,
          cutoffDate: laneCutoff,
          sellHq40: hq,
          sellGp20: gp,
          transitDays: r.transit_days || null,
          via: r.via || null,
          freeDays: r.free_days_base != null
            ? (r.free_days_ext ? `${r.free_days_base}+${r.free_days_ext}` : String(r.free_days_base))
            : (r.freetime != null ? String(r.freetime) : "7"),
          priceGrid: grid,
          // pg 驱动吐 Date 对象，必须 toISOString 取日期，String().slice 会得 "Mon Jul 13" 再 parse 成 2001 年
          rateDate: rateDateISO(r),
          historical: isHistoricalRate(r),
        };
        if (isInternal) {
          row._realEtd = realEtd;
          row._displayEtd = sailingDate;
          row._source = r._source;
          row._schedule = { vessel: dateInfo.vessel, voyage: dateInfo.voyage, matched: dateInfo.matched };
        }
        return row;
      });

      // ★(真报价)在前按 40HQ 升序:前端默认选中 carriers.find(isBest),保证默认=最低真价
      carriers.sort((a, b) => (b.isBest - a.isBest) || ((a.sellHq40 ?? Infinity) - (b.sellHq40 ?? Infinity)));
      const sailings = carriers.map(c => c.sailingDate).filter(Boolean).sort();
      return {
        id: `lane-${key.replace(/[^A-Za-z0-9]+/g, "-")}`,
        pol: rows[0].pol, pod: rows[0].pod,
        polFlag: "🇨🇳", podFlag: flag,
        region,
        badge: "normal",
        nextSailingDate: sailings[0] || null,
        nextSailingContainers: "",
        cargoCategory: "",
        currency: "USD",
        locale: "en",
        floorSellGp20,
        floorSellHq40,
        carriers,
      };
    })
    .filter(Boolean)
    // Lanes with nearest sailing first, lanes without dates last.
    .sort((a, b) => String(a.nextSailingDate || "9999") < String(b.nextSailingDate || "9999") ? -1 : 1);

    if (isPublic) routes = routes.map(lockPublicPrices);

    return res.status(200).json({
      ok: true,
      source: "db",
      type,
      locale: "en",
      currency: "USD",
      routes,
      ...(isPublic ? { priceLocked: true } : {}),
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      source: "error",
      type,
      routes: [],
      fallback_reason: err.code || err.message,
      ...(isPublic ? { priceLocked: true } : {}),
    });
  }
}
