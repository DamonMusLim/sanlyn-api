const DEMO_SET_ID = "demoset-0908";
const FACTORIES = ["Demo Atlas Foods", "Demo Harbor Packing", "Demo Northstar Goods"];
const SCENES = {
  normal: "正常在途",
  unsent: "一直不发货",
  delayed: "一直改交期",
};

function arg(name){
  return process.argv.includes(name);
}

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

function text(v){
  return String(v == null ? "" : v).trim();
}

function ymd(date){
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function addDays(date, days){
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function num(v, fallback){
  if (v == null || v === "") return fallback;
  var n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normCarrier(v){
  return text(v).toUpperCase().replace(/\s+/g, "");
}

function box(v){
  var s = text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
  if (s === "20" || s === "20GP") return "20GP";
  if (s === "40" || s === "40GP" || s === "40HQ") return "40HQ";
  return s || "40HQ";
}

function pick(list, idx){
  if (!list.length) throw new Error("empty sample list");
  return list[idx % list.length];
}

async function shippingCount(pool){
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.shipping_plans");
  return rows[0].n;
}

async function loadRoutes(pool, today){
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
     HAVING count(*) >= 2
      ORDER BY count(*) DESC, min(etd), pol_name, pod_name
      LIMIT 8`,
    [ymd(today), ymd(addDays(today, 21))]
  );
  if (rows.length < 3) throw new Error("market_sailings future 21-day routes < 3; cannot seed believable demo lanes");
  return rows.map(r => ({
    pol:text(r.pol),
    pod:text(r.pod),
    carrier_code:normCarrier(r.carrier_code),
    sailing_count:r.sailing_count,
    first_etd:r.first_etd,
    last_etd:r.last_etd,
    sailings:Array.isArray(r.sailings) ? r.sailings : [],
  })).filter(r => r.carrier_code);
}

async function loadSamples(pool){
  const { rows } = await pool.query(
    `SELECT cargo_description, gross_weight_kg, container_type, pod, carrier_code,
            freight_cost, port_surcharge_total, thc_fee, seal_fee, vgm_fee, doc_fee, eir_fee
       FROM public.shipping_plans
      WHERE COALESCE(cargo_description, '') <> ''
        AND gross_weight_kg IS NOT NULL
        AND COALESCE(container_type, '') <> ''
        AND COALESCE(pod, '') <> ''
        AND COALESCE(carrier_code, '') <> ''
      ORDER BY random()
      LIMIT 80`
  );
  if (rows.length < 12) throw new Error("not enough public.shipping_plans samples");
  return rows;
}

async function assertDemoIdsDoNotHitReal(pool, ids){
  const { rows } = await pool.query(
    `SELECT bl_no
       FROM public.shipping_plans
      WHERE bl_no = ANY($1::text[])
         OR booking_no = ANY($1::text[])
         OR forwarder_booking_no = ANY($1::text[])
      LIMIT 1`,
    [ids]
  );
  if (rows.length) throw new Error("DEMO id collides with public.shipping_plans: " + rows[0].bl_no);
}

function sailingFor(route, offset){
  var list = route.sailings.filter(s => text(s.etd));
  var wanted = list.find(s => {
    var d = new Date(text(s.etd) + "T00:00:00");
    if (!Number.isFinite(d.getTime())) return false;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000) >= offset;
  });
  return wanted || list[0] || {};
}

function scenario(factoryIdx, planIdx){
  var order = [
    "normal", "normal", "delayed", "unsent", "normal", "delayed", "unsent",
    "normal", "normal", "unsent", "delayed", "normal", "unsent", "normal",
    "delayed", "normal", "unsent", "normal",
  ];
  return order[(factoryIdx * 6 + planIdx) % order.length];
}

function buildEvents(plan, count){
  var events = [];
  var current = plan.delivery_offset_days - count * 2;
  for (var i = 1; i <= count; i++) {
    var next = i === count ? plan.delivery_offset_days : current + 2;
    events.push({
      seq:i,
      old_value:"offset:" + current,
      new_value:"offset:" + next,
      reason:["原料到厂延迟", "排产顺延", "验货后补箱", "客户确认延迟", "等柜期"][i - 1],
      actor:i % 2 ? "Demo Factory" : "Demo Planner",
      raw:{ old_offset_days:current, new_offset_days:next },
    });
    current = next;
  }
  return events;
}

function buildPlans(routes, samples, today){
  var plans = [];
  var seq = 1;
  FACTORIES.forEach(function(factory, factoryIdx){
    var count = [5, 6, 7][factoryIdx];
    for (var i = 0; i < count; i++) {
      var scene = scenario(factoryIdx, i);
      var route = pick(routes, factoryIdx * 3 + i);
      var sample = pick(samples, seq * 5 + factoryIdx);
      var etdOffset = scene === "unsent" ? null : (seq * 3 + factoryIdx) % 21;
      var deliveryOffset = scene === "delayed" ? ((seq % 9) + 2) : Math.max(0, (etdOffset == null ? (seq % 18) : etdOffset - 4));
      var etaOffset = etdOffset == null ? null : etdOffset + 8 + (seq % 5);
      var sailing = etdOffset == null ? {} : sailingFor(route, etdOffset);
      var id = "DEMO-" + String(seq).padStart(3, "0");
      plans.push({
        demo_plan_id:id,
        factory:factory,
        lane_seq:(factoryIdx % 3) + 1,
        plan_seq:seq,
        scene:scene,
        pol:route.pol,
        pod:route.pod,
        carrier_code:route.carrier_code,
        vessel:text(sailing.vessel) || null,
        voyage:text(sailing.voyage) || null,
        etd_offset_days:etdOffset,
        delivery_offset_days:deliveryOffset,
        eta_offset_days:etaOffset,
        container_qty:1,
        container_type:box(sample.container_type),
        gross_weight_kg:Math.round(num(sample.gross_weight_kg, 18500)),
        cargo_description:text(sample.cargo_description).slice(0, 90),
        booking_no:id + "-BKG",
        forwarder_booking_no:id + "-FWD",
        booking_stage:etdOffset == null ? "pending" : "booked",
        shipping_status:etdOffset == null ? "pending" : "booked",
        current_status_cn:etdOffset == null ? "货好未发 / 待订舱" : "已订舱",
        freight_cost:num(sample.freight_cost, null),
        port_surcharge_total:num(sample.port_surcharge_total, null),
        thc_fee:num(sample.thc_fee, 0),
        seal_fee:num(sample.seal_fee, 0),
        vgm_fee:num(sample.vgm_fee, 0),
        doc_fee:num(sample.doc_fee, 0),
        eir_fee:num(sample.eir_fee, 0),
        raw:{
          source:"seed-demo-portal",
          factory:factory,
          scene:scene,
          sampled_from_public:true,
          route_confirmed_by:"market_sailings",
          dry_run_today:ymd(today),
        },
      });
      seq += 1;
    }
  });
  plans.forEach(function(plan, idx){
    plan.events = plan.scene === "delayed" ? buildEvents(plan, 3 + (idx % 3)) : [];
  });
  return plans;
}

function printPlan(plan){
  var route = plan.pol + " -> " + plan.pod + " / " + plan.carrier_code;
  console.log([
    plan.demo_plan_id,
    plan.factory,
    SCENES[plan.scene],
    route,
    plan.container_type,
    plan.gross_weight_kg + "kg",
    plan.cargo_description,
    "delivery_offset=" + plan.delivery_offset_days,
    "etd_offset=" + (plan.etd_offset_days == null ? "NULL" : plan.etd_offset_days),
    "eta_offset=" + (plan.eta_offset_days == null ? "NULL" : plan.eta_offset_days),
    plan.vessel ? ("vessel=" + plan.vessel + " " + (plan.voyage || "")) : "vessel=NULL",
  ].join(" | "));
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
        ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,NULL,NULL,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb)
       RETURNING id`,
      [DEMO_SET_ID, plan.demo_plan_id, plan.lane_seq, plan.plan_seq, plan.pol, plan.pod,
        plan.carrier_code, plan.vessel, plan.voyage, plan.etd_offset_days,
        plan.delivery_offset_days, plan.eta_offset_days, plan.container_qty, plan.container_type,
        plan.gross_weight_kg, plan.cargo_description, plan.booking_no, plan.forwarder_booking_no,
        plan.booking_stage, plan.shipping_status, plan.current_status_cn, plan.freight_cost,
        plan.port_surcharge_total, plan.thc_fee, plan.seal_fee, plan.vgm_fee, plan.doc_fee,
        plan.eir_fee, JSON.stringify(plan.raw)]
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

function printSummary(routes, plans, before, after, dry){
  var counts = plans.reduce((m, p) => { m[p.scene] = (m[p.scene] || 0) + 1; return m; }, {});
  console.log("mode=" + (dry ? "dry" : "commit") + " demo_set_id=" + DEMO_SET_ID);
  console.log("public.shipping_plans count before=" + before + " after=" + after);
  console.log("scene_counts normal=" + (counts.normal || 0) + " unsent=" + (counts.unsent || 0) + " delayed=" + (counts.delayed || 0));
  console.log("routes_confirmed_by_market_sailings_future_21d:");
  routes.forEach(r => console.log("- " + r.pol + " -> " + r.pod + " / " + r.carrier_code + " sailings=" + r.sailing_count + " first=" + r.first_etd + " last=" + r.last_etd));
  console.log("plans:");
  plans.forEach(printPlan);
  console.log("write_scope=" + (dry ? "none(dry-run)" : "demo.forwarder_shipping_plans,demo.forwarder_delivery_change_events"));
}

async function main(){
  var commit = arg("--commit");
  var dry = !commit;
  var pool = await getPool();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    var before = await shippingCount(pool);
    var routes = await loadRoutes(pool, today);
    var samples = await loadSamples(pool);
    var plans = buildPlans(routes, samples, today);
    await assertDemoIdsDoNotHitReal(pool, plans.flatMap(p => [p.demo_plan_id, p.booking_no, p.forwarder_booking_no]));
    if (commit) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (arg("--purge")) await purge(client);
        await insertPlans(client, plans);
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
    printSummary(routes, plans, before, after, dry);
  } finally {
    await pool.end();
  }
}

main().catch(function(e){
  console.error("ERROR " + (e && e.message ? e.message : e));
  process.exit(1);
});
