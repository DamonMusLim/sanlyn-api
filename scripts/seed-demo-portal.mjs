import { localNormalizePort, marketCarrierCode, normScheduleCarrier } from "../api/public/_lane-weeks.js";

const DEMO_SET_ID = "demoset-0908";
const FACTORIES = ["Demo Atlas Foods", "Demo Harbor Packing", "Demo Northstar Goods"];
const SCENE_ORDER = ["normal", "normal", "delayed", "unsent", "normal", "normal", "unsent", "normal", "delayed", "normal", "unsent", "normal", "delayed", "unsent", "normal", "normal", "unsent", "normal"];
const SCENES = { normal:"正常在途", unsent:"一直不发货", delayed:"一直改交期" };

function arg(name){ return process.argv.includes(name); }

async function getPool(){
  var pg;
  try {
    pg = await import("pg");
  } catch (e) {
    throw new Error("package pg is required; run npm ci before dry-run/commit");
  }
  const { Pool, types } = pg.default || pg;
  types.setTypeParser(1082, v => v);
  var dsn = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
  if (dsn) return new Pool({ connectionString:dsn, max:3 });
  if (!process.env.PG_HOST || !process.env.PG_DATABASE || !process.env.PG_USER) {
    throw new Error("DATABASE_URL/POSTGRES_URL/PG_URL or PG_HOST+PG_DATABASE+PG_USER required");
  }
  return new Pool({
    host:process.env.PG_HOST,
    port:Number(process.env.PG_PORT || 5432),
    database:process.env.PG_DATABASE,
    user:process.env.PG_USER,
    password:process.env.PG_PASSWORD,
    ssl:process.env.PGSSL === "true" || process.env.PG_SSL === "true" ? { rejectUnauthorized:false } : false,
    max:3,
  });
}

function text(v){ return String(v == null ? "" : v).trim(); }

function ymd(date){
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function dateOnly(v){
  if (v instanceof Date) {
    var out = new Date(v.getTime());
    out.setHours(0, 0, 0, 0);
    return out;
  }
  var s = text(v);
  if (!s) return null;
  var d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  if (!Number.isFinite(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days){ var d = new Date(date.getTime()); d.setDate(d.getDate() + days); return d; }

function diffDays(a, b){ return Math.round((dateOnly(a) - dateOnly(b)) / 86400000); }

function num(v, fallback){ if (v == null || v === "") return fallback; var n = Number(v); return Number.isFinite(n) ? n : fallback; }

function normCarrier(v){ return normScheduleCarrier(v); }

function compact(v){ return text(v).toUpperCase().replace(/\s+/g, ""); }

function splitPortCandidates(v){
  var s = text(v), out = [s];
  var parts = s.match(/[\u4e00-\u9fa5]+|[A-Za-z][A-Za-z\s().-]*/g) || [];
  parts.forEach(p => { if (text(p)) out.push(text(p)); });
  out.forEach(p => {
    var stripped = text(p).replace(/(新港|港区|码头|港)$/g, "");
    if (stripped && stripped !== text(p)) out.push(stripped);
  });
  return Array.from(new Set(out.filter(Boolean)));
}

async function loadPortCodeMap(pool){
  const { rows } = await pool.query(
    `SELECT code, name_cn, name_en
       FROM public.ports
      WHERE COALESCE(code, '') <> ''`
  );
  var byCode = new Map();
  rows.forEach(r => {
    var vals = [r.name_cn, r.name_en, r.code].map(text).filter(Boolean);
    if (text(r.code)) byCode.set(compact(r.code), vals);
  });
  return byCode;
}

function normalizePortForDemo(v, portCodeMap, knownPorts){
  var raw = text(v);
  var candidates = splitPortCandidates(raw);
  var coded = portCodeMap && portCodeMap.get(compact(raw));
  if (coded) coded.forEach(c => splitPortCandidates(c).forEach(x => candidates.push(x)));
  candidates = Array.from(new Set(candidates.filter(Boolean)));
  for (var i = 0; i < candidates.length; i++) {
    var norm = localNormalizePort(candidates[i]);
    if (norm && (!knownPorts || knownPorts.has(norm))) {
      return { value:norm, via:candidates[i], ok:true };
    }
  }
  var fallback = localNormalizePort(raw);
  return { value:fallback, via:raw, ok:!!fallback && (!knownPorts || knownPorts.has(fallback)) };
}

function laneKey(pol, pod){ return [pol, pod].join("\u0001"); }

function routeLabel(row, match){
  var carrierNorm = marketCarrierCode(row.carrier_code) || normCarrier(row.carrier_code);
  return "源单 id=" + row.id
    + "  pol='" + text(row.pol) + "'→归一 " + (match && match.pol ? match.pol.value : "")
    + "  pod='" + text(row.pod) + "'→归一 " + (match && match.pod ? match.pod.value : "")
    + "  carrier='" + text(row.carrier_code) + "'→归一 " + carrierNorm
    + "   market_sailings 未来21天命中 " + (match && match.route ? match.route.sailing_count : 0)
    + " 班  首班 " + (match && match.route && match.route.first_etd ? match.route.first_etd : "NULL");
}

function factoryFor(seq){
  if (seq <= 5) return FACTORIES[0];
  if (seq <= 11) return FACTORIES[1];
  return FACTORIES[2];
}

async function shippingCount(pool){
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.shipping_plans");
  return rows[0].n;
}

async function loadMarketRoutes(pool, today, portCodeMap){
  const { rows } = await pool.query(
    `SELECT pol_name AS pol, pod_name AS pod, carrier, vessel, voyage,
            etd::date::text AS etd, eta::date::text AS eta, id
       FROM market_sailings
      WHERE etd >= $1::date
        AND etd < $2::date
        AND COALESCE(pol_name, '') <> ''
        AND COALESCE(pod_name, '') <> ''
        AND COALESCE(carrier, '') <> ''
      ORDER BY etd, id`,
    [ymd(today), ymd(addDays(today, 21))]
  );
  var knownPorts = new Set();
  rows.forEach(r => {
    splitPortCandidates(r.pol).concat(splitPortCandidates(r.pod)).forEach(p => {
      var norm = localNormalizePort(p);
      if (norm) knownPorts.add(norm);
    });
  });
  var routes = new Map(), routesByLane = new Map();
  rows.forEach(r => {
    var carrierCode = marketCarrierCode(r.carrier) || normCarrier(r.carrier);
    if (!carrierCode) return;
    var pol = normalizePortForDemo(r.pol, portCodeMap, knownPorts).value;
    var pod = normalizePortForDemo(r.pod, portCodeMap, knownPorts).value;
    if (!pol || !pod) return;
    var key = [pol, pod, carrierCode].join("\u0001");
    var existing = routes.get(key);
    if (existing) {
      existing.sailing_count += 1;
      existing.first_etd = existing.first_etd && existing.first_etd < r.etd ? existing.first_etd : r.etd;
      existing.last_etd = existing.last_etd && existing.last_etd > r.etd ? existing.last_etd : r.etd;
      existing.sailings.push({ vessel:r.vessel, voyage:r.voyage, etd:r.etd, eta:r.eta });
      return;
    }
    var route = { pol, pod, carrier_code:carrierCode, sailing_count:1, first_etd:r.etd, last_etd:r.etd,
      sailings:[{ vessel:r.vessel, voyage:r.voyage, etd:r.etd, eta:r.eta }] };
    routes.set(key, route);
    var lk = laneKey(pol, pod);
    if (!routesByLane.has(lk)) routesByLane.set(lk, []);
    routesByLane.get(lk).push(route);
  });
  routes.forEach(route => route.sailings.sort((a, b) => text(a.etd).localeCompare(text(b.etd))));
  routesByLane.forEach(list => list.sort((a, b) => text(a.first_etd).localeCompare(text(b.first_etd))));
  if (!routes.size) throw new Error("market_sailings future 21-day routes = 0; cannot seed demo lanes");
  return { routes, routesByLane, knownPorts };
}

async function loadRecentShippingRows(pool){
  const { rows } = await pool.query(
    `SELECT id, etd::date::text AS source_etd, eta::date::text AS source_eta,
            COALESCE(actual_handover_date, factory_cargo_ready, cargo_ready_date)::date::text AS source_delivery,
            pol, pod, carrier_code, vessel, voyage, container_qty, container_type,
            gross_weight_kg, cargo_description, freight_cost, port_surcharge_total,
            thc_fee, seal_fee, vgm_fee, doc_fee, eir_fee
       FROM public.shipping_plans
      WHERE etd IS NOT NULL
        AND COALESCE(pol, '') <> ''
        AND COALESCE(pod, '') <> ''
        AND COALESCE(container_type, '') <> ''
        AND gross_weight_kg IS NOT NULL
        AND COALESCE(cargo_description, '') <> ''
      ORDER BY etd DESC, id DESC
      LIMIT 300`
  );
  if (rows.length < 18) throw new Error("recent public.shipping_plans candidates < 18");
  return rows;
}

async function assertDemoIdsDoNotHitReal(pool, ids){
  const { rows } = await pool.query(
    `SELECT id, bl_no, booking_no, forwarder_booking_no
       FROM public.shipping_plans
      WHERE bl_no = ANY($1::text[])
         OR booking_no = ANY($1::text[])
         OR forwarder_booking_no = ANY($1::text[])
      LIMIT 1`,
    [ids]
  );
  if (rows.length) throw new Error("DEMO id collides with public.shipping_plans id=" + rows[0].id);
}

function pickSailing(route, offset){
  var list = route.sailings.filter(s => text(s.etd));
  var wanted = list.find(s => diffDays(s.etd, new Date()) >= offset);
  return wanted || list[0] || {};
}

function sourceDelivery(row){ return row.source_delivery || ymd(addDays(dateOnly(row.source_etd), -4)); }

function buildOffsets(row, seq, scene, fixes){
  var sourceEtd = dateOnly(row.source_etd);
  var sourceEta = dateOnly(row.source_eta);
  var sourceDel = dateOnly(sourceDelivery(row));
  var delToEtd = Math.max(0, diffDays(sourceEtd, sourceDel));
  var etdToEta = sourceEta ? diffDays(sourceEta, sourceEtd) : 8;
  var deliveryOffset = ((seq - 1) % 18) + 1;
  var etdOffset = scene === "unsent" ? null : deliveryOffset + delToEtd;
  var etaOffset = etdOffset == null ? null : etdOffset + etdToEta;
  var forced = [];
  if (scene !== "unsent") {
    if (etdOffset >= 21) {
      delToEtd = Math.max(0, delToEtd - (etdOffset - 20));
      etdOffset = deliveryOffset + delToEtd;
      forced.push("etd_offset_clamped_to_20");
    }
    if (etaOffset <= etdOffset) {
      etaOffset = etdOffset + 1;
      forced.push("eta_after_etd");
    }
    if (deliveryOffset > etdOffset) {
      deliveryOffset = etdOffset;
      forced.push("delivery_before_or_on_etd");
    }
  }
  if (forced.length) fixes.push({ demo_plan_id:"DEMO-" + String(seq).padStart(3, "0"), source_id:row.id, fixes:forced });
  return { deliveryOffset, etdOffset, etaOffset, delToEtd, etdToEta, forced };
}

function buildEvents(plan, count){
  var events = [], current = plan.delivery_offset_days - count * 2;
  for (var i = 1; i <= count; i++) {
    var next = i === count ? plan.delivery_offset_days : current + 2;
    events.push({ seq:i, old_value:"offset:" + current, new_value:"offset:" + next,
      reason:["原料到厂延迟", "排产顺延", "验货后补箱", "客户确认延迟", "等柜期"][i - 1],
      actor:i % 2 ? "Demo Factory" : "Demo Planner", raw:{ old_offset_days:current, new_offset_days:next } });
    current = next;
  }
  return events;
}

function pickRoute(row, market, portCodeMap){
  var pol = normalizePortForDemo(row.pol, portCodeMap, market.knownPorts);
  var pod = normalizePortForDemo(row.pod, portCodeMap, market.knownPorts);
  var match = { pol, pod, route:null };
  if (!pol.ok || !pod.ok) return { match, reason:"港口无法归一" };
  var laneRoutes = market.routesByLane.get(laneKey(pol.value, pod.value)) || [];
  if (!laneRoutes.length) return { match, reason:"无船期" };
  var sourceCarrier = marketCarrierCode(row.carrier_code) || normCarrier(row.carrier_code);
  match.route = laneRoutes.find(r => r.carrier_code === sourceCarrier) || laneRoutes[0];
  return { match, route:match.route, carrier:match.route.carrier_code };
}

function buildPlans(rows, market, portCodeMap){
  var plans = [];
  var skipped = [];
  var fixes = [];
  for (var round = 0; plans.length < 18; round++) {
    var added = 0;
    for (const row of rows) {
      if (plans.length >= 18) break;
      var picked = pickRoute(row, market, portCodeMap);
      if (!picked.route) {
        if (round === 0) skipped.push({ source_id:row.id, source_etd:row.source_etd, reason:picked.reason, diagnostic:routeLabel(row, picked.match) });
        continue;
      }
      var route = picked.route, carrier = picked.carrier;
      var seq = plans.length + 1;
      var scene = SCENE_ORDER[seq - 1];
      var id = "DEMO-" + String(seq).padStart(3, "0");
      var blNo = "DEMO-BL-" + String(seq).padStart(3, "0");
      var offsets = buildOffsets(row, seq, scene, fixes);
      var sailing = offsets.etdOffset == null ? {} : pickSailing(route, offsets.etdOffset);
      var plan = {
        demo_plan_id:id, factory:factoryFor(seq), lane_seq:((seq - 1) % 3) + 1, plan_seq:seq, scene,
        source_id:row.id, source_etd:row.source_etd, source_eta:row.source_eta, source_delivery:sourceDelivery(row),
        pol:text(row.pol), pod:text(row.pod), carrier_code:carrier,
        vessel:text(sailing.vessel) || text(row.vessel) || null,
        voyage:text(sailing.voyage) || text(row.voyage) || null,
        etd_offset_days:offsets.etdOffset, delivery_offset_days:offsets.deliveryOffset, eta_offset_days:offsets.etaOffset,
        container_qty:num(row.container_qty, 1),
        container_type:text(row.container_type),
        gross_weight_kg:num(row.gross_weight_kg, null),
        cargo_description:text(row.cargo_description),
        bl_no:blNo, booking_no:id + "-BKG", forwarder_booking_no:id + "-FWD",
        booking_stage:scene === "unsent" ? "pending" : "booked",
        shipping_status:scene === "unsent" ? "pending" : "booked",
        current_status_cn:scene === "unsent" ? "货好未发 / 待订舱" : "已订舱",
        freight_cost:num(row.freight_cost, null), port_surcharge_total:num(row.port_surcharge_total, null),
        thc_fee:num(row.thc_fee, 0), seal_fee:num(row.seal_fee, 0), vgm_fee:num(row.vgm_fee, 0),
        doc_fee:num(row.doc_fee, 0), eir_fee:num(row.eir_fee, 0),
        raw:{ source:"seed-demo-portal", sampled_from_public_shipping_plan_id:row.id,
          sampled_from_public_etd:row.source_etd, sampled_from_public_eta:row.source_eta,
          sampled_from_public_delivery:sourceDelivery(row),
          source_intervals:{ delivery_to_etd_days:offsets.delToEtd, etd_to_eta_days:offsets.etdToEta },
          factory:factoryFor(seq), scene, route_confirmed_by:"market_sailings",
          normalized_route:{ pol:picked.match.pol.value, pod:picked.match.pod.value,
            pol_via:picked.match.pol.via, pod_via:picked.match.pod.via },
          sanitized_fields:["bl_no", "booking_no", "forwarder_booking_no", "factory"], date_forced:offsets.forced },
      };
      plan.route_diagnostic = routeLabel(row, picked.match);
      plan.events = scene === "delayed" ? buildEvents(plan, 3 + ((seq - 1) % 3)) : [];
      plans.push(plan);
      added += 1;
    }
    if (!added) break;
  }
  return { plans, skipped, fixes };
}

function printPlan(plan){
  var route = plan.pol + " -> " + plan.pod + " / " + plan.carrier_code;
  console.log(plan.route_diagnostic);
  console.log([plan.demo_plan_id, plan.factory, SCENES[plan.scene], "source_id=" + plan.source_id,
    "source_etd=" + plan.source_etd, route, plan.container_type, plan.gross_weight_kg + "kg",
    plan.cargo_description, "delivery_offset=" + plan.delivery_offset_days,
    "etd_offset=" + (plan.etd_offset_days == null ? "NULL" : plan.etd_offset_days),
    "eta_offset=" + (plan.eta_offset_days == null ? "NULL" : plan.eta_offset_days),
    plan.vessel ? ("vessel=" + plan.vessel + " " + (plan.voyage || "")) : "vessel=NULL"].join(" | "));
}

async function purge(client){
  await client.query("DELETE FROM demo.forwarder_shipping_plans WHERE demo_set_id = $1", [DEMO_SET_ID]);
}

async function insertPlans(client, plans){
  for (const plan of plans) {
    const ins = await client.query(
      `INSERT INTO demo.forwarder_shipping_plans
        (demo_set_id, demo_plan_id, lane_seq, plan_seq, bl_no, pol, pod, carrier_code,
         vessel, voyage, etd, eta, etd_offset_days, delivery_offset_days, eta_offset_days,
         container_qty, container_type, gross_weight_kg, cargo_description, booking_no,
         forwarder_booking_no, booking_stage, shipping_status, current_status_cn,
         freight_cost, port_surcharge_total, thc_fee, seal_fee, vgm_fee, doc_fee, eir_fee, raw)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb)
       RETURNING id`,
      [DEMO_SET_ID, plan.demo_plan_id, plan.lane_seq, plan.plan_seq, plan.bl_no, plan.pol, plan.pod,
        plan.carrier_code, plan.vessel, plan.voyage, plan.etd_offset_days, plan.delivery_offset_days,
        plan.eta_offset_days, plan.container_qty, plan.container_type, plan.gross_weight_kg,
        plan.cargo_description, plan.booking_no, plan.forwarder_booking_no, plan.booking_stage,
        plan.shipping_status, plan.current_status_cn, plan.freight_cost, plan.port_surcharge_total,
        plan.thc_fee, plan.seal_fee, plan.vgm_fee, plan.doc_fee, plan.eir_fee, JSON.stringify(plan.raw)]
    );
    for (const ev of plan.events) {
      await client.query(
        `INSERT INTO demo.forwarder_delivery_change_events
          (demo_plan_id, seq, field_name, old_value, new_value, reason, actor, raw)
         VALUES ($1,$2,'delivery_date',$3,$4,$5,$6,$7::jsonb)`,
        [ins.rows[0].id, ev.seq, ev.old_value, ev.new_value, ev.reason, ev.actor, JSON.stringify(ev.raw)]
      );
    }
  }
}

function printSummary(plans, skipped, fixes, before, after, dry){
  var counts = plans.reduce((m, p) => { m[p.scene] = (m[p.scene] || 0) + 1; return m; }, {});
  var skipReasons = skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
  var skipReasonText = Object.keys(skipReasons).sort().map(r => r + "=" + skipReasons[r]).join("; ") || "候选行耗尽";
  console.log("mode=" + (dry ? "dry" : "commit") + " demo_set_id=" + DEMO_SET_ID);
  console.log("public.shipping_plans count before=" + before + " after=" + after);
  console.log("scene_counts normal=" + (counts.normal || 0) + " unsent=" + (counts.unsent || 0) + " delayed=" + (counts.delayed || 0));
  console.log("skipped_rows=" + skipped.length);
  Object.keys(skipReasons).sort().forEach(r => console.log("- skipped_reason count=" + skipReasons[r] + " reason=" + r));
  skipped.forEach(s => {
    if (s.diagnostic) console.log(s.diagnostic);
    console.log("- skipped source_id=" + s.source_id + " source_etd=" + s.source_etd + " reason=" + s.reason);
  });
  if (plans.length < 18) {
    console.log("只凑到 " + plans.length + " 票 · 跳过分布:无船期 " + (skipReasons["无船期"] || 0)
      + " / 港口无法归一 " + (skipReasons["港口无法归一"] || 0)
      + " / 其他 " + (skipped.length - (skipReasons["无船期"] || 0) - (skipReasons["港口无法归一"] || 0)));
    console.log("只凑到 " + plans.length + " 票,原因: " + skipReasonText);
  }
  console.log("date_forced_fixes=" + fixes.length);
  fixes.forEach(f => console.log("- fixed " + f.demo_plan_id + " source_id=" + f.source_id + " fixes=" + f.fixes.join(",")));
  console.log("plans:");
  plans.forEach(printPlan);
  console.log("write_scope=" + (dry ? "none(dry-run)" : "demo.forwarder_shipping_plans,demo.forwarder_delivery_change_events"));
}

async function main(){
  var commit = arg("--commit"), dry = !commit, pool = await getPool();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    var before = await shippingCount(pool), portCodeMap = await loadPortCodeMap(pool);
    var market = await loadMarketRoutes(pool, today, portCodeMap);
    var built = buildPlans(await loadRecentShippingRows(pool), market, portCodeMap);
    var ids = built.plans.flatMap(p => [p.bl_no, p.booking_no, p.forwarder_booking_no]);
    await assertDemoIdsDoNotHitReal(pool, ids);
    if (commit) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (arg("--purge")) await purge(client);
        await insertPlans(client, built.plans);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    var after = await shippingCount(pool);
    if (before !== after) throw new Error("public.shipping_plans count changed: before=" + before + " after=" + after);
    printSummary(built.plans, built.skipped, built.fixes, before, after, dry);
  } finally {
    await pool.end();
  }
}

main().catch(function(e){
  console.error("ERROR " + (e && e.message ? e.message : e));
  process.exit(1);
});
