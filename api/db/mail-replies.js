import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const REPLY_INDEX_URL = "http://100.87.134.113:3760/api/reply-index";
const REPLY_ACCOUNT_ID = "ob-biz";
const REPLY_LIMIT = 2000;
const UPSTREAM_TIMEOUT_MS = 8000;
const MATCH_RANK = { in_reply_to: 1, references: 2, bl_fallback: 3 };
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "qq.com", "163.com", "126.com", "yeah.net", "hotmail.com",
  "outlook.com", "foxmail.com", "yahoo.com", "live.com", "icloud.com",
  "msn.com", "aol.com", "proton.me", "protonmail.com",
]);
const COMPANY_EMAIL_COLS = [
  "contact_email", "einvoice_email", "biz_contact_email", "fin_contact_email",
];

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

function emailDomain(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : "";
}

function partyIdentity(value) {
  const email = normalizeEmail(value);
  const domain = emailDomain(email);
  const personal = !domain || PERSONAL_DOMAINS.has(domain);
  return {
    key: personal ? email : domain,
    label: personal ? email : domain,
    is_personal_domain: personal,
  };
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
      const candidate = {
        replied_by: reply.from_email || null,
        replied_at: reply.received_at || null,
        match_kind: matchKind,
      };
      if (betterReplyMatch(candidate, best)) {
        best = candidate;
      }
      if (best.match_kind === "in_reply_to") break;
    }

    return {
      ...item,
      party_key: partyIdentity(item.email).key,
      replied: Boolean(best),
      replied_by: best?.replied_by || null,
      replied_at: best?.replied_at || null,
      match_kind: best?.match_kind || null,
    };
  });
}

function partyRows(recipients, upstreamOk, companyLabels) {
  const byKey = new Map();
  for (const recipient of recipients) {
    const ident = partyIdentity(recipient.email);
    if (!ident.key) continue;
    if (!byKey.has(ident.key)) {
      byKey.set(ident.key, {
        party_key: ident.key,
        party_label: companyLabels[ident.key] || ident.label,
        is_personal_domain: ident.is_personal_domain,
        emails: [],
        replied: upstreamOk ? false : null,
        replied_by: null,
        replied_at: null,
        match_kind: null,
      });
    }
    const party = byKey.get(ident.key);
    const email = cleanText(recipient.email);
    if (email && !party.emails.includes(email)) party.emails.push(email);
    if (!upstreamOk || recipient.replied !== true) continue;
    const candidate = {
      replied_by: recipient.replied_by || recipient.email || null,
      replied_at: recipient.replied_at || null,
      match_kind: recipient.match_kind || null,
    };
    if (betterReplyMatch(candidate, party)) {
      party.replied = true;
      party.replied_by = candidate.replied_by;
      party.replied_at = candidate.replied_at;
      party.match_kind = candidate.match_kind;
    }
  }
  return Array.from(byKey.values());
}

function collectRecipientKeys(rows) {
  const emails = new Set();
  const domains = new Set();
  for (const row of rows) {
    for (const email of [...asArray(row.to_emails), ...asArray(row.cc_emails)]) {
      const normalized = normalizeEmail(email);
      const domain = emailDomain(normalized);
      if (normalized) emails.add(normalized);
      if (domain && !PERSONAL_DOMAINS.has(domain)) domains.add(domain);
    }
  }
  return { emails: Array.from(emails), domains: Array.from(domains) };
}

function displayCompany(row) {
  return cleanText(row.name_cn) || cleanText(row.name_en) || cleanText(row.short_name) || cleanText(row.code);
}

async function companyLabelsForRows(pool, rows) {
  const keys = collectRecipientKeys(rows);
  if (!keys.emails.length && !keys.domains.length) return {};
  try {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='companies' AND column_name = ANY($1::text[])`,
      [["code", "name_cn", "name_en", "short_name", ...COMPANY_EMAIL_COLS]]
    );
    const have = new Set(cols.rows.map(row => row.column_name));
    const emailCols = COMPANY_EMAIL_COLS.filter(col => have.has(col));
    if (!emailCols.length) return {};

    const selectCols = ["code", "name_cn", "name_en", "short_name"]
      .filter(col => have.has(col))
      .concat(emailCols);
    const emailTests = emailCols.map(col => `lower(coalesce(${col}::text,'')) = ANY($1::text[])`);
    const domainTests = emailCols.map(col => `
      EXISTS (SELECT 1 FROM unnest($2::text[]) d
        WHERE lower(coalesce(${col}::text,'')) LIKE '%@' || d)`);
    const result = await pool.query(
      `SELECT ${selectCols.join(", ")} FROM companies
       WHERE ${emailTests.concat(domainTests).join(" OR ")}
       ORDER BY id LIMIT 500`,
      [keys.emails, keys.domains]
    );

    const labels = {};
    for (const row of result.rows) {
      const label = displayCompany(row);
      if (!label) continue;
      for (const col of emailCols) {
        const value = cleanText(row[col]).toLowerCase();
        const exact = normalizeEmail(value);
        if (exact && keys.emails.includes(exact)) labels[exact] = labels[exact] || label;
        for (const domain of keys.domains) {
          if (value.includes("@" + domain)) labels[domain] = labels[domain] || label;
        }
      }
    }
    return labels;
  } catch {
    return {};
  }
}

function normalizeOutboxRow(row, upstreamOk, replies, companyLabels) {
  const recipients = recipientRows(row, upstreamOk, replies);
  const parties = partyRows(recipients, upstreamOk, companyLabels || {});
  const item = {
    outbox_id: row.id,
    subject: row.subject || "",
    related_bl_no: row.related_bl_no || null,
    sent_at: row.sent_at || null,
    recipients,
    parties,
  };

  if (upstreamOk) {
    item.replied_count = recipients.filter(recipient => recipient.replied === true).length;
    item.pending_count = recipients.filter(recipient => recipient.replied === false).length;
    item.party_replied_count = parties.filter(party => party.replied === true).length;
    item.party_pending_count = parties.filter(party => party.replied === false).length;
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
    // 🔴 node-pg 的参数字段叫 values 不叫 params。写成 params 时无参调用正常、
    // 一带筛选就 500 "there is no parameter $1" —— 不传参那条路测不出来。
    values: params,
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
  const companyLabels = await companyLabelsForRows(pool, outboxResult.rows);
  const data = outboxResult.rows.map(row => normalizeOutboxRow(row, upstreamOk, upstream.replies, companyLabels));
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
