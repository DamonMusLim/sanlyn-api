const MIN_LEAD_DAYS = 3;
export const SCHEDULE_POD_CODE_ALIAS = { MYPKGW: "MYWSP" };
const CARRIER_ALIAS = { EVERGREEN: "EMC", MAERSK: "MSK", MSK: "MSK" };

function toISODate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function addDaysISO(v, days) {
  const iso = toISODate(v);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function diffDaysISO(a, b) {
  return Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 864e5);
}

export function normCarrier(s) {
  const token = String(s || "").trim().toUpperCase().split(/\s+/)[0] || "";
  return CARRIER_ALIAS[token] || token;
}

function laneKey(polCode, podCode) {
  return `${polCode}→${podCode}`;
}

export async function loadLaneSailings(pool, lanes) {
  const unique = [];
  const seen = new Set();
  for (const lane of lanes || []) {
    const polCode = String(lane?.polCode || "").trim().toUpperCase();
    const podCode = String(lane?.podCode || "").trim().toUpperCase();
    if (!polCode || !podCode) continue;
    const key = laneKey(polCode, podCode);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ polCode, podCode });
    }
  }
  if (!unique.length) return new Map();

  try {
    const values = unique.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
    const params = unique.flatMap(lane => [lane.polCode, lane.podCode]);
    const sql = `
      WITH requested(pol_code, pod_code) AS (VALUES ${values}),
      latest AS (
        SELECT r.pol_code, r.pod_code, max(ms.captured_on) AS captured_on
        FROM requested r
        LEFT JOIN market_sailings ms
          ON ms.pol_code = r.pol_code AND ms.pod_code = r.pod_code
        GROUP BY r.pol_code, r.pod_code
      )
      SELECT ms.pol_code, ms.pod_code, ms.carrier, ms.vessel, ms.voyage,
             (ms.etd AT TIME ZONE 'Asia/Shanghai')::date AS etd_date,
             ms.transit_days, ms.line_type, ms.captured_on
      FROM latest l
      JOIN market_sailings ms
        ON ms.pol_code = l.pol_code
       AND ms.pod_code = l.pod_code
       AND ms.captured_on = l.captured_on
      WHERE l.captured_on >= ((now() AT TIME ZONE 'Asia/Shanghai')::date - 3)
        AND (ms.etd AT TIME ZONE 'Asia/Shanghai')::date >= ((now() AT TIME ZONE 'Asia/Shanghai')::date - 3)
      ORDER BY ms.pol_code, ms.pod_code, ms.etd, ms.id
    `;
    const result = await pool.query(sql, params);
    const out = new Map();
    for (const r of result.rows) {
      const key = laneKey(r.pol_code, r.pod_code);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({
        carrier: r.carrier,
        vessel: r.vessel,
        voyage: r.voyage,
        etd: toISODate(r.etd_date),
        transit_days: r.transit_days,
        line_type: r.line_type,
        captured_on: toISODate(r.captured_on),
      });
    }
    return out;
  } catch (err) {
    console.warn("loadLaneSailings failed", err?.code || err?.message || err);
    return new Map();
  }
}

export function pickSailing(row, sailings, todayISO) {
  const carrier = normCarrier(row?.carrier);
  if (!carrier || !Array.isArray(sailings) || !sailings.length) return null;

  let cand = sailings
    .filter(s => normCarrier(s.carrier) === carrier)
    .filter(s => toISODate(s.etd));
  if (!cand.length) return null;

  const ownEtd = toISODate(row?.next_sailing);
  if (ownEtd) {
    const preferredType = row?.via ? "中转" : "直达";
    const preferred = cand.filter(s => s.line_type === preferredType);
    if (preferred.length) cand = preferred;

    const matched = cand
      .map(s => ({ s, distance: Math.abs(diffDaysISO(toISODate(s.etd), ownEtd)) }))
      .filter(x => x.distance <= 2)
      .sort((a, b) => a.distance - b.distance || String(toISODate(b.s.etd)).localeCompare(toISODate(a.s.etd)))[0];
    if (!matched) return null;
    const sailingDate = toISODate(matched.s.etd);
    const transit = Number(matched.s.transit_days);
    return {
      sailingDate,
      etaDate: Number.isFinite(transit) && transit > 0 ? addDaysISO(sailingDate, transit) : null,
      vessel: matched.s.vessel || null,
      voyage: matched.s.voyage || null,
      matched: true,
    };
  }

  if (!todayISO) return null;
  const minDate = addDaysISO(todayISO, MIN_LEAD_DAYS);
  const withTransit = cand
    .map(s => {
      const sailingDate = toISODate(s.etd);
      const transit = Number(s.transit_days);
      return {
        s,
        sailingDate,
        transit,
        etaDate: Number.isFinite(transit) && transit > 0 ? addDaysISO(sailingDate, transit) : null,
      };
    })
    .filter(x => x.sailingDate >= minDate && x.etaDate)
    .sort((a, b) => String(a.etaDate).localeCompare(b.etaDate) || String(a.sailingDate).localeCompare(b.sailingDate))[0];
  const next = withTransit?.s || cand
    .filter(s => toISODate(s.etd) >= minDate)
    .sort((a, b) => String(toISODate(a.etd)).localeCompare(toISODate(b.etd)))[0];
  if (!next) return null;
  const sailingDate = toISODate(next.etd);
  const transit = Number(next.transit_days);
  return {
    sailingDate,
    etaDate: withTransit ? withTransit.etaDate : null,
    vessel: next.vessel || null,
    voyage: next.voyage || null,
    matched: true,
  };
}

export function pickSailings(row, sailings, todayISO, limit = null) {
  const carrier = normCarrier(row?.carrier);
  if (!carrier || !Array.isArray(sailings) || !sailings.length || !todayISO) return [];

  const minDate = addDaysISO(todayISO, MIN_LEAD_DAYS);
  const maxDate = addDaysISO(todayISO, 21); // Damon 0915: 只显3周内的班
  const seenEtd = new Set();
  const rows = sailings
    .filter(s => normCarrier(s.carrier) === carrier)
    .map(s => {
      const etd = toISODate(s.etd);
      const transit = Number(s.transit_days);
      const eta = Number.isFinite(transit) && transit > 0 ? addDaysISO(etd, transit) : null;
      return { etd, eta };
    })
    .filter(s => s.etd && s.etd >= minDate && s.etd <= maxDate && s.eta)
    .sort((a, b) => String(a.etd).localeCompare(b.etd))
    .filter(s => {
      if (seenEtd.has(s.etd)) return false;
      seenEtd.add(s.etd);
      return true;
    });

  return limit == null ? rows : rows.slice(0, Number(limit) || 0);
}
