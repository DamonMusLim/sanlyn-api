/**
 * task-escalation-cron.mjs
 * 闭环任务 P0/P1 自动追 SLA。默认 DRY_RUN；只有 ESCALATION_LIVE=1 才真写库和推送。
 *
 * 线上建议：
 *   cd /opt/sanlyn-api-test && set -a && source .env && set +a && node scripts/task-escalation-cron.mjs
 */

import { appendFile, readFile } from "node:fs/promises";

if (process.env.ESCALATION_SELFTEST !== "owner-review-stage") {
  await import("dotenv/config");
}

const LIVE = process.env.ESCALATION_LIVE === "1";
const LIMIT = Number(process.env.ESCALATION_MAX_PUSHES || 5);
const STAGED = process.env.ESCALATION_STAGED !== "0";
const NOTIFY_URL = process.env.NOTIFY_URL || "http://127.0.0.1:3791/push-card";
const PUBLIC_TASK_URL = process.env.PUBLIC_TASK_URL || "https://ai.sanlyn.cn/task.html?task=";
const UNCLAIMED_FILE = process.env.ESCALATION_UNCLAIMED_FILE || "/root/escalation_unclaimed.jsonl";
const SELF_HEAL_MARKERS = new Set(["claude", "ai", "ai-00", "agent"]);
const DOMAIN_LABEL = new Map(Object.entries({ petshop: "宠物店", infra: "系统基建", ai: "AI" }));
const MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};
let activeStaffByNoPromise = null;
const unclaimedTaskDayKeys = new Set();
const unclaimedLoadedDays = new Set();

async function getPoolInstance() {
  const mod = await import("../api/db.js");
  return mod.getPool();
}

function asDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function escalationSince() {
  const raw = String(process.env.ESCALATION_SINCE || "").trim();
  if (!raw) return { raw: "none", date: null };

  const date = asDate(raw);
  if (!date) {
    console.error(`[WARN] ESCALATION_SINCE parse failed: ${raw}`);
    return { raw, date: null };
  }
  return { raw, date };
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function rawObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function rawExtraObject(raw) {
  const obj = rawObject(raw);
  return rawObject(obj.raw_extra);
}

function rawText(task, key) {
  const raw = rawObject(task.raw);
  return firstNonEmpty(raw[key], rawExtraObject(task.raw)[key]);
}

function isSnoozed(task, now) {
  const raw = rawObject(task.raw);
  const until = asDate(raw.snooze_until);
  return until && until > now;
}

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

function normalizedPriority(priority) {
  const value = String(priority || "").trim().toUpperCase();
  return value || null;
}

function priorityLabel(priority) {
  return normalizedPriority(priority) || "EMPTY";
}

function nextStage(task, now) {
  if (isSnoozed(task, now)) return null;

  const stage = Number(task.notify_stage || 0);
  const priority = normalizedPriority(task.priority);
  const createdAt = asDate(task.created_at);
  const lastNotifiedAt = asDate(task.last_notified_at);
  const nextNotifyAt = asDate(task.next_notify_at);
  const acknowledged = Boolean(task.acknowledged_at);
  const resolved = Boolean(task.resolved_at);
  const dueByNextNotify = nextNotifyAt && nextNotifyAt <= now;

  if (!priority && dueByNextNotify) {
    return { stage: stage + 1, reason: "显式定时提醒到点", nextAt: null };
  }

  if (!createdAt) return null;

  if (priority === "P0") {
    if (stage === 0 && !acknowledged && addMs(createdAt, 30 * MS.minute) <= now) {
      return { stage: 1, reason: "P0 创建30分钟未确认", nextAt: addMs(now, 2 * MS.hour) };
    }
    if (stage === 1 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, 2 * MS.hour) <= now)) {
      return { stage: 2, reason: "P0 stage1后2小时未解决", nextAt: addMs(now, MS.day) };
    }
    if (stage === 2 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, MS.day) <= now)) {
      return { stage: 3, reason: "P0 stage2后24小时未解决", nextAt: addMs(now, MS.day), daily: true };
    }
    if (stage >= 3 && !resolved && addMs(lastNotifiedAt || createdAt, MS.day) <= now) {
      return { stage: 3, reason: "P0 stage3每日追踪", nextAt: addMs(now, MS.day), daily: true };
    }
  }

  if (priority === "P1") {
    if (stage === 0 && !acknowledged && addMs(createdAt, MS.day) <= now) {
      return { stage: 1, reason: "P1 创建24小时未确认", nextAt: addMs(now, 2 * MS.day) };
    }
    if (stage === 1 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, 3 * MS.day) <= now)) {
      return { stage: 2, reason: "P1 72小时未解决", nextAt: null };
    }
  }

  return null;
}

function isOwnerReviewTask(task) {
  return rawText(task, "escalate_to") === "D-00" && Boolean(rawText(task, "owner_staff_no"));
}

function ownerReviewStage(task, now) {
  if (!isOwnerReviewTask(task)) return null;
  if (isSnoozed(task, now)) return { hold: true, reason: "任务已暂缓" };
  if (task.resolved_at) return null;

  const dueAt = asDate(task.due_at);
  const createdAt = asDate(task.created_at);
  const baseAt = dueAt || (createdAt ? addMs(createdAt, MS.day) : null);
  if (!baseAt) return null;

  const pushAt = dueAt ? addMs(dueAt, 12 * MS.hour) : addMs(createdAt, 36 * MS.hour);
  if (pushAt > now) return { hold: true, reason: `负责人/复核人处理期未满，到点=${pushAt.toISOString()}` };

  const lastNotifiedAt = asDate(task.last_notified_at);
  if (lastNotifiedAt && todayKey(lastNotifiedAt) === todayKey(now)) {
    return { hold: true, reason: "今日已推 Damon" };
  }

  return {
    stage: 3,
    reason: dueAt ? "负责人审核工单到期12小时未解决" : "负责人审核工单创建36小时未解决",
    nextAt: addMs(now, MS.day),
    daily: true,
    ownerReview: true,
  };
}

function idempotencyKey(taskId, stageInfo, now) {
  // stage3 是每日一推，幂等粒度必须带日期；否则唯一键会挡住第二天提醒。
  if (stageInfo.daily) return `${taskId}:stage${stageInfo.stage}:${todayKey(now)}`;
  return `${taskId}:stage${stageInfo.stage}`;
}

function nonEmptyText(value, fallback, maxLen) {
  const text = String(value ?? "").trim() || String(fallback ?? "").trim();
  const safe = text || "闭环任务提醒";
  return maxLen ? safe.slice(0, maxLen) : safe;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function firstLink(task) {
  const raw = rawObject(task.raw);
  const extra = rawExtraObject(task.raw);
  const links = Array.isArray(raw.links) ? raw.links : Array.isArray(extra.links) ? extra.links : [];
  const first = links[0];
  if (typeof first === "string") return first.trim();
  if (first && typeof first === "object") return firstNonEmpty(first.url, first.href, first.link);
  return "";
}

function normalizeStaffNo(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "damon" || v === "d-00" ? "d-00" : v;
}

async function loadActiveStaffByNo(pool) {
  if (!activeStaffByNoPromise) {
    activeStaffByNoPromise = pool.query(
      `SELECT staff_no, name_cn, escalates_to, status
        FROM ai_staff
        WHERE status = 'active'`
    ).then((res) => {
      const staffByNo = new Map();
      for (const row of res.rows) {
        const staffNo = String(row.staff_no || "").trim();
        if (staffNo) staffByNo.set(staffNo.toLowerCase(), row);
      }
      return staffByNo;
    }).catch((err) => {
      console.error(`[WARN] ai_staff load failed; skip owner-based pushes: ${err.message || err}`);
      return new Map();
    });
  }
  return activeStaffByNoPromise;
}

// 微信 time 类字段(time7)只吃日期,不吃完整 ISO,也不能塞文本兜底。
// 依据:同仓 push.mjs 的 sendPendingCard 传的是 YYYY-MM-DD。
function wechatDate(value) {
  const d = asDate(value);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function deadlineFor(task, stageInfo) {
  return firstNonEmpty(
    wechatDate(task.due_at),
    wechatDate(task.next_notify_at),
    wechatDate(stageInfo && stageInfo.nextAt),
    wechatDate(task.created_at),
    wechatDate(new Date())
  );
}

function staffName(no, staff) { return no === "d-00" ? "Damon" : String(staff?.name_cn || "").trim(); }

function chainLabel(no, staff) { const name = staffName(no, staff); return name ? `${no.toUpperCase()}(${name})` : no.toUpperCase(); }
function resolveChain(assignedToValue, activeStaffByNo) {
  const assignedTo = String(assignedToValue || "").trim();
  if (!assignedTo) return { owner: null, reviewer: null, skipReason: "no-owner", assignedTo: "(空)", chain: "" };

  const ownerNo = normalizeStaffNo(assignedTo);
  const ownerStaff = activeStaffByNo.get(ownerNo);
  if (!ownerStaff) return { owner: null, reviewer: null, skipReason: "bad-owner", assignedTo, chain: "" };

  const ownerName = staffName(ownerNo, ownerStaff);
  if (!ownerName) return { owner: null, reviewer: null, skipReason: "bad-owner", assignedTo, chain: "" };
  const owner = { no: ownerNo.toUpperCase(), name: ownerName };
  const chain = [chainLabel(ownerNo, ownerStaff)];
  let nextNo = normalizeStaffNo(ownerStaff.escalates_to);
  // 🔴 审核链只认真实员工；claude/ai 是自愈层，Damon 是第四档，不能算审核人。
  if (nextNo) {
    if (nextNo === ownerNo) {
      console.warn(`[chain-cycle] assigned_to=${assignedTo} repeated=${nextNo} chain=${chain.join(" → ")}`);
      return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
    }
    if (SELF_HEAL_MARKERS.has(nextNo)) {
      chain.push(chainLabel(nextNo, null));
      return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
    }
    if (nextNo === "d-00") {
      chain.push("D-00(Damon)");
      return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
    }
    const staff = activeStaffByNo.get(nextNo);
    if (!staff) {
      chain.push(chainLabel(nextNo, null));
      return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
    }
    const name = staffName(nextNo, staff);
    if (!name) {
      chain.push(chainLabel(nextNo, staff));
      return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
    }
    chain.push(chainLabel(nextNo, staff));
    const reviewer = { no: nextNo.toUpperCase(), name };
    const reviewerNextNo = normalizeStaffNo(staff.escalates_to);
    if (reviewerNextNo === "d-00") chain.push("D-00(Damon)");
    return { owner, reviewer, skipReason: "", assignedTo, chain: chain.join(" → ") };
  }
  return { owner, reviewer: null, skipReason: "", assignedTo, chain: chain.join(" → ") };
}

function companyOrDomainPrefix(task) {
  const company = firstNonEmpty(task.company_code, task.company_id);
  if (company) return company;

  const domain = String(task.domain || "").trim();
  if (!domain || domain === "general") return "";
  return DOMAIN_LABEL.get(domain) || domain;
}

function payloadFor(task, stageInfo, chainInfo) {
  const prefix = companyOrDomainPrefix(task);
  const baseTitle = prefix ? `${prefix} ${task.title}` : task.title;
  const title = stageInfo.stage >= 2 ? `【加急】${baseTitle}` : baseTitle;
  const payload = {
    to: "damon",
    title: nonEmptyText(title, "闭环任务提醒"),
    applicant: chainInfo.owner?.name || "",
    urgency: normalizedPriority(task.priority) === "P0" ? "紧急" : "普通",
    deadline: deadlineFor(task, stageInfo),
    count: "1",
    url: firstNonEmpty(firstLink(task), `${PUBLIC_TASK_URL}${encodeURIComponent(task.id)}`),
  };
  const recommendedAction = rawText(task, "recommended_action");
  if (recommendedAction) payload.recommended_action = recommendedAction;
  if (STAGED) {
    Object.assign(payload, { owner_no: chainInfo.owner?.no || "", owner_name: chainInfo.owner?.name || "", reviewer_no: chainInfo.reviewer?.no || "", reviewer_name: chainInfo.reviewer?.name || "", chain: chainInfo.chain || "" });
  }
  return payload;
}

async function fetchCandidates(pool, now) {
  const watermark = escalationSince();
  const params = [now.toISOString()];
  const watermarkClause = watermark.date ? `AND created_at >= $2::timestamptz` : "";
  if (watermark.date) params.push(watermark.date.toISOString());

  const { rows } = await pool.query(
    `SELECT id, title, status, priority, source, dedupe_key, related_order_no,
            company_code, company_id, domain,
            assigned_to, acknowledged_at, resolved_at, notify_stage,
            next_notify_at, last_notified_at, raw, due_at, created_at
      FROM tasks
      WHERE status IN ('open', 'doing')
        AND (
          upper(nullif(trim(priority), '')) IN ('P0', 'P1')
          OR (nullif(trim(priority), '') IS NULL AND next_notify_at <= $1::timestamptz)
        )
        ${watermarkClause}
      ORDER BY
        CASE upper(nullif(trim(priority), '')) WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
        COALESCE(next_notify_at, created_at) ASC`,
    params
  );

  let skippedBeforeWatermark = 0;
  if (watermark.date) {
    const countRes = await pool.query(
      `SELECT count(*)::int AS count
        FROM tasks
        WHERE status IN ('open', 'doing')
          AND (
            upper(nullif(trim(priority), '')) IN ('P0', 'P1')
            OR (nullif(trim(priority), '') IS NULL AND next_notify_at <= $1::timestamptz)
          )
          AND created_at < $2::timestamptz`,
      params
    );
    skippedBeforeWatermark = countRes.rows[0]?.count || 0;
  }

  const watermarkLabel =
    !watermark.date && watermark.raw !== "none" ? `${watermark.raw}(解析失败,已忽略)` : watermark.raw;
  return { rows, skippedBeforeWatermark, watermark: watermarkLabel };
}

// 审核 review(Claude 0927):负责人审核工单不吃 ESCALATION_SINCE 3天水位——否则超过3天没人管的工单就永远静默了。
// 改用固定起点 = 这套机制上线日(0927),既不会把历史旧单一次性倒出来(0905 事故),也保证「最后才是 Damon」每天追到解决为止。
const OWNER_REVIEW_SINCE = new Date("2026-09-27T00:00:00+08:00");
async function fetchOwnerReviewCandidates(pool, now) {
  const watermark = { date: OWNER_REVIEW_SINCE };
  const params = [now.toISOString()];
  const watermarkClause = watermark.date ? `AND created_at >= $2::timestamptz` : "";
  if (watermark.date) params.push(watermark.date.toISOString());

  const { rows } = await pool.query(
    `SELECT id, title, status, priority, source, dedupe_key, related_order_no,
            company_code, company_id, domain,
            assigned_to, acknowledged_at, resolved_at, notify_stage,
            next_notify_at, last_notified_at, raw, due_at, created_at
      FROM tasks
      WHERE status IN ('open', 'doing')
        AND COALESCE(raw->>'escalate_to', raw->'raw_extra'->>'escalate_to') = 'D-00'
        AND NULLIF(trim(COALESCE(raw->>'owner_staff_no', raw->'raw_extra'->>'owner_staff_no')), '') IS NOT NULL
        ${watermarkClause}
      ORDER BY COALESCE(due_at, created_at) ASC`,
    params
  );

  let skippedBeforeWatermark = 0;
  if (watermark.date) {
    const countRes = await pool.query(
      `SELECT count(*)::int AS count
        FROM tasks
        WHERE status IN ('open', 'doing')
          AND COALESCE(raw->>'escalate_to', raw->'raw_extra'->>'escalate_to') = 'D-00'
          AND NULLIF(trim(COALESCE(raw->>'owner_staff_no', raw->'raw_extra'->>'owner_staff_no')), '') IS NOT NULL
          AND created_at < $2::timestamptz`,
      params
    );
    skippedBeforeWatermark = countRes.rows[0]?.count || 0;
  }

  return { rows, skippedBeforeWatermark };
}

async function reserveAttempt(client, key, task, stageInfo) {
  const res = await client.query(
    `INSERT INTO task_push_attempts
       (task_id, idempotency_key, stage, channel, status)
     VALUES ($1, $2, $3, 'wechat', 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [task.id, key, stageInfo.stage]
  );
  return res.rows[0]?.id || null;
}

async function markFailed(client, attemptId, key, err) {
  const msg = String(err?.message || err).slice(0, 1000);
  // 失败要留记录，也要释放原 stage key 给下轮重试。
  await client.query(
    `UPDATE task_push_attempts
        SET status = 'failed',
            error = $1,
            idempotency_key = $2 || ':failed:' || id
      WHERE id = $3`,
    [msg, key, attemptId]
  );
}

async function markSentAndAdvance(client, attemptId, task, stageInfo, status = "sent") {
  await client.query(
    `UPDATE task_push_attempts
        SET status = $2, error = NULL
      WHERE id = $1`,
    [attemptId, status]
  );
  await client.query(
    `UPDATE tasks
        SET notify_stage = $2,
            last_notified_at = NOW(),
            next_notify_at = $3::timestamptz
      WHERE id = $1`,
    [task.id, stageInfo.stage, stageInfo.nextAt ? stageInfo.nextAt.toISOString() : null]
  );
}

async function pushNotify(task, stageInfo, chainInfo) {
  const token = process.env.NOTIFY_TOKEN || "";
  if (!token) throw new Error("NOTIFY_TOKEN missing");

  const resp = await fetch(NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-notify-token": token,
    },
    body: JSON.stringify(payloadFor(task, stageInfo, chainInfo)),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`notify ${resp.status}: ${text.slice(0, 500)}`);
}

function shouldPushDamon(stageInfo, chainInfo) {
  return !STAGED || stageInfo.stage >= 3 || (stageInfo.stage === 2 && !chainInfo.reviewer);
}

function ownerReviewChainInfo(task, activeStaffByNo) {
  const ownerNo = normalizeStaffNo(rawText(task, "owner_staff_no") || task.assigned_to);
  const reviewerNo = normalizeStaffNo(rawText(task, "reviewer_staff_no"));
  const ownerStaff = activeStaffByNo.get(ownerNo);
  const reviewerStaff = reviewerNo ? activeStaffByNo.get(reviewerNo) : null;
  const owner = { no: ownerNo.toUpperCase(), name: staffName(ownerNo, ownerStaff) || ownerNo.toUpperCase() };
  const reviewer = reviewerNo ? { no: reviewerNo.toUpperCase(), name: staffName(reviewerNo, reviewerStaff) || reviewerNo.toUpperCase() } : null;
  const fallbackChain = `${owner.no}先审→${reviewer ? `${reviewer.no}复核→` : ""}Damon`;
  return { owner, reviewer, skipReason: "", assignedTo: task.assigned_to || owner.no, chain: firstNonEmpty(rawText(task, "chain"), fallbackChain) };
}

function unclaimedFileFor(now) {
  return `${UNCLAIMED_FILE}.${todayKey(now)}`;
}

async function loadUnclaimedSeenForDay(now) {
  const day = todayKey(now);
  if (unclaimedLoadedDays.has(day)) return;
  unclaimedLoadedDays.add(day);
  const file = unclaimedFileFor(now);
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) return;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.task_id) unclaimedTaskDayKeys.add(`${row.task_id}:${day}`);
    } catch {
      // 损坏行不能影响主流程；后续继续按已读到的有效行去重。
    }
  }
}

async function writeUnclaimed(task, stageInfo, reason, assignedTo, now) {
  await loadUnclaimedSeenForDay(now);
  const day = todayKey(now);
  const key = `${task.id}:${day}`;
  if (unclaimedTaskDayKeys.has(key)) return;
  unclaimedTaskDayKeys.add(key);
  const row = { ts: new Date().toISOString(), task_id: task.id, title: task.title, assigned_to: assignedTo, priority: task.priority, stage: stageInfo.stage, reason };
  await appendFile(unclaimedFileFor(now), `${JSON.stringify(row)}\n`).catch(() => {}); // 🩸 留证据失败不能影响主流程。
}

async function processOne(pool, task, stageInfo, now, chainInfo) {
  const key = idempotencyKey(task.id, stageInfo, now);
  if (chainInfo.skipReason === "no-owner") {
    if (LIVE && STAGED) await writeUnclaimed(task, stageInfo, chainInfo.skipReason, chainInfo.assignedTo, now);
    console.log(`[skip-no-owner] task=${task.id} assigned_to=${chainInfo.assignedTo} title=${task.title}`);
    return { pushed: false, skipped: false, skippedNoOwner: true, skippedBadOwner: false };
  }
  if (chainInfo.skipReason === "bad-owner") {
    if (LIVE && STAGED) await writeUnclaimed(task, stageInfo, chainInfo.skipReason, chainInfo.assignedTo, now);
    console.log(`[skip-bad-owner] task=${task.id} assigned_to=${chainInfo.assignedTo} title=${task.title}`);
    return { pushed: false, skipped: false, skippedNoOwner: false, skippedBadOwner: true };
  }
  const pushDamon = shouldPushDamon(stageInfo, chainInfo);
  if (!LIVE) {
    console.log(`[DRY] task=${task.id} priority=${priorityLabel(task.priority)} source=${task.source || ""} stage=${stageInfo.stage} key=${key} reason=${stageInfo.reason} action=${pushDamon ? "push-damon" : "hold"} payload=${JSON.stringify(payloadFor(task, stageInfo, chainInfo))}`);
    return { pushed: false, skipped: false, skippedNoOwner: false, skippedBadOwner: false };
  }

  const client = await pool.connect();
  let attemptId = null;
  try {
    await client.query("BEGIN");
    attemptId = await reserveAttempt(client, key, task, stageInfo);
    if (!attemptId) {
      await client.query("COMMIT");
      return { pushed: false, skipped: true, skippedNoOwner: false, skippedBadOwner: false };
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!pushDamon) {
    const c = await pool.connect();
    try {
      await markSentAndAdvance(c, attemptId, task, stageInfo, "held");
    } finally {
      c.release();
    }
    const tag = stageInfo.stage <= 1 ? "stage1-owner" : "stage2-reviewer";
    const holder = stageInfo.stage <= 1 ? `owner=${chainInfo.owner.no}` : `reviewer=${chainInfo.reviewer.no}`;
    console.log(`[${tag}] held task=${task.id} ${holder} stage=${stageInfo.stage} key=${key} reason=${stageInfo.reason} chain=${chainInfo.chain}`);
    return { pushed: false, skipped: false, skippedNoOwner: false, skippedBadOwner: false };
  }

  try {
    await pushNotify(task, stageInfo, chainInfo);
  } catch (err) {
    const c = await pool.connect();
    try {
      await markFailed(c, attemptId, key, err);
    } finally {
      c.release();
    }
    throw err;
  }

  const c = await pool.connect();
  try {
    await markSentAndAdvance(c, attemptId, task, stageInfo);
  } finally {
    c.release();
  }
  console.log(`[LIVE] pushed task=${task.id} priority=${priorityLabel(task.priority)} stage=${stageInfo.stage} key=${key} reason=${stageInfo.reason} chain=${chainInfo.chain}`);
  return { pushed: true, skipped: false, skippedNoOwner: false, skippedBadOwner: false };
}

function logOwnerReviewHold(task, decision, now, activeStaffByNo) {
  const stageInfo = { stage: 3, reason: decision.reason, nextAt: null, daily: true, ownerReview: true };
  const chainInfo = ownerReviewChainInfo(task, activeStaffByNo);
  const key = idempotencyKey(task.id, stageInfo, now);
  if (!LIVE) {
    console.log(`[DRY] task=${task.id} priority=${priorityLabel(task.priority)} source=${task.source || ""} stage=hold key=${key} reason=${decision.reason} action=hold payload=${JSON.stringify(payloadFor(task, stageInfo, chainInfo))}`);
    return;
  }
  console.log(`[owner-review-hold] task=${task.id} key=${key} reason=${decision.reason} chain=${chainInfo.chain}`);
}

function runOwnerReviewStageSelfTest() {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const baseTask = {
    id: "selftest",
    raw: { escalate_to: "D-00", owner_staff_no: "CW-06", reviewer_staff_no: "CW-07" },
    created_at: "2026-09-26T00:00:00.000Z",
    due_at: "2026-09-27T06:00:00.000Z",
    resolved_at: null,
    last_notified_at: null,
  };
  const cases = [
    ["未到期 hold", baseTask],
    ["到期+12h 推", { ...baseTask, due_at: "2026-09-26T23:00:00.000Z" }],
    ["同日第二次不推", { ...baseTask, due_at: "2026-09-26T23:00:00.000Z", last_notified_at: "2026-09-27T01:00:00.000Z" }],
    ["due_at 为空按 created_at+36h", { ...baseTask, due_at: null }],
    ["非审核工单不进新分支", { ...baseTask, raw: { escalate_to: "D-01", owner_staff_no: "CW-06" } }],
  ];
  for (const [name, task] of cases) {
    const decision = ownerReviewStage(task, now);
    const result = !decision ? "skip" : decision.hold ? "hold" : `push-stage-${decision.stage}`;
    console.log(`[selftest] ${name}: ${result}${decision?.reason ? ` (${decision.reason})` : ""}`);
  }
}

async function main() {
  const now = new Date();
  const pool = await getPoolInstance();
  let scanned = 0;
  let due = 0;
  let pushed = 0;
  let skipped = 0;
  let skippedNoOwner = 0;
  let skippedBadOwner = 0;
  let failed = 0;
  let limitReachedLogged = false;

  try {
    const candidateResult = await fetchCandidates(pool, now);
    const ownerReviewResult = await fetchOwnerReviewCandidates(pool, now);
    const activeStaffByNo = await loadActiveStaffByNo(pool);
    const ownerReviewIds = new Set(ownerReviewResult.rows.map((task) => task.id));
    const tasks = candidateResult.rows.filter((task) => !ownerReviewIds.has(task.id));
    scanned = tasks.length + ownerReviewResult.rows.length;
    const ownerReviewDueTasks = [];
    for (const task of ownerReviewResult.rows) {
      const decision = ownerReviewStage(task, now);
      if (!decision) continue;
      if (decision.hold) {
        logOwnerReviewHold(task, decision, now, activeStaffByNo);
      } else {
        ownerReviewDueTasks.push({ task, stageInfo: decision });
      }
    }
    const allDueTasks = tasks
      .map((task) => ({ task, stageInfo: nextStage(task, now) }))
      .filter((x) => x.stageInfo)
      .concat(ownerReviewDueTasks);
    const priorityCounts = allDueTasks.reduce((acc, item) => {
      const key = priorityLabel(item.task.priority); acc[key] = (acc[key] || 0) + 1; return acc;
    }, {});
    due = allDueTasks.length; const loopTasks = LIVE && !STAGED ? allDueTasks.slice(0, LIMIT) : allDueTasks;

    console.log(
      `待推汇总: candidates=${scanned} total=${due} priority=${JSON.stringify(priorityCounts)} owner_review=${ownerReviewResult.rows.length} live_limit=${LIVE ? LIMIT : "dry-all"} staged=${STAGED ? "1" : "0"} skipped_before_watermark=${candidateResult.skippedBeforeWatermark + ownerReviewResult.skippedBeforeWatermark} watermark=${candidateResult.watermark}`
    );

    for (let i = 0; i < loopTasks.length; i += 1) {
      const item = loopTasks[i];
      const chainInfo = item.stageInfo.ownerReview
        ? ownerReviewChainInfo(item.task, activeStaffByNo)
        : resolveChain(item.task.assigned_to, activeStaffByNo);
      if (LIVE && STAGED && !chainInfo.skipReason && shouldPushDamon(item.stageInfo, chainInfo) && pushed >= LIMIT) {
        if (!limitReachedLogged) {
          console.log(`[limit-reached] pushed=${pushed} limit=${LIMIT} remaining=${loopTasks.length - i}`);
          limitReachedLogged = true;
        }
        continue;
      }

      try {
        const r = await processOne(pool, item.task, item.stageInfo, now, chainInfo);
        if (r.pushed) pushed += 1;
        if (r.skipped) skipped += 1;
        if (r.skippedNoOwner) skippedNoOwner += 1;
        if (r.skippedBadOwner) skippedBadOwner += 1;
      } catch (err) {
        failed += 1;
        console.error(`[ERR] task=${item.task.id} stage=${item.stageInfo.stage} ${err.message || err}`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`因无负责人跳过 ${skippedNoOwner} 条 · 因负责人不是有效员工跳过 ${skippedBadOwner} 条 · unclaimed_file=${STAGED ? unclaimedFileFor(now) : "off"}`);
  console.log(`统计: 扫${scanned}/该推${due}/实推${pushed}/跳过${skipped}/失败${failed}/dry=${LIVE ? "0" : "1"}`);
}

if (process.env.ESCALATION_SELFTEST === "owner-review-stage") {
  runOwnerReviewStageSelfTest();
} else {
  main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
