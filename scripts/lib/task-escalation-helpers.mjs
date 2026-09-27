const SELF_HEAL_MARKERS = new Set(["claude", "ai", "ai-00", "agent"]);
const DOMAIN_LABEL = new Map(Object.entries({ petshop: "宠物店", infra: "系统基建", ai: "AI" }));
const MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

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

export { asDate, companyOrDomainPrefix, deadlineFor, escalationSince, firstLink, firstNonEmpty, idempotencyKey, nextStage, nonEmptyText, normalizeStaffNo, normalizedPriority, ownerReviewStage, priorityLabel, rawText, resolveChain, staffName, todayKey };
