import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CATEGORIES = new Set(["外贸知识", "物流知识"]);
const TOPICS = new Set([
  "舱单申报", "报关通关", "退税", "保险", "提单单证", "贸易术语",
  "报价询盘", "集装箱船务", "系统选型", "业务经营", "其他",
]);
const POST_FIELDS = new Set(["title", "body", "topic", "category", "tags", "url"]);
const PATCH_FIELDS = new Set(["title", "body", "topic", "category", "tags", "url"]);

function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function ensureNoUnknown(body, allowed) {
  return Object.keys(body || {}).filter(key => !allowed.has(key));
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return 50;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  return Math.min(limit, 200);
}

function parseOffset(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const offset = Number.parseInt(raw, 10);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

function parseBool(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  return undefined;
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function parseTags(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  const tags = items.map(item => String(item).trim()).filter(Boolean);
  return [...new Set(tags)].slice(0, 30);
}

function validateTopic(value, required = false) {
  const topic = cleanText(value);
  if (!topic) return required ? { error: "topic required" } : { value: null };
  if (!TOPICS.has(topic)) return { error: "invalid topic" };
  return { value: topic };
}

function validateCategory(value) {
  const category = cleanText(value);
  if (!category) return { value: null };
  if (!CATEGORIES.has(category)) return { error: "invalid category" };
  return { value: category };
}

function userName(req) {
  const user = req.user || {};
  return user.username || user.name || user.uid || user.id || user.role || "system";
}

function buildListWhere(query, includeTopic, params) {
  const where = [];
  const q = cleanText(query.q);
  if (q) {
    params.push(`%${q}%`);
    where.push(`title ILIKE $${params.length}`);
  }
  if (includeTopic) {
    const topic = cleanText(query.topic);
    if (topic) {
      params.push(topic);
      where.push(`topic = $${params.length}`);
    }
  }
  const category = cleanText(query.category);
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  const ours = parseBool(query.is_ours);
  if (ours !== null && ours !== undefined) {
    params.push(ours);
    where.push(`is_ours = $${params.length}`);
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

async function handleList(req, res, pool) {
  const limit = parseLimit(req.query?.limit);
  const offset = parseOffset(req.query?.offset);
  const ours = parseBool(req.query?.is_ours);
  if (limit === null) return fail(res, 400, "invalid limit");
  if (offset === null) return fail(res, 400, "invalid offset");
  if (ours === undefined) return fail(res, 400, "invalid is_ours");

  const topicCheck = validateTopic(req.query?.topic);
  const categoryCheck = validateCategory(req.query?.category);
  if (topicCheck.error) return fail(res, 400, topicCheck.error);
  if (categoryCheck.error) return fail(res, 400, categoryCheck.error);

  const params = [];
  const where = buildListWhere(req.query || {}, true, params);
  const countParams = [...params];
  params.push(limit, offset);

  const rowsSql = `
    SELECT id, source, source_ref, url, title, category, topic, tags,
           is_ours, lang, created_by, created_at, updated_at
      FROM knowledge_articles
      ${where}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const totalSql = `SELECT COUNT(*)::int AS total FROM knowledge_articles ${where}`;

  const facetParams = [];
  const facetWhere = buildListWhere({ ...req.query, topic: "" }, false, facetParams);
  const facetSql = `
    SELECT COALESCE(topic, '未分类') AS topic, COUNT(*)::int AS count
      FROM knowledge_articles
      ${facetWhere}
     GROUP BY COALESCE(topic, '未分类')
     ORDER BY count DESC, topic ASC
  `;

  const [rows, total, facets] = await Promise.all([
    pool.query(rowsSql, params),
    pool.query(totalSql, countParams),
    pool.query(facetSql, facetParams),
  ]);
  const topicFacets = {};
  for (const row of facets.rows) topicFacets[row.topic] = row.count;
  return res.status(200).json({
    success: true,
    data: rows.rows,
    total: total.rows[0]?.total || 0,
    facets: { topic: topicFacets },
  });
}

async function handleDetail(req, res, pool) {
  const id = parseId(req.query?.id);
  if (!id) return fail(res, 400, "id required");
  const { rows } = await pool.query(`
    SELECT id, source, source_ref, url, title, category, topic,
           CASE WHEN is_ours THEN body ELSE NULL END AS body,
           tags, is_ours, lang, created_by, created_at, updated_at
      FROM knowledge_articles
     WHERE id = $1
  `, [id]);
  if (!rows[0]) return fail(res, 404, "not found");
  return res.status(200).json({ success: true, data: rows[0] });
}

async function handlePost(req, res, pool) {
  const body = req.body || {};
  const unknown = ensureNoUnknown(body, POST_FIELDS);
  if (unknown.length) return fail(res, 400, `unsupported fields: ${unknown.join(", ")}`);

  const title = cleanText(body.title);
  const articleBody = hasOwn(body, "body") ? cleanText(body.body) : null;
  if (title === null) return fail(res, 400, "title required");

  const topicCheck = validateTopic(body.topic, true);
  const categoryCheck = validateCategory(body.category);
  if (topicCheck.error) return fail(res, 400, topicCheck.error);
  if (categoryCheck.error) return fail(res, 400, categoryCheck.error);

  const { rows } = await pool.query(`
    INSERT INTO knowledge_articles
      (source, title, body, topic, category, tags, url, is_ours, created_by)
    VALUES ('sanlyn', $1, $2, $3, $4, $5::text[], $6, true, $7)
    RETURNING *
  `, [
    title,
    articleBody,
    topicCheck.value,
    categoryCheck.value,
    parseTags(body.tags),
    cleanText(body.url),
    userName(req),
  ]);
  return res.status(201).json({ success: true, data: rows[0] });
}

async function handlePatch(req, res, pool) {
  const id = parseId(req.query?.id);
  if (!id) return fail(res, 400, "id required");
  const body = req.body || {};
  const unknown = ensureNoUnknown(body, PATCH_FIELDS);
  if (unknown.length) return fail(res, 400, `unsupported fields: ${unknown.join(", ")}`);

  const existing = await pool.query("SELECT id, is_ours FROM knowledge_articles WHERE id = $1", [id]);
  if (!existing.rows[0]) return fail(res, 404, "not found");
  if (!existing.rows[0].is_ours) return fail(res, 403, "external articles are read-only");

  const sets = [];
  const params = [];
  if (hasOwn(body, "title")) {
    const title = cleanText(body.title);
    if (title === null) return fail(res, 400, "title required");
    params.push(title);
    sets.push(`title = $${params.length}`);
  }
  if (hasOwn(body, "body")) {
    params.push(cleanText(body.body));
    sets.push(`body = $${params.length}`);
  }
  if (hasOwn(body, "topic")) {
    const topicCheck = validateTopic(body.topic);
    if (topicCheck.error) return fail(res, 400, topicCheck.error);
    params.push(topicCheck.value);
    sets.push(`topic = $${params.length}`);
  }
  if (hasOwn(body, "category")) {
    const categoryCheck = validateCategory(body.category);
    if (categoryCheck.error) return fail(res, 400, categoryCheck.error);
    params.push(categoryCheck.value);
    sets.push(`category = $${params.length}`);
  }
  if (hasOwn(body, "tags")) {
    params.push(parseTags(body.tags));
    sets.push(`tags = $${params.length}::text[]`);
  }
  if (hasOwn(body, "url")) {
    params.push(cleanText(body.url));
    sets.push(`url = $${params.length}`);
  }
  if (!sets.length) return fail(res, 400, "no editable fields");

  params.push(id);
  const { rows } = await pool.query(`
    UPDATE knowledge_articles
       SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${params.length} AND is_ours = true
    RETURNING *
  `, params);
  return res.status(200).json({ success: true, data: rows[0] });
}

async function handleDelete(req, res, pool) {
  const id = parseId(req.query?.id);
  if (!id) return fail(res, 400, "id required");
  const existing = await pool.query("SELECT id, is_ours FROM knowledge_articles WHERE id = $1", [id]);
  if (!existing.rows[0]) return fail(res, 404, "not found");
  if (!existing.rows[0].is_ours) return fail(res, 403, "external articles are read-only");

  await pool.query("DELETE FROM knowledge_articles WHERE id = $1 AND is_ours = true", [id]);
  return res.status(200).json({ success: true, deleted: id });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  try {
    if (req.method === "GET" && req.query?.id) return handleDetail(req, res, pool);
    if (req.method === "GET") return handleList(req, res, pool);
    if (req.method === "POST") return handlePost(req, res, pool);
    if (req.method === "PATCH") return handlePatch(req, res, pool);
    if (req.method === "DELETE") return handleDelete(req, res, pool);
    return fail(res, 405, "method not allowed");
  } catch (err) {
    console.error("[knowledge]", err);
    return fail(res, 500, "knowledge api failed");
  }
}
