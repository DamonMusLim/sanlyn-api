// /api/db/marketplace?type=freight|ddp
//
// Ocean Marketplace routes for Logistics Hub.
// 2026-06-11 rewrite (Damon 拍板):
//   · Data source = freight_rates (active + 船期未过期), grouped by POL+POD lane.
//   · Customer sees ONLY customer_* sell prices — hq40/gp20 cost columns are
//     NEVER selected here (成本泄漏铁律). Missing sell price → label「询价」.
//   · Visibility = lanes matching the viewer's historical order PODs
//     (orders.raw.pod, normalized: KELANG/KLANG→same family). No history →
//     show all lanes (filter is anti-clutter, rates are not per-customer secrets).
//   · Internal (admin/finance) sees all; ?company=CN-000xx lets internal view
//     the hub as that company (company selector in HubHome).
//   · All MOCK seed data removed — empty DB renders a real empty state.
import { getPool, setCors } from "../db.js";

const MY_FAMILIES = new Set(["KLANG", "KK", "PASIR"]);

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
    return res.status(200).json({ ok: true, source: "empty", type, routes: [] });
  }

  if (type !== "freight") {
    return res.status(400).json({ error: `Unknown marketplace type: ${type}` });
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

    // 2. Active, non-expired rate cards. customer_* sell prices ONLY —
    //    hq40/gp20 (采购成本) must never appear in this endpoint.
    // 2026-07-23 港口规范化补齐：join ports 拿 pod_port_id 的 canonical_name，
    // 分组优先按 pod_port_id（同一真实港口的不同写法归一条 lane）。
    const rates = await pool.query(`
      SELECT r.id, r.pol, r.pod, r.pod_port_id, r.pol_port_id, r.carrier, r.route_code, r.via, r.transit_days,
             r.next_sailing, r.free_days_base, r.free_days_ext, r.freetime,
             r.customer_hq40, r.customer_gp20, r.valid_from, r.created_at,
             p.name_en AS pod_canonical_name
      FROM freight_rates r
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

    const routes = [...lanes.entries()].map(([key, allRows]) => {
      // 2026-06-11 Damon 拍板：①无卖价的行不上架（航线时间还不全，询价行=噪音）
      // ②同一船司只保留最低卖价一条。整航线没有任何有价行 → 不显示该航线卡。
      const priced = allRows.filter(r =>
        (r.customer_hq40 != null && Number(r.customer_hq40) > 0) ||
        (r.customer_gp20 != null && Number(r.customer_gp20) > 0));
      const byCarrier = new Map();
      for (const r of priced) {
        if (!r.carrier || !String(r.carrier).trim()) continue; // 无船司的行不上牌
        const k = r.carrier;
        const cmp = r.customer_hq40 != null ? Number(r.customer_hq40) : Number(r.customer_gp20) * 2;
        const cur = byCarrier.get(k);
        if (!cur || cmp < cur._cmp) byCarrier.set(k, Object.assign({}, r, { _cmp: cmp }));
      }
      const rows = [...byCarrier.values()];
      if (!rows.length) return null;
      const { flag, region } = podMeta(rows[0].pod);

      // Best = lowest customer 40HQ sell price in the lane (priced rows only).
      let bestId = null, bestPrice = Infinity;
      for (const r of rows) {
        const p = r.customer_hq40 != null ? Number(r.customer_hq40) : null;
        if (p != null && p < bestPrice) { bestPrice = p; bestId = r.id; }
      }

      const carriers = rows.map(r => {
        const date = fmtSailing(r.next_sailing) || "—";
        const isBest = r.id === bestId;
        const grid = [];
        const hq = r.customer_hq40 != null ? Number(r.customer_hq40) : null;
        grid.push({ ctype: "40HQ", rates: [hq != null ? { date, usd: hq, win: isBest } : { date, usd: null, label: "询价" }] });
        const gp = r.customer_gp20 != null ? Number(r.customer_gp20) : null;
        if (gp != null) grid.push({ ctype: "20GP", rates: [{ date, usd: gp }] });
        return {
          name: r.carrier || "—",
          voyage: r.route_code || "",
          isBest,
          isBooked: false,
          // 建单用（BookSheet）：ISO 船期 + 卖价 + 运价卡 id（全是卖方侧字段，客户可见无泄漏）
          rateId: r.id,
          sailingDate: r.next_sailing ? String(r.next_sailing).slice(0, 10) : null,
          sellHq40: hq,
          sellGp20: gp,
          transitDays: r.transit_days || null,
          via: r.via || null,
          freeDays: r.free_days_base != null
            ? (r.free_days_ext ? `${r.free_days_base}+${r.free_days_ext}` : String(r.free_days_base))
            : (r.freetime != null ? String(r.freetime) : null),
          priceGrid: grid,
          // pg 驱动吐 Date 对象，必须 toISOString 取日期，String().slice 会得 "Mon Jul 13" 再 parse 成 2001 年
          rateDate: toISODate(r.valid_from) || toISODate(r.created_at),
          historical: (() => {
            const d = toISODate(r.valid_from) || toISODate(r.created_at);
            return !!d && (Date.now() - new Date(d + "T00:00:00Z").getTime()) > 30 * 864e5;
          })(),
        };
      });

      const sailings = rows.map(r => r.next_sailing).filter(Boolean).sort();
      return {
        id: `lane-${key.replace(/[^A-Za-z0-9]+/g, "-")}`,
        pol: rows[0].pol, pod: rows[0].pod,
        polFlag: "🇨🇳", podFlag: flag,
        region,
        badge: "normal",
        nextSailingDate: sailings[0] || null,
        nextSailingContainers: "",
        cargoCategory: "",
        carriers,
      };
    })
    .filter(Boolean)
    // Lanes with nearest sailing first, lanes without dates last.
    .sort((a, b) => String(a.nextSailingDate || "9999") < String(b.nextSailingDate || "9999") ? -1 : 1);

    return res.status(200).json({ ok: true, source: "db", type, routes });
  } catch (err) {
    return res.status(200).json({ ok: true, source: "error", type, routes: [], fallback_reason: err.code || err.message });
  }
}
