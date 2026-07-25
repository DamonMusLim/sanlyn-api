import { getPool, setCors } from "../db.js";

// POST /api/public/ship-schedules-sync  维运网船期接收端(Studio weiyun-scheduler 公网直推)
// 鉴权:X-Sync-Key 必须等于 env WEIYUN_SYNC_KEY(对齐 Studio ~/weiyun-scheduler/.sync-key)
// 入参:{ route:"宁波→吉大港", carrier, transit_days, cutoffs, captured_at,
//        sailings:[{ weekDay:"周五", transitDays:"11天", carriers:"HMM(KCB) | SKR 长锦(KCB)吉大直航",
//                    departures:["07.26(日)","07.31(五)"] }] }
// 落 ship_schedules,唯一键 (route_label, carrier_name, route_code) 做 upsert。
// 关键:weekDay/transitDays 必须写进 week_day/transit_days —— 旧链路丢了这两列导致价格总台班期/运程全空。

// "07.26(日)" → "2026-07-26";跨年(12月抓到1月船期)按就近年份推断
function toDate(s, now) {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10);
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  let y = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  if (curM >= 11 && mm <= 2) y += 1;        // 年末抓到次年初
  else if (curM <= 2 && mm >= 11) y -= 1;   // 年初抓到去年末
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// "HMM(KCB) | SKR 长锦(KCB)吉大直航" → 主船司 "HMM";" | " 分段即共舱
function primaryCarrier(carriers) {
  const first = String(carriers || "").split("|")[0].trim();
  const noParen = first.replace(/[（(].*$/, "").trim();
  return (noParen.split(/\s+/)[0] || "").trim() || null;
}

// "(KCB)" → "KCB";没有则 null(唯一键的第三段,不能是 undefined)
function routeCodeOf(carriers) {
  const m = String(carriers || "").match(/[（(]([A-Za-z0-9]+)[)）]/);
  return m ? m[1] : "";
}

// 静默失败会一路绿灯(莱城抓 0 条却报 ✅ 就是这么漏的),异常一律进任务中心让人/Claude 能看见。
// dedupe_key 防同一问题天天刷屏;上报失败不影响主流程。
async function reportIssue(pool, key, title, reason) {
  try {
    await pool.query(
      `INSERT INTO tasks (id, title, reason, status, source, priority, domain, dedupe_key)
       VALUES ($1,$2,$3,'open','weiyun-sync','p1','海运',$4)
       ON CONFLICT DO NOTHING`,
      [key.slice(0, 32), title.slice(0, 180), reason, key]);
  } catch { /* 上报本身失败不能拖垮同步 */ }
}

async function resolvePort(pool, cn) {
  const name = String(cn || "").trim();
  if (!name) return null;
  const r = await pool.query(
    `SELECT COALESCE(
       (SELECT p.name_en FROM ports p WHERE btrim(p.name_cn)=$1 LIMIT 1),
       (SELECT p2.name_en FROM port_aliases a JOIN ports p2 ON p2.id=a.port_id
          WHERE btrim(a.alias)=$1 AND a.is_active LIMIT 1)
     ) AS en`, [name]);
  return (r.rows[0] && r.rows[0].en) || null;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const expected = process.env.WEIYUN_SYNC_KEY;
  const got = req.headers["x-sync-key"];
  if (!expected) return res.status(500).json({ ok: false, error: "WEIYUN_SYNC_KEY not configured" });
  if (!got || String(got) !== String(expected)) return res.status(401).json({ ok: false, error: "bad sync key" });

  const pool = getPool();
  try {
    const b = req.body || {};
    const routeLabel = String(b.route || "").trim();
    if (!routeLabel) return res.status(400).json({ ok: false, error: "route required" });
    const sailings = Array.isArray(b.sailings) ? b.sailings : [];

    const parts = routeLabel.split(/→|->|-/).map((s) => s.trim()).filter(Boolean);
    const pol = await resolvePort(pool, parts[0]);
    const pod = await resolvePort(pool, parts[1]);
    if (!pol || !pod) {
      // 港口名可能是客户/货代的简称(如"莱城"),不能想当然映射,查不到就报出来人工确认真实港口
      await reportIssue(pool, `wy-port-${(parts[0] || "") + (parts[1] || "")}`.slice(0, 32),
        `维运网航线港口名解析失败:${routeLabel}`,
        `route=${routeLabel} 起运港中文=${parts[0] || "(空)"}→${pol || "解析不出"} 目的港中文=${parts[1] || "(空)"}→${pod || "解析不出"}。` +
        `该中文名可能是客户/货代简称,需人工确认真实港口后在 ports.name_cn 或 port_aliases 补别名,否则这条航线船期永远进不来。`);
      return res.status(422).json({ ok: false, error: "港口中文名解析失败,请先在 port_aliases 补别名",
        route: routeLabel, polCn: parts[0] || null, podCn: parts[1] || null, pol, pod });
    }

    const now = b.captured_at ? new Date(b.captured_at) : new Date();
    const stamp = Number.isNaN(now.getTime()) ? new Date() : now;
    let upserted = 0, skipped = 0;
    const carrierSet = new Set();

    for (const s of sailings) {
      const carriers = s && s.carriers;
      const carrierName = primaryCarrier(carriers);
      if (!carrierName) { skipped++; continue; }
      const routeCode = routeCodeOf(carriers);
      const deps = Array.isArray(s.departures) ? s.departures : [];
      const dates = deps.map((d) => toDate(d, stamp)).filter(Boolean).sort();
      const allDepartures = dates.map((d) => ({ etd: d, eta: null, vessel: carriers || null, voyage: null }));
      // transitDays "11天" → 11;取不到整数存 null,不硬塞 0
      const tdMatch = String(s.transitDays || "").match(/\d+/);
      const transitDays = tdMatch ? parseInt(tdMatch[0], 10) : null;

      await pool.query(
        `INSERT INTO ship_schedules
           (route_label, pol, pod, week_day, transit_days, carrier_name, route_code,
            this_week, next_sailing, source, updated_at, all_departures)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'weiyun',now(),$10::jsonb)
         ON CONFLICT (route_label, carrier_name, route_code) DO UPDATE SET
           pol=EXCLUDED.pol, pod=EXCLUDED.pod,
           week_day=EXCLUDED.week_day, transit_days=EXCLUDED.transit_days,
           this_week=EXCLUDED.this_week, next_sailing=EXCLUDED.next_sailing,
           all_departures=EXCLUDED.all_departures, source='weiyun', updated_at=now()`,
        [routeLabel, pol, pod, s.weekDay || null, transitDays, carrierName, routeCode,
         dates[0] || null, dates[0] || null, JSON.stringify(allDepartures)]
      );
      upserted++;
      carrierSet.add(carrierName);
    }

    // 收到请求但一条都没落库 = 上游抓取空转(extractor 崩了/页面变了),必须报出来,
    // 否则 run_all 那边照样打 ✅,断了也没人知道(莱城就是这么静默了一整周)。
    if (upserted === 0) {
      await reportIssue(pool, `wy-empty-${routeLabel}`.slice(0, 32),
        `维运网船期同步收到空数据:${routeLabel}`,
        `route=${routeLabel} pol=${pol} pod=${pod} 收到 sailings=${sailings.length} 条,落库 0 条(skipped=${skipped})。` +
        `多半是 Studio 侧 extractor 崩了或维运网页面结构变了。查 ~/weiyun-scheduler/run.log 与对应 extractor 脚本。`);
    }
    return res.status(200).json({ ok: true, route: routeLabel, pol, pod,
      carriers: carrierSet.size, upserted, skipped });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
