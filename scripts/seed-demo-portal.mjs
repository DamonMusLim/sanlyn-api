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

function normCarrier(v){ return text(v).toUpperCase().replace(/\s+/g, ""); }

function routeKey(pol, pod, carrier){ return [text(pol), text(pod), normCarrier(carrier)].join("\u0001"); }

function factoryFor(seq){
  if (seq <= 5) return FACTORIES[0];
  if (seq <= 11) return FACTORIES[1];
  return FACTORIES[2];
}

async function shippingCount(pool){
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.shipping_plans");
  return rows[0].n;
}

async function loadMarketRoutes(pool, today){
  const { rows } = await pool.query(
    `SELECT pol_name AS pol, pod_name AS pod,
            upper(substring(btrim(COALESCE(carrier, '')) from '^[A-Za-z0-9-]+')) AS carrier_code,
            count(*)::int AS sailing_count,
            min(etd)::date::text AS first_etd,
            max(etd)::date::text AS last_etd,
            jsonb_agg(jsonb_build_object('vessel', vessel, 'voyage', voyage, 'etd', etd::date::text, 'eta', eta::date::text)
                      ORDER BY etd, id) AS sailings
       FROM market_sailings
      WHERE etd >= $1::date
        AND etd < $2::date
        AND COALESCE(pol_name, '') <> ''
        AND COALESCE(pod_name, '') <> ''
        AND COALESCE(carrier, '') <> ''
      GROUP BY pol_name, pod_name, upper(substring(btrim(COALESCE(carrier, '')) from '^[A-Za-z0-9-]+'))
      ORDER BY min(etd), pol_name, pod_name`,
    [ymd(today), ymd(addDays(today, 21))]
  );
  var routes = new Map();
  rows.forEach(r => {
    var key = routeKey(r.pol, r.pod, r.carrier_code);
    routes.set(key, { pol:text(r.pol), pod:text(r.pod), carrier_code:normCarrier(r.carrier_code), sailing_count:r.sailing_count, first_etd:r.first_etd, last_etd:r.last_etd, sailings:Array.isArray(r.sailings) ? r.sailings : [] });
  });
  if (!routes.size) throw new Error("market_sailings future 21-day routes = 0; cannot seed demo lanes");
  return routes;
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

function buildPlans(rows, routes){
  var plans = [];
  var skipped = [];
  var fixes = [];
  for (const row of rows) {
    if (plans.length >= 18) break;
    var carrier = normCarrier(row.carrier_code);
    var key = routeKey(row.pol, row.pod, carrier);
    var route = routes.get(key);
    if (!carrier) {
      skipped.push({ source_id:row.id, source_etd:row.source_etd, reason:"carrier_code empty" });
      continue;
    }
    if (!route) {
      skipped.push({ source_id:row.id, source_etd:row.source_etd, reason:"no future 21-day market_sailings for pol/pod/carrier" });
      continue;
    }
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
        sanitized_fields:["bl_no", "booking_no", "forwarder_booking_no", "factory"], date_forced:offsets.forced },
    };
    plan.events = scene === "delayed" ? buildEvents(plan, 3 + ((seq - 1) % 3)) : [];
    plans.push(plan);
  }
  if (plans.length !== 18) throw new Error("selected demo rows " + plans.length + " < 18 after route filtering");
  return { plans, skipped, fixes };
}

function printPlan(plan){
  var route = plan.pol + " -> " + plan.pod + " / " + plan.carrier_code;
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
  console.log("mode=" + (dry ? "dry" : "commit") + " demo_set_id=" + DEMO_SET_ID);
  console.log("public.shipping_plans count before=" + before + " after=" + after);
  console.log("scene_counts normal=" + (counts.normal || 0) + " unsent=" + (counts.unsent || 0) + " delayed=" + (counts.delayed || 0));
  console.log("skipped_rows=" + skipped.length);
  skipped.forEach(s => console.log("- skipped source_id=" + s.source_id + " source_etd=" + s.source_etd + " reason=" + s.reason));
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
    var before = await shippingCount(pool), routes = await loadMarketRoutes(pool, today);
    var built = buildPlans(await loadRecentShippingRows(pool), routes);
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
