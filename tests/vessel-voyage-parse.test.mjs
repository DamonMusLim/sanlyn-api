import assert from "node:assert/strict";
import { parseVesselVoyage, isVesselLike, normalizeVessel } from "../api/db/lib/vessel-voyage-parse.js";

const samples = [
  ["SITC GUANGDONG/2612S", "SITC GUANGDONG", "2612S", "high"],
  ["CUL XIAMEN/2619E", "CUL XIAMEN", "2619E", "high"],
  ["SEASPAN YINGKOU/0837N", "SEASPAN YINGKOU", "0837N", "high"],
  ["SITC BATANGAS/2612S", "SITC BATANGAS", "2612S", "high"],
  ["MSC TAMPA V HB624A", "MSC TAMPA V", "HB624A", "high"],
  ["QD-BKI-EMC", null, null, "no_vessel"],
  ["QD-BKI-MSK", null, null, "no_vessel"],
  ["ELBA III -V.HV611A", "ELBA III", "HV611A", "high"],
  ["TIAN CHANG HE 113S", "TIAN CHANG HE", "113S", "high"],
  ["EVER VIVE/0289-020S", "EVER VIVE", "0289-020S", "high"],
  ["TIAN CHANG HE/113S", "TIAN CHANG HE", "113S", "high"],
  ["SYNERGY BUSAN/607S", "SYNERGY BUSAN", "607S", "high"],
  ["TJ-PKW-TSL", null, null, "no_vessel"],
  ["ESL DANA/02545/W", "ESL DANA", "02545/W", "high"],
  ["MSC VIGOUR IIIHU624A", "MSC VIGOUR III", "HU624A", "high"],
  ["CNXMN-MYPKG", null, null, "no_vessel"],
  ["MSC CALIDRIS III / HU603A", "MSC CALIDRIS III", "HU603A", "high"],
  ["GFS GALAXY /02604W", "GFS GALAXY", "02604W", "high"],
  ["FENGXINDA27 076S", "FENGXINDA27", "076S", "high"],
];

for (const [raw, vessel, voyage, confidence] of samples) {
  const parsed = parseVesselVoyage(raw);
  assert.equal(parsed.vessel, vessel, raw);
  assert.equal(parsed.voyage, voyage, raw);
  assert.equal(parsed.confidence, confidence, raw);
}

assert.equal(normalizeVessel("  msc   calidris   iii "), "MSC CALIDRIS III");
assert.equal(isVesselLike("QD-BKI-EMC"), false);
assert.equal(isVesselLike("BENGAL"), false);
assert.equal(isVesselLike("MSC TAMPA V"), true);
assert.equal(parseVesselVoyage("MSC VIGOUR IIIHU624A").reason, "roman_tail_boundary");

const rejects = [
  "",
  "NS5",
  "KCM3",
  "CSS3",
  "BENGAL",
  "CNXMN-MYPKG",
  "XMN-PKW",
  "USD 1000",
  "7+7",
  "MSC VIGOUR III",
  "MSC TAMPA V HB",
  "SITC/2612S",
];

for (const raw of rejects) {
  const parsed = parseVesselVoyage(raw);
  assert.equal(parsed.vessel, null, raw);
  assert.equal(parsed.voyage, null, raw);
  assert.equal(parsed.confidence, "no_vessel", raw);
}

console.log("vessel-voyage-parse: ok");

// ── Claude 回归用例 2026-07-31 ──────────────────────────────────────────
// 病根:isVesselLike 原用 /^[A-Z]+\d{1,3}$/ 收单 token,把 SVC 航线代码当成船名。
// 实测 59 个真实 SVC 里 24 个中招(PA1/CIX2/SH1/BBX2/HKG1…)。
// 另:原先靠写死 4 个 SVC 白名单(BENGAL/CSS3/KCM3/NS5)遮掩,那正是测试用例本身,属过拟合。
const REAL_SVC = ["PA1","CSS1","CIX2","CIX8","KCM4","KC2","FS1","KCS","KCX","CBX2","CME","CMS2",
  "NFS","IFX","EAX","REA","FAS","CGX","CSX","MFX","AIS","DOLPHIN","KCM","ICI","RNI6","CI2","NWX",
  "NPI","CCS","FME2","CI5","IFX2","CIE","SH1","SH3","TIE","CS1","KVS","KCB","BBX2","NS5","KCM3",
  "CSS3","BENGAL","SAMBAR","SEAGULL","TCS","SA1","LL1","LL3","SW2","STW","FOC","ECSX","PAX",
  "CIW2","A3S","HKG1","FEEDER"];
for (const svc of REAL_SVC) {
  assert.equal(parseVesselVoyage(svc).confidence, "no_vessel", `SVC ${svc} 不该被当成船名`);
  assert.equal(isVesselLike(svc), false, `isVesselLike(${svc}) 必须为 false`);
}
// 单 token 真船名仍要通过
assert.equal(isVesselLike("FENGXINDA27"), true);
assert.equal(parseVesselVoyage("FENGXINDA27 076S").vessel, "FENGXINDA27");
console.log(`vessel-voyage-parse: SVC 回归 ${REAL_SVC.length} 条 ok`);
