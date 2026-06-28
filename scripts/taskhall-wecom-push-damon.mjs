/**
 * taskhall-wecom-push-damon.mjs
 * Sanlyn OS · TASK-HALL-DAILY-DIGEST-WECOM-018
 *
 * Sends the daily task hall digest summary to Damon's WeCom personal webhook.
 * ONLY sends to Damon. Never sends to ops group, factory, trucking, customs, or clients.
 *
 * Safety rules:
 *  - MUST run with --dry-run or exits immediately
 *  - webhook URL read from env ONLY — never hardcoded, never logged, never in git
 *  - fail-closed: missing webhook → STOP, no send
 *  - 0 DB writes, 0 schema changes, 0 task creation/closure/escalation
 *  - reads latest.json from output dir — no DB queries
 *  - WeCom push is the ONLY external call; no MiniMax re-call
 *  - push content is advisory only — never final business decision
 *
 * Usage:
 *   # On server (key + webhook in env):
 *   set -a && source /opt/sanlyn-api-test/.env && set +a
 *   node scripts/taskhall-wecom-push-damon.mjs --dry-run
 *   node scripts/taskhall-wecom-push-damon.mjs --dry-run --send  # actually POST to WeCom
 *
 *   # Simulate (no send, no real webhook needed):
 *   node scripts/taskhall-wecom-push-damon.mjs --dry-run --simulate
 *
 * Env vars (both read from server .env, never from git):
 *   WECOM_DAMON_WEBHOOK_URL   — preferred (Damon personal webhook)
 *   WECOM_WEBHOOK_URL         — fallback (existing ops webhook, also Damon's)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const HAS_DRY_RUN   = args.includes("--dry-run");
const HAS_SEND      = args.includes("--send");     // must be explicit to actually POST
const HAS_SIMULATE  = args.includes("--simulate"); // skip real webhook call
const INPUT_DIR_ARG = (args.find((a) => a.startsWith("--input-dir=")) || "").replace("--input-dir=", "");
const VERBOSE       = args.includes("--verbose");

// ─── Safety Guards ────────────────────────────────────────────────────────────

function assertDryRun() {
  if (!HAS_DRY_RUN) {
    console.error(
      "\n❌ BLOCKED: --dry-run flag required.\n" +
      "   To send: node taskhall-wecom-push-damon.mjs --dry-run --send\n" +
      "   To preview only: node taskhall-wecom-push-damon.mjs --dry-run\n"
    );
    process.exit(1);
  }
}

function maskUrl(url) {
  if (!url) return "<NOT_SET>";
  try {
    const u = new URL(url);
    // Show only domain + first 6 chars of path, rest masked
    const pathStart = u.pathname.slice(0, 6);
    return `${u.protocol}//${u.host}/${pathStart}...<masked>`;
  } catch {
    return url.slice(0, 15) + "...<masked>";
  }
}

function assertNoWebhookInOutput(str) {
  const wh = process.env.WECOM_DAMON_WEBHOOK_URL || process.env.WECOM_WEBHOOK_URL || "";
  if (wh.length > 20 && str.includes(wh)) {
    console.error("❌ SECURITY: webhook URL detected in output — aborting.");
    process.exit(1);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_DIR = INPUT_DIR_ARG
  ? path.resolve(INPUT_DIR_ARG)
  : "/opt/sanlyn-reports/taskhall-digest";
const LATEST_JSON  = path.join(INPUT_DIR, "latest.json");
const PUSH_LOG     = path.join(INPUT_DIR, "wecom-push.log");

// ─── Read Digest ──────────────────────────────────────────────────────────────

function readLatestDigest() {
  // Try production path first, then repo docs fallback
  const fallback = path.join(
    ROOT,
    "docs/workstreams/2026-05-task-hall/taskhall-daily-digest-output-v1.json"
  );
  const target = fs.existsSync(LATEST_JSON) ? LATEST_JSON : fallback;
  if (!fs.existsSync(target)) return null;
  try {
    return { data: JSON.parse(fs.readFileSync(target, "utf8")), source: target };
  } catch {
    return null;
  }
}

// ─── Build WeCom Message ──────────────────────────────────────────────────────

function buildWeComMessage(digestJson) {
  const d = digestJson.digest || digestJson; // handle both wrapper and raw formats
  const date      = d.date        || new Date().toISOString().slice(0, 10);
  const summary   = d.summary     || "（无摘要）";
  const tmh       = d.today_must_handle        || [];
  const frc       = d.field_reminder_candidates || [];
  const high      = tmh.filter((t) => t.risk === "HIGH").length;
  const mid       = tmh.filter((t) => t.risk === "MID").length;
  const newCands  = frc.filter((c) => !c.existing_open_task).length;

  // Top priority task
  const topTask = tmh[0];
  const topLine = topTask
    ? `> ⚡ **最优先**: ${topTask.order_no} — ${topTask.next_action}`
    : "> ✅ 无紧急任务";

  // Must-handle list (max 5)
  const taskLines = tmh
    .slice(0, 5)
    .map(
      (t) =>
        `- **${t.risk}** \`${t.order_no}\` ${t.reason.slice(0, 40)}${t.reason.length > 40 ? "…" : ""}`
    )
    .join("\n");

  const content = [
    `## 📋 Sanlyn OS 今日任务摘要 · ${date}`,
    ``,
    `**开放任务**: ${tmh.length} 条 | **HIGH**: ${high} | **MID**: ${mid} | **提醒候选**: ${frc.length}（其中新候选 ${newCands}）`,
    ``,
    `> ${summary.slice(0, 120)}${summary.length > 120 ? "…" : ""}`,
    ``,
    topLine,
    ``,
    `**今日需处理**`,
    taskLines || "- （无）",
    ``,
    `📁 \`${INPUT_DIR}/latest.md\``,
    `🔒 system_only · 0 DB 写入 · 仅 Damon`,
  ].join("\n");

  assertNoWebhookInOutput(content);
  return content;
}

// ─── Send to WeCom ────────────────────────────────────────────────────────────

async function sendToWecom(webhookUrl, content) {
  const payload = JSON.stringify({
    msgtype: "markdown",
    markdown: { content },
  });
  assertNoWebhookInOutput(payload);

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const text = await resp.text();
  return { httpStatus: resp.status, responseText: text };
}

// ─── Log ──────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  assertNoWebhookInOutput(JSON.stringify(entry)); // extra safety
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    fs.mkdirSync(path.dirname(PUSH_LOG), { recursive: true });
    fs.appendFileSync(PUSH_LOG, line);
  } catch (e) {
    console.error("⚠️ Log write failed (non-fatal):", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Sanlyn OS · TaskHall WeCom Push (Damon only) v1.0.0 ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  const runTs = new Date().toISOString();
  console.log(`启动时间: ${runTs}`);
  console.log(`send=${HAS_SEND} | simulate=${HAS_SIMULATE} | verbose=${VERBOSE}\n`);

  // Guard 1: dry-run always required
  assertDryRun();
  console.log("✅ dry-run 模式已确认 — 0 DB 写入 · 仅 Damon WeCom\n");

  // Guard 2: webhook
  const webhookUrl =
    process.env.WECOM_DAMON_WEBHOOK_URL ||
    process.env.WECOM_WEBHOOK_URL ||
    "";
  const webhookPresent = webhookUrl.length > 10;
  const webhookSource  = process.env.WECOM_DAMON_WEBHOOK_URL
    ? "WECOM_DAMON_WEBHOOK_URL"
    : process.env.WECOM_WEBHOOK_URL
    ? "WECOM_WEBHOOK_URL (fallback)"
    : "NOT_SET";

  console.log(`🔗 Webhook: ${webhookPresent ? `PRESENT (${maskUrl(webhookUrl)}) [${webhookSource}]` : "NOT SET"}`);

  if (!webhookPresent && !HAS_SIMULATE) {
    console.error(
      "\n⛔ WEBHOOK NOT SET AND --simulate NOT PASSED.\n" +
      "   Set WECOM_DAMON_WEBHOOK_URL in /opt/sanlyn-api-test/.env\n" +
      "   or pass --simulate to preview without sending.\n"
    );
    appendLog({ status: "BLOCKED", reason: "webhook_not_set" });
    process.exit(1);
  }

  // Read digest
  console.log(`📄 Reading latest digest from: ${LATEST_JSON}`);
  const digestResult = readLatestDigest();
  if (!digestResult) {
    console.error("❌ No latest.json found. Run taskhall-daily-digest.mjs first.");
    appendLog({ status: "BLOCKED", reason: "no_latest_json", path: LATEST_JSON });
    process.exit(1);
  }
  console.log(`   ✅ Loaded: ${digestResult.source}`);

  const d = digestResult.data.digest || digestResult.data;
  const tmh = d.today_must_handle || [];
  const frc = d.field_reminder_candidates || [];
  console.log(`   Tasks: ${tmh.length} | Candidates: ${frc.length} | Date: ${d.date}`);

  // Safety: verify no_write_confirmed
  if (d.no_write_confirmed !== true || d.no_external_push !== true) {
    console.error("❌ Digest has no_write_confirmed!=true or no_external_push!=true — refusing to push.");
    process.exit(1);
  }

  // Build message
  console.log("\n📝 Building WeCom markdown message...");
  const messageContent = buildWeComMessage(digestResult.data);
  if (VERBOSE) {
    console.log("--- message preview ---");
    console.log(messageContent);
    console.log("--- end preview ---");
  } else {
    console.log(`   Length: ${messageContent.length} chars`);
  }

  // Send (or simulate)
  let pushResult;
  if (HAS_SIMULATE) {
    console.log("\n🎭 [SIMULATE] 跳过真实 WeCom 发送");
    pushResult = { status: "SIMULATED", httpStatus: null };
  } else if (!HAS_SEND) {
    console.log("\n📋 [PREVIEW ONLY] 未传 --send，不实际发送");
    console.log("   Message preview (first 300 chars):");
    console.log("   " + messageContent.slice(0, 300).replace(/\n/g, "\n   "));
    pushResult = { status: "PREVIEW_ONLY", httpStatus: null };
  } else {
    console.log("\n📤 发送到 Damon WeCom...");
    try {
      const result = await sendToWecom(webhookUrl, messageContent);
      console.log(`   HTTP ${result.httpStatus}`);
      if (VERBOSE) console.log("   Response:", result.responseText.slice(0, 200));
      const respObj = JSON.parse(result.responseText || "{}");
      if (result.httpStatus === 200 && respObj.errcode === 0) {
        console.log("   ✅ WeCom 推送成功");
        pushResult = { status: "SENT", httpStatus: result.httpStatus, errcode: respObj.errcode };
      } else {
        console.error(`   ❌ WeCom 响应错误: ${result.responseText.slice(0, 200)}`);
        pushResult = { status: "SEND_FAILED", httpStatus: result.httpStatus, response: result.responseText.slice(0, 200) };
      }
    } catch (e) {
      console.error(`   ❌ 发送失败: ${e.message}`);
      pushResult = { status: "SEND_ERROR", error: String(e) };
    }
  }

  // Security check on all output
  assertNoWebhookInOutput(JSON.stringify(pushResult));

  // Log result
  appendLog({
    status: pushResult.status,
    date: d.date,
    tasks: tmh.length,
    candidates: frc.length,
    webhook_present: webhookPresent,
    webhook_source: webhookSource,
    no_write_confirmed: d.no_write_confirmed,
    no_external_push: d.no_external_push,
    http_status: pushResult.httpStatus || null,
  });

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("📊 WeCom Push 完成");
  console.log("═".repeat(60));
  console.log(`状态: ${pushResult.status}`);
  console.log(`Webhook: ${webhookPresent ? maskUrl(webhookUrl) : "NOT SET"}`);
  console.log(`no_write: ✅ | no_schema: ✅ | target: Damon only`);
  console.log(`Log: ${PUSH_LOG}`);
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
