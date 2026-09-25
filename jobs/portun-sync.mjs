#!/usr/bin/env node
// portun-sync.mjs — 从 Portune(4portun) 拉船司实况，写 shipping_plans.portun_*
// 铁律：这三个字段【只有本脚本能写】，人工/其他接口一律不许改。
//  atd = DLPT 事件且 isEsti=N（实际离港）；ata = BDAR 事件且 isEsti=N（实际抵港）
//  isEsti=Y 是预计值，绝不写进 portun_atd/ata（预计值要看 etd/eta，别混）
import fs from "fs";
import pg from "pg";

const ENVP = "/opt/sanlyn-api-test/.env";
const env = {};
for (const l of fs.readFileSync(ENVP, "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const APP = env.PORTUN_APP_ID, SEC = env.PORTUN_SECRET;
const BASE = "https://prod-api.4portun.com/openapi";
if (!SEC) { console.error("❌ 缺 PORTUN_SECRET"); process.exit(1); }

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

async function token() {
  const r = await (await fetch(BASE + "/auth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: APP, secret: SEC })
  })).json();
  return r?.data?.token || r?.token || (typeof r?.data === "string" ? r.data : null);
}

// 从事件流里取【实际发生】的时间；isEsti=Y(预计) 一律忽略
function actual(containers, code) {
  let best = null;
  for (const c of containers || [])
    for (const s of c.status || [])
      if (s.eventCode === code && s.isEsti === "N" && s.eventTime)
        if (!best || s.eventTime > best) best = s.eventTime;
  return best;
}

const main = async () => {
  const { rows } = await pool.query(
    `SELECT id, shipment_no, bl_no, raw->>'portun_subscription_id' AS sid
       FROM shipping_plans
      WHERE raw ? 'portun_subscription_id' AND deleted_at IS NULL
        AND (portun_ata IS NULL)`);          // 已实际到港的不再拉，省调用
  if (!rows.length) { console.log("没有待同步的票"); return; }
  const tok = await token();
  if (!tok) { console.error("❌ 取 token 失败"); process.exit(1); }

  for (const p of rows) {
    try {
      const r = await (await fetch(BASE + "/gateway/api/v2/getOceanTracking", {
        method: "POST",
        headers: { "Content-Type": "application/json", appId: APP, Authorization: "Bearer " + tok },
        body: JSON.stringify({ subscriptionId: p.sid })
      })).json();
      if (r.code !== 200 || !r.data) { console.log(`⚠️ ${p.shipment_no} code=${r.code} ${r.msg || ""}`); continue; }
      const d = r.data, ctns = d.containers || [];
      const atd = actual(ctns, "DLPT"), ata = actual(ctns, "BDAR");
      const statusCn = ctns[0]?.descriptionCn || null;
      // 船司【预计】开船/到港：places type1|2=装货港/起运港，type4|5=卸货港/目的港
      // 船司排的班期比市场船期表准 → 覆盖我们的估值（实际值另存 portun_atd/ata）
      const places = d.places || [];
      const etdEst = places.find(p => (p.type === "1" || p.type === "2") && p.etd)?.etd || null;
      const etaEst = places.find(p => (p.type === "4" || p.type === "5") && p.eta)?.eta || null;
      const vsl = d.firstVessel?.vessel || null, voy = d.firstVessel?.voyage || null;

      // COALESCE 保护：已经有实际值的不被 null 冲掉（船司偶尔漏字段）
      const u = await pool.query(
        `UPDATE shipping_plans SET
           portun_atd       = COALESCE($2::timestamptz, portun_atd),
           portun_ata       = COALESCE($3::timestamptz, portun_ata),
           portun_status_cn = COALESCE($4, portun_status_cn),
           etd              = COALESCE($5::timestamptz, etd),
           eta              = COALESCE($6::timestamptz, eta),
           vessel           = COALESCE($7, vessel),
           voyage           = COALESCE($8, voyage),
           portun_synced_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING shipment_no, portun_atd, portun_ata, portun_status_cn, etd, eta`,
        [p.id, atd, ata, statusCn, etdEst, etaEst, vsl, voy]);
      const o = u.rows[0];
      const f = v => v ? new Date(v).toISOString().slice(0,10) : "-";
      console.log(`✅ ${o.shipment_no}  预计开船=${f(o.etd)} 预计到港=${f(o.eta)}  实际开船=${o.portun_atd?f(o.portun_atd):"未开"} 实际到港=${o.portun_ata?f(o.portun_ata):"未到"}  状态=${o.portun_status_cn||"-"}`);
    } catch (e) { console.log(`❌ ${p.shipment_no}: ${e.message}`); }
  }
};
main().then(() => pool.end());
