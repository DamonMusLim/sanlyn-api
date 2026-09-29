// tests/bl-sample-fill.test.js
// 提单样单(bl_sample)：空柜不许带出样板柜号 + 收货人地址来源 回归测试（不连库）。
//
// 背景：模版 bl-sample-template.xlsx 自带 38-LL-23 示例柜号（A19..G19 = CSGU6557381 / OOLLFU4673 / …），
// 旧逻辑只在 containers 非空时覆盖第19行 → 未装柜时样例柜号串进本票（0807 出过柜号串票事故）。
//
//   T1 空柜：输出不含 CSGU6557381 / OOLLFU4673，全表无带边界柜号（blNo=OOLU2335623070 也不算），A19=待装柜占位，含「收货人地址来源」
//   T2 有柜：输出含本票柜号，不含模版样例柜号
//   T3 串柜拦截：柜号出现在 description 但不在 containers → exit 3、不出文件
//   T4 预览页：空柜占位行 + 地址来源小字
//   T5 真实BL号：字母数字混合 BL 号（177HZCZCQ92085V）不算柜号 → exit 0、原样输出

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { renderBlSampleHtml } from "../api/db/docs/bl-sample-xlsx.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILL_PY = join(__dirname, "../api/db/docs/fill_bl_sample.py");
const TPL = join(__dirname, "../api/db/docs/templates/bl-sample-template.xlsx");

const CTN_RE = /(?<![A-Z0-9])[A-Z]{4}\d{7}(?![A-Z0-9])/;

// 跑填数脚本：stdin 喂 JSON，收 stdout 的 xlsx / stderr / 退出码
function runFill(payload) {
  return new Promise((resolve) => {
    const ps = spawn("python3", [FILL_PY, TPL]);
    const out = [], err = [];
    ps.stdout.on("data", (b) => out.push(b));
    ps.stderr.on("data", (b) => err.push(b));
    ps.on("error", (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e) }));
    ps.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    ps.stdin.write(JSON.stringify(payload));
    ps.stdin.end();
  });
}

// 用 openpyxl 把 xlsx 全部非空单元格读成字符串数组（经 python3 -c，不引额外 node 依赖）
const PY_DUMP = [
  "import sys, json, io, openpyxl",
  "wb = openpyxl.load_workbook(io.BytesIO(sys.stdin.buffer.read()))",
  "ws = wb.active",
  "out = []",
  "for row in ws.iter_rows():",
  "    for c in row:",
  "        if c.value is not None:",
  "            out.append(str(c.value))",
  "print(json.dumps(out, ensure_ascii=False))",
].join("\n");

function dumpCells(xlsxBuf) {
  return new Promise((resolve, reject) => {
    const ps = spawn("python3", ["-c", PY_DUMP]);
    const out = [], err = [];
    ps.stdout.on("data", (b) => out.push(b));
    ps.stderr.on("data", (b) => err.push(b));
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code !== 0) return reject(new Error("dumpCells: " + Buffer.concat(err).toString().slice(0, 300)));
      try { resolve(JSON.parse(Buffer.concat(out).toString())); }
      catch (e) { reject(e); }
    });
    ps.stdin.write(xlsxBuf);
    ps.stdin.end();
  });
}

function basePayload(extra) {
  return Object.assign({
    shipperName: "OCEANBABY PET PRODUCTS CO., LTD",
    blNo: "OOLU2335623070", releaseType: "SWB 海运单",
    consignee: "PET BEST LLC",
    consAddr: "2350 BOWLING GREEN AVE, LOS ANGELES, CA 90058, USA",
    consAddrSource: "本票订舱登记（shipping_plans.consignee_address）",
    hsCode: "3824999999", showHs: true, confirmed: false,
    vessel: "MSC ANNA", voyage: "012W", pol: "QINGDAO, CHINA", pod: "LONG BEACH, USA",
    marks: "N/M", totalCtn: 1200, description: "CAT LITTER", gwKg: 24700.06, cbm: 34.096,
  }, extra || {});
}

test("T1 空柜：不带模版样例柜号，占位提示 + 地址来源行", async () => {
  const r = await runFill(basePayload({ containers: [] }));
  assert.equal(r.code, 0, "退出码应为 0，stderr=" + r.stderr.slice(0, 300));
  const cells = await dumpCells(r.stdout);
  const text = cells.join("\n");
  assert.ok(!text.includes("CSGU6557381"), "不得出现模版样例柜号 CSGU6557381");
  assert.ok(!text.includes("OOLLFU4673"), "不得出现模版样例订舱号 OOLLFU4673");
  assert.equal(text.match(CTN_RE), null, "全表不得有任何带边界柜号 (?<![A-Z0-9])[A-Z]{4}\\d{7}(?![A-Z0-9])，实际=" + text.match(CTN_RE));
  assert.ok(text.includes("待装柜后由拖车方提供柜号/封号/皮重"), "A19 应为待装柜占位提示");
  assert.ok(text.includes("收货人地址来源"), "应有收货人地址来源行");
});

test("T2 有柜：输出本票柜号，不带模版样例柜号", async () => {
  const r = await runFill(basePayload({
    containers: [{ no: "TEST1234567", seal: "S001", type: "40HQ", vgm: 24500.5, pkgs: 1200, gw: 24100.32, cbm: 67.893 }],
  }));
  assert.equal(r.code, 0, "退出码应为 0，stderr=" + r.stderr.slice(0, 300));
  const text = (await dumpCells(r.stdout)).join("\n");
  assert.ok(text.includes("TEST1234567"), "输出应含本票柜号 TEST1234567");
  assert.ok(!text.includes("CSGU6557381"), "不得出现模版样例柜号 CSGU6557381");
});

test("T3 串柜拦截：柜号不在 containers 里 → exit 3 不出文件", async () => {
  const r = await runFill(basePayload({
    description: "CAT LITTER ABCD7654321 CONTAMINATED",
    containers: [{ no: "TEST1234567", seal: "S001", type: "40HQ", vgm: 24500.5, pkgs: 1200, gw: 24100.32, cbm: 67.893 }],
  }));
  assert.equal(r.code, 3, "疑似柜号混入时应 exit 3");
  assert.ok(r.stderr.includes("ABCD7654321"), "stderr 应点名疑似柜号，实际=" + r.stderr.slice(0, 300));
  assert.equal(r.stdout.length, 0, "拦截时不得输出文件");
});

test("T4 预览页：空柜占位行 + 地址来源小字", () => {
  const html = renderBlSampleHtml(basePayload({ containers: [], consAddrSource: "X" }));
  assert.ok(html.includes("待装柜后由拖车方提供柜号/封号/皮重"), "预览分箱表应有占位行");
  assert.ok(html.includes("来源：X"), "收货人地址下应有来源小字");
  assert.ok(html.includes('colspan="7"'), "占位行应横跨 7 列");
});

test("T5 真实BL号：字母数字混合 BL 号不算柜号，原样输出 exit 0", async () => {
  const r = await runFill(basePayload({ blNo: "177HZCZCQ92085V", containers: [] }));
  assert.equal(r.code, 0, "真实BL号不应触发柜号拦截，退出码应为 0，stderr=" + r.stderr.slice(0, 300));
  const text = (await dumpCells(r.stdout)).join("\n");
  assert.ok(text.includes("177HZCZCQ92085V"), "输出应含本票BL号 177HZCZCQ92085V");
});
