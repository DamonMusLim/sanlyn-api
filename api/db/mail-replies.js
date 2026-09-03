import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const REPLY_INDEX_URL = "http://100.87.134.113:3760/api/reply-index";
const REPLY_ACCOUNT_ID = "ob-biz";
const REPLY_LIMIT = 2000;
const UPSTREAM_TIMEOUT_MS = 8000;
const MATCH_RANK = { in_reply_to: 1, references: 2, bl_fallback: 3 };

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value ? [value] : [];
    }
  }
  return [value];
}

function cleanText(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeEmail(value) {
  const text = cleanText(value).toLowerCase();
  const angle = text.match(/<([^<>@\s]+@[^<>\s]+)>/);
  return angle ? angle[1] : text;
}

function normalizeMessageId(value) {
  const noBrackets = cleanText(value).replace(/^<|>$/g, "").trim();
  const afterPlus = noBrackets.slice(noBrackets.lastIndexOf("+") + 1);
  return afterPlus.toLowerCase();
}

function referenceIds(value) {
  return cleanText(value)
    .split(/\s+/)
    .map(normalizeMessageId)
    .filter(Boolean);
}

function matchKindForReply(reply, sentMessageId, blNo) {
  const sentId = normalizeMessageId(sentMessageId);
  if (!sentId) return null;

  if (normalizeMessageId(reply.in_reply_to) === sentId) {
    return "in_reply_to";
  }
  if (referenceIds(reply.references).includes(sentId)) {
    return "references";
  }

  const bl = cleanText(blNo).toLowerCase();
  const subject = cleanText(reply.subject).toLowerCase();
  if (bl && subject.includes(bl)) {
    return "bl_fallback";
  }
  return null;
}

function betterReplyMatch(candidate, best) {
  if (!best) return true;
  const candidateRank = MATCH_RANK[candidate.match_kind] || 99;
  const bestRank = MATCH_RANK[best.match_kind] || 99;
  if (candidateRank !== bestRank) return candidateRank < bestRank;
  return String(candidate.replied_at || "") < String(best.replied_at || "");
}

function recipientRows(row, upstreamOk, replies) {
  const base = [
    ...asArray(row.to_emails).map(email => ({ email: cleanText(email), role: "to" })),
    ...asArray(row.cc_emails).map(email => ({ email: cleanText(email), role: "cc" })),
  ].filter(item => item.email);

  return base.map(item => {
    if (!upstreamOk) {
      return { ...item, replied: null, replied_at: null, match_kind: null };
    }

    const email = normalizeEmail(item.email);
    let best = null;
    for (const reply of replies) {
      if (normalizeEmail(reply.from_email) !== email) continue;
      const matchKind = matchKindForReply(reply, row.message_id, row.related_bl_no);
      if (!matchKind) continue;
      const candidate = { replied_at: reply.received_at || null, match_kind: matchKind };
      if (betterReplyMatch(candidate, best)) {
        best = candidate;
      }
      if (best.match_kind === "in_reply_to") break;
    }

    return {
      ...item,
      replied: Boolean(best),
      replied_at: best?.replied_at || null,
      match_kind: best?.match_kind || null,
    };
  });
}

function normalizeOutboxRow(row, upstreamOk, replies) {
  const recipients = recipientRows(row, upstreamOk, replies);
  const item = {
    outbox_id: row.id,
    subject: row.subject || "",
    related_bl_no: row.related_bl_no || null,
    sent_at: row.sent_at || null,
    recipients,
  };

  if (upstreamOk) {
    item.replied_count = recipients.filter(recipient => recipient.replied === true).length;
    item.pending_count = recipients.filter(recipient => recipient.replied === false).length;
  }
  return item;
}

async function fetchReplyIndex() {
  const token = process.env.EMAIL_AGENT_INTERNAL_TOKEN;
  if (!token) {
    return { ok: false, error: "missing_email_agent_internal_token", replies: [] };
  }

  const url = new URL(REPLY_INDEX_URL);
  url.searchParams.set("account_id", REPLY_ACCOUNT_ID);
  url.searchParams.set("limit", String(REPLY_LIMIT));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "X-Internal-Token": token },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `reply_index_http_${response.status}`, replies: [] };
    }
    const payload = await response.json();
    if (!payload?.ok || !Array.isArray(payload.data)) {
      return { ok: false, error: "reply_index_bad_payload", replies: [] };
    }
    return {
      ok: true,
      replies: payload.data,
      truncated: Boolean(payload.truncated),
      total_matched: payload.total_matched,
    };
  } catch (err) {
    const code = err?.name === "AbortError" ? "reply_index_timeout" : "reply_index_fetch_failed";
    return { ok: false, error: code, replies: [] };
  } finally {
    clearTimeout(timer);
  }
}

function buildOutboxQuery(query) {
  const where = [];
  const params = [];
  if (query?.outbox_id) {
    params.push(query.outbox_id);
    where.push(`id = $${params.length}`);
  }
  if (query?.bl_no) {
    params.push(query.bl_no);
    where.push(`related_bl_no = $${params.length}`);
  }
  if (!where.length) {
    where.push("status = 'sent'");
  }
  return {
    text: `
      SELECT id, message_id, to_emails, cc_emails, subject, related_bl_no, status, sent_at
      FROM mail_outbox
      WHERE ${where.join(" AND ")}
      ORDER BY sent_at DESC NULLS LAST, id DESC
    `,
    params,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const pool = getPool();
  const [outboxResult, upstream] = await Promise.all([
    pool.query(buildOutboxQuery(req.query || {})),
    fetchReplyIndex(),
  ]);

  const upstreamOk = Boolean(upstream.ok);
  const data = outboxResult.rows.map(row => normalizeOutboxRow(row, upstreamOk, upstream.replies));
  const payload = { ok: true, upstream_ok: upstreamOk, data };

  if (!upstreamOk) {
    payload.upstream_error = upstream.error || "reply_index_unavailable";
  }
  if (upstream.truncated !== undefined) {
    payload.truncated = upstream.truncated;
  }
  if (upstream.total_matched !== undefined) {
    payload.total_matched = upstream.total_matched;
  }

  return res.status(200).json(payload);
}
