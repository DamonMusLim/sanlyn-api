import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// GET /api/db/freight-board  价格总台(航线为轴)
// 航线(POL→POD 归一) → 船期(维运网 ship_schedules,含无报价的船) → 该船各货代报价
// 规则(Damon 2026-07-24 定):一个航班只选最低的一家。forwarders 按【总成本】升序,只有最低那家 isLowest。
//   总成本 = 40HQ海运费 × 汇率 + 40HQ港杂。港杂缺 → totalCny=null,不参与排序,排最后,标 needsPortCharge。
// 港杂两级匹配:local_charge_code 硬绑定优先 → 自然键兜底(货代/船司/起运港/柜型);空 forwarder 只走硬绑定不通配。
// ?history=1 连过期运价一起返回。
const FALLBACK_FX = 6.7703;

const CARRIER_NORM = `COALESCE(NULLIF(COALESCE(
  (SELECT code FROM carriers c WHERE upper(c.code)=upper(btrim(%SRC%))),
  (SELECT canonical_code FROM carrier_aliases a WHERE a.raw_upper=upper(btrim(%SRC%))),
  upper(btrim(%SRC%))
), ''), 'UNKNOWN')`;

const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const dstr = (v) => (!v ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function getFx(pool) {
  try {
    const r = await pool.query(`SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`);
    const v = num(r.rows[0] && r.rows[0].rate);
    if (v) return { fxRate: v, fxSource: "db" };
  } catch { /* 取不到走兜底 */ }
  return { fxRate: FALLBACK_FX, fxSource: "fallback" };
}

// 共舱串 "KMTC(KCM3) | ONE(KCS) | YML(KCX) | 南星(FS1)东南亚直航" → ['KMTC','ONE','YML','南星']
// 维运网只把主船司写进 carrier_name,共舱的其余船司仅存在 vessel 串里;
// 不拆开的话,YML 的运价会匹配不到这条 KMTC 船,单独多出一行。
function consortiumCarriers(vessel) {
  if (typeof vessel !== "string" || !vessel.includes("|")) return [];
  return vessel.split("|")
    .map((seg) => seg.replace(/[（(].*$/, "").trim().split(/\s+/)[0])
    .map((s) => (s || "").trim())
    .filter(Boolean);
}

function parseDepartures(raw, fallbackEtd) {
  let d = raw;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { d = null; } }
  if (!Array.isArray(d) || !d.length) return fallbackEtd ? [{ etd: fallbackEtd, eta: null, vessel: null, voyage: null }] : [];
  return d;
}

function makeRateRow(r) {
  return {
    id: r.id, forwarder: r.forwarder,
    gp20: r.gp20, hq40: r.hq40, customerGp20: r.customer_gp20, customerHq40: r.customer_hq40,
    portGp20: r.port_gp20, portGp20Source: r.port_gp20_source,
    portHq40: r.port_hq40, portHq40Source: r.port_hq40_source, portProvider: r.port_provider,
    chargeCodeConflict: r.charge_code_conflict === true,   // FK 指向的港杂与本运价 起运港/船司 不符,已忽略该绑定改走自然键
    nextSailing: r.next_sailing, etaDate: r.eta_date,
    validFrom: r.valid_from, validTo: r.valid_to,
    transitDays: r.transit_days, freetime: r.freetime, currency: r.currency,
    isCurrent: r.is_current, updatedAt: r.updated_at,
  };
}

// 算总成本 + 排序 + 标最低。港杂缺的排最后且不参与最低判定。
function finalizeForwarders(list, fxRate) {
  for (const f of list) {
    const freight = num(f.latest && f.latest.hq40);
    const port = num(f.latest && f.latest.portHq40);
    f.needsPortCharge = port === null;
    f.freightUsd = freight;
    f.portHq40 = port;
    f.totalCny = (freight !== null && port !== null) ? Math.round(freight * fxRate + port) : null;
    f.isLowest = false;
    f.freightLowerButTotalHigher = false;
  }
  list.sort((a, b) => {
    if (a.totalCny === null && b.totalCny === null) return String(a.forwarder || "").localeCompare(String(b.forwarder || ""));
    if (a.totalCny === null) return 1;   // 缺港杂排最后
    if (b.totalCny === null) return -1;
    return a.totalCny - b.totalCny;
  });
  const low = list.find((f) => f.totalCny !== null);
  if (low) {
    low.isLowest = true;
    for (const f of list) {
      if (f === low || f.totalCny === null) continue;
      // 海运费比最低那家还低,但总成本更高 → 港杂把便宜吃回去了
      if (f.freightUsd !== null && low.freightUsd !== null && f.freightUsd < low.freightUsd && f.totalCny > low.totalCny) {
        f.freightLowerButTotalHigher = true;
      }
    }
  }
  return list;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;   // 价格总台含客户价 customer_*,不裸露
  const pool = getPool();
  try {
    const includeExpired = req.query.history === "1";
    const { fxRate, fxSource } = await getFx(pool);
    const cnorm = (src) => CARRIER_NORM.split("%SRC%").join(src);

    const rateSql = `
      WITH base AS (
        SELECT f.id, f.pol, f.pod, f.carrier, f.local_charge_code,
          f.gp20, f.hq40, f.customer_gp20, f.customer_hq40,
          f.next_sailing, f.eta_date, f.valid_from, f.valid_to, f.transit_days, f.freetime,
          f.currency, f.updated_at,
          initcap(btrim(f.pol)) AS pol_norm, initcap(btrim(f.pod)) AS pod_norm,
          NULLIF(btrim(f.forwarder), '') AS forwarder,
          ${cnorm("f.carrier")} AS carrier_code,
          (f.valid_to IS NULL OR f.valid_to >= CURRENT_DATE) AS is_current
        FROM freight_rates f
        WHERE f.status IS DISTINCT FROM 'withdrawn'
      )
      SELECT b.id, b.pol_norm, b.pod_norm, b.carrier_code,
        COALESCE(ca.name_cn, b.carrier_code) AS carrier_name,
        b.forwarder, b.gp20, b.hq40, b.customer_gp20, b.customer_hq40,
        b.next_sailing, b.eta_date, b.valid_from, b.valid_to,
        b.transit_days, b.freetime, b.currency, b.is_current, b.updated_at,
        lc20.cost_total AS port_gp20, lc20.src AS port_gp20_source,
        lc40.cost_total AS port_hq40, lc40.src AS port_hq40_source,
        COALESCE(lc40.company_name, lc20.company_name) AS port_provider,
        EXISTS (
          SELECT 1 FROM local_charges x
          WHERE x.charge_code = b.local_charge_code AND x.is_active
            AND (lower(btrim(x.pol)) <> lower(btrim(b.pol))
              OR upper(btrim(x.carrier)) <> upper(btrim(b.carrier)))
        ) AS charge_code_conflict
      FROM base b
      LEFT JOIN carriers ca ON ca.code = b.carrier_code
      LEFT JOIN LATERAL (
        SELECT cost_total, company_name,
          CASE WHEN lc.charge_code = b.local_charge_code THEN 'charge_code' ELSE 'natural_key' END AS src
        FROM local_charges lc
        WHERE lc.is_active AND lc.container_type ~* '20' AND (
          (lc.charge_code = b.local_charge_code
            AND lower(btrim(lc.pol))=lower(btrim(b.pol))
            AND upper(btrim(lc.carrier))=upper(btrim(b.carrier)))
          OR (b.forwarder IS NOT NULL
              AND lower(btrim(lc.pol))=lower(btrim(b.pol))
              AND lower(btrim(lc.carrier))=lower(btrim(b.carrier))
              AND lower(btrim(lc.company_name))=lower(btrim(b.forwarder)))
        )
        ORDER BY (lc.charge_code = b.local_charge_code AND lower(btrim(lc.pol))=lower(btrim(b.pol))) DESC NULLS LAST,
                 updated_at DESC NULLS LAST LIMIT 1
      ) lc20 ON TRUE
      LEFT JOIN LATERAL (
        SELECT cost_total, company_name,
          CASE WHEN lc.charge_code = b.local_charge_code THEN 'charge_code' ELSE 'natural_key' END AS src
        FROM local_charges lc
        WHERE lc.is_active AND lc.container_type ~* '40|HQ|45' AND (
          (lc.charge_code = b.local_charge_code
            AND lower(btrim(lc.pol))=lower(btrim(b.pol))
            AND upper(btrim(lc.carrier))=upper(btrim(b.carrier)))
          OR (b.forwarder IS NOT NULL
              AND lower(btrim(lc.pol))=lower(btrim(b.pol))
              AND lower(btrim(lc.carrier))=lower(btrim(b.carrier))
              AND lower(btrim(lc.company_name))=lower(btrim(b.forwarder)))
        )
        ORDER BY (lc.charge_code = b.local_charge_code AND lower(btrim(lc.pol))=lower(btrim(b.pol))) DESC NULLS LAST,
                 updated_at DESC NULLS LAST LIMIT 1
      ) lc40 ON TRUE
      ${includeExpired ? "" : "WHERE b.is_current"}
      ORDER BY b.pol_norm, b.pod_norm, b.carrier_code, b.forwarder NULLS LAST,
        b.is_current DESC, b.valid_from DESC NULLS LAST, b.updated_at DESC, b.next_sailing DESC NULLS LAST`;

    const schedSql = `
      SELECT initcap(btrim(ss.pol)) AS pol_norm, initcap(btrim(ss.pod)) AS pod_norm,
        ${cnorm("ss.carrier_name")} AS carrier_code,
        ss.carrier_name AS raw_carrier, ss.route_label, ss.route_code,
        ss.week_day, ss.transit_days, ss.next_sailing, ss.all_departures,
        ss.source, ss.updated_at
      FROM ship_schedules ss
      WHERE ss.pol IS NOT NULL AND ss.pod IS NOT NULL`;

    // 待询价时"该找谁":该航线历史上报过价的货代(含已过期),按报价条数排
    const knownFwdSql = `
      SELECT initcap(btrim(pol)) AS pol_norm, initcap(btrim(pod)) AS pod_norm,
        NULLIF(btrim(forwarder),'') AS forwarder, count(*)::int AS n
      FROM freight_rates
      WHERE status IS DISTINCT FROM 'withdrawn' AND NULLIF(btrim(forwarder),'') IS NOT NULL
      GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`;

    const carrierMapSql = `
      SELECT upper(btrim(code)) AS raw, code FROM carriers
      UNION ALL
      SELECT upper(btrim(raw_upper)), canonical_code FROM carrier_aliases`;
    const [rateRes, schedRes, cmapRes, knownRes] = await Promise.all([
      pool.query(rateSql), pool.query(schedSql), pool.query(carrierMapSql), pool.query(knownFwdSql)]);
    const knownFwd = new Map();   // "pol|pod" → [{forwarder, quotedCount}]
    for (const k of knownRes.rows) {
      const key = `${k.pol_norm}|${k.pod_norm}`;
      if (!knownFwd.has(key)) knownFwd.set(key, []);
      knownFwd.get(key).push({ forwarder: k.forwarder, quotedCount: k.n });
    }
    // 共舱船司归一用(SQL 里归一不了 vessel 串,拿到 Node 层做)
    const carrierMap = new Map(cmapRes.rows.map((r) => [r.raw, r.code]));
    const normCarrier = (s) => carrierMap.get(String(s || "").trim().toUpperCase()) || String(s || "").trim().toUpperCase();

    const routes = new Map();
    const getRoute = (pol, pod) => {
      const k = `${pol}|${pod}`;
      let r = routes.get(k);
      if (!r) { r = { pol, pod, scheds: new Map(), aliasToSched: new Map() }; routes.set(k, r); }
      return r;
    };

    // 1) 先灌维运网船期(含没有任何报价的船)
    for (const s of schedRes.rows) {
      const route = getRoute(s.pol_norm, s.pod_norm);
      if (route.scheds.has(s.carrier_code)) continue;
      const deps = parseDepartures(s.all_departures, s.next_sailing);
      const vessel = (deps[0] && deps[0].vessel) || null;
      const members = consortiumCarriers(vessel).map(normCarrier);
      // 共舱的每个船司都指向同一条 schedule,这样 YML 的运价能落到 KMTC 这条船上
      for (const m of members) if (m && !route.scheds.has(m)) route.aliasToSched.set(m, s.carrier_code);
      route.scheds.set(s.carrier_code, {
        carrierCode: s.carrier_code, carrierName: s.raw_carrier || s.carrier_code,
        routeCode: s.route_code, weekDay: s.week_day, transitDays: s.transit_days,
        nextSailing: s.next_sailing,
        departures: deps.map((d) => ({ etd: d.etd || null, eta: d.eta || null, vessel: d.vessel || null, voyage: d.voyage || null })),
        vessel,
        isConsortium: members.length > 1,
        consortiumCarriers: members,
        scheduleSource: s.source || "weiyun", scheduleUpdatedAt: s.updated_at,
        fwdMap: new Map(),
      });
    }

    // 2) 再灌运价;维运网没这条船的,按运价补一条 schedule(scheduleSource='rate')
    for (const r of rateRes.rows) {
      const route = getRoute(r.pol_norm, r.pod_norm);
      let sc = route.scheds.get(r.carrier_code);
      // 本船司没有独立船期时,看它是不是某条共舱船的成员(如 YML 在 KMTC 那条 KCM3 上)
      if (!sc && route.aliasToSched.has(r.carrier_code)) {
        sc = route.scheds.get(route.aliasToSched.get(r.carrier_code));
      }
      if (!sc) {
        sc = {
          carrierCode: r.carrier_code, carrierName: r.carrier_name,
          routeCode: null, weekDay: null, transitDays: r.transit_days,
          nextSailing: r.next_sailing, departures: [], vessel: null, isConsortium: false,
          scheduleSource: "rate", scheduleUpdatedAt: null, fwdMap: new Map(),
        };
        route.scheds.set(r.carrier_code, sc);
      }
      const fk = r.forwarder || "__none__";
      const row = makeRateRow(r);
      const fkey = `${fk}::${r.carrier_code}`;
      const f2 = sc.fwdMap.get(fkey);
      if (!f2) sc.fwdMap.set(fkey, { forwarder: r.forwarder, rateCarrierCode: r.carrier_code, rateCarrierName: r.carrier_name, latest: row, history: [] });
      else f2.history.push(row);

    }

    // 3) 收口:算总成本、排序、标最低
    const out = [...routes.values()].map((rt) => {
      const schedules = [...rt.scheds.values()].map((sc) => {
        const forwarders = finalizeForwarders([...sc.fwdMap.values()], fxRate);
        const lowest = forwarders.find((f) => f.isLowest) || null;
        delete sc.fwdMap;
        return {
          ...sc, forwarders, hasRate: forwarders.length > 0,
          lowestTotalCny: lowest ? lowest.totalCny : null,
          quotedCount: forwarders.length,
        };
      });
      schedules.sort((a, b) => {
        if (a.hasRate !== b.hasRate) return a.hasRate ? -1 : 1;
        const ad = dstr(a.nextSailing), bd = dstr(b.nextSailing);
        if (ad && bd && ad !== bd) return ad.localeCompare(bd);
        if (ad && !bd) return -1;
        if (!ad && bd) return 1;
        return String(a.carrierName || "").localeCompare(String(b.carrierName || ""));
      });
      const tds = schedules.map((s) => num(s.transitDays)).filter((v) => v != null);
      const fastest = tds.length ? Math.min(...tds) : null;
      for (const s of schedules) s.isFastest = fastest != null && num(s.transitDays) === fastest;
      return {
        pol: rt.pol, pod: rt.pod, schedules,
        sailingCount: schedules.length,
        quotedCount: schedules.filter((s) => s.hasRate).length,
        knownForwarders: (knownFwd.get(`${rt.pol}|${rt.pod}`) || []).slice(0, 4),
        fastestTransitDays: fastest,
      };
    });
    out.sort((a, b) => (a.pol + a.pod).localeCompare(b.pol + b.pod));

    return res.status(200).json({ success: true, fxRate, fxSource, routes: out, total: out.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
