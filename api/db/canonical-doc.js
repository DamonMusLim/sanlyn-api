import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DOC_TYPES = new Set(["freight_invoice", "customs_declaration"]);
const KEY_TYPES = new Set(["cy_no", "order_id"]);
const SOURCES = new Set(["render", "upload", "manual"]);
const WRITE_ROLES = new Set(["admin", "finance", "ops"]);

function norm(value) {
  return String(value ?? "").trim();
}

function actorOf(req, fallback) {
  return norm(fallback)
    || norm(req.user?.username)
    || norm(req.user?.email)
    || norm(req.user?.uid)
    || norm(req.user?.id)
    || "unknown";
}

function validateKey(input) {
  const doc_type = norm(input.doc_type);
  const business_key_type = norm(input.business_key_type || "cy_no");
  const business_key = norm(input.business_key);

  if (!DOC_TYPES.has(doc_type)) {
    return { error: "doc_type must be freight_invoice or customs_declaration" };
  }
  if (!KEY_TYPES.has(business_key_type)) {
    return { error: "business_key_type must be cy_no or order_id" };
  }
  if (!business_key) {
    return { error: "business_key required" };
  }
  return { doc_type, business_key_type, business_key };
}

function canonicalPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonical_version_id: row.id,
    status: row.status,
    version: row.version,
    source: row.source,
    storage_uri: row.storage_uri,
    snapshot_json: row.snapshot_json,
    locked_at: row.locked_at,
    locked_by: row.locked_by,
  };
}

async function latestDraft(pool, key) {
  const r = await pool.query(
    `SELECT id, status, version, source, storage_uri, snapshot_json, locked_at, locked_by, created_at
       FROM document_canonical_versions
      WHERE doc_type = $1 AND business_key_type = $2 AND business_key = $3 AND status = 'draft'
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1`,
    [key.doc_type, key.business_key_type, key.business_key]
  );
  return r.rows[0] || null;
}

async function listCanonicalCandidates(pool, input) {
  const key = validateKey(input);
  if (key.error) {
    const err = new Error(key.error);
    err.status = 400;
    throw err;
  }

  const canonical = await getCanonicalDoc(pool, key);
  let uploads = { rows: [] };
  try {
    uploads = await pool.query(
      `SELECT id, doc_id, doc_type, contract_no, url, name, size, note, uploader, uploaded_at
         FROM document_uploads
        WHERE doc_id = $1 OR contract_no = $1
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 80`,
      [key.business_key]
    );
  } catch (err) {
    if (err.code !== "42P01") throw err;
  }

  const candidates = uploads.rows.map((row) => ({
    candidate_type: "upload",
    source_ref_id: row.id,
    doc_id: row.doc_id,
    doc_type: row.doc_type,
    contract_no: row.contract_no,
    storage_uri: row.url,
    name: row.name,
    size: row.size,
    note: row.note,
    uploader: row.uploader,
    uploaded_at: row.uploaded_at,
    is_current_locked: canonical?.status === "locked" && canonical.storage_uri === row.url,
  }));

  return { ...key, canonical, candidates };
}

export async function getCanonicalDoc(pool, input) {
  const key = validateKey(input);
  if (key.error) {
    const err = new Error(key.error);
    err.status = 400;
    throw err;
  }

  const locked = await pool.query(
    `SELECT id, status, version, source, storage_uri, snapshot_json, locked_at, locked_by, created_at
       FROM document_canonical_versions
      WHERE doc_type = $1 AND business_key_type = $2 AND business_key = $3 AND status = 'locked'
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1`,
    [key.doc_type, key.business_key_type, key.business_key]
  );

  const current = locked.rows[0];
  if (current) {
    return {
      doc_type: key.doc_type,
      business_key_type: key.business_key_type,
      business_key: key.business_key,
      ...canonicalPayload(current),
    };
  }

  const draft = await latestDraft(pool, key);
  return {
    doc_type: key.doc_type,
    business_key_type: key.business_key_type,
    business_key: key.business_key,
    status: "no_canonical",
    draft: canonicalPayload(draft),
  };
}

export async function lockCanonicalDoc(pool, input) {
  const key = validateKey(input);
  if (key.error) {
    const err = new Error(key.error);
    err.status = 400;
    throw err;
  }

  const source = norm(input.source);
  if (!SOURCES.has(source)) {
    const err = new Error("source must be render, upload or manual");
    err.status = 400;
    throw err;
  }
  if (!norm(input.storage_uri) && input.snapshot_json === undefined) {
    const err = new Error("storage_uri or snapshot_json required");
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT *
         FROM document_canonical_versions
        WHERE doc_type = $1 AND business_key_type = $2 AND business_key = $3 AND status = 'locked'
        FOR UPDATE`,
      [key.doc_type, key.business_key_type, key.business_key]
    );

    const maxVersion = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM document_canonical_versions
        WHERE doc_type = $1 AND business_key_type = $2 AND business_key = $3`,
      [key.doc_type, key.business_key_type, key.business_key]
    );
    const version = Number(maxVersion.rows[0]?.max_version || 0) + 1;
    const actor = norm(input.locked_by) || "unknown";

    for (const row of current.rows) {
      const before = row;
      const superseded = await client.query(
        `UPDATE document_canonical_versions
            SET status = 'superseded'
          WHERE id = $1
          RETURNING *`,
        [row.id]
      );
      await client.query(
        `INSERT INTO document_canonical_audit_logs
           (canonical_version_id, doc_type, business_key_type, business_key, action, actor, before_json, after_json)
         VALUES ($1,$2,$3,$4,'supersede',$5,$6::jsonb,$7::jsonb)`,
        [
          row.id,
          key.doc_type,
          key.business_key_type,
          key.business_key,
          actor,
          JSON.stringify(before),
          JSON.stringify(superseded.rows[0]),
        ]
      );
    }

    const inserted = await client.query(
      `INSERT INTO document_canonical_versions
         (doc_type, business_key_type, business_key, version, status, source, storage_uri, snapshot_json, locked_at, locked_by)
       VALUES ($1,$2,$3,$4,'locked',$5,$6,$7::jsonb,now(),$8)
       RETURNING *`,
      [
        key.doc_type,
        key.business_key_type,
        key.business_key,
        version,
        source,
        norm(input.storage_uri) || null,
        input.snapshot_json === undefined ? null : JSON.stringify(input.snapshot_json),
        actor,
      ]
    );
    const row = inserted.rows[0];

    await client.query(
      `INSERT INTO document_canonical_audit_logs
         (canonical_version_id, doc_type, business_key_type, business_key, action, actor, after_json)
       VALUES ($1,$2,$3,$4,'lock',$5,$6::jsonb)`,
      [row.id, key.doc_type, key.business_key_type, key.business_key, actor, JSON.stringify(row)]
    );

    await client.query("COMMIT");
    return {
      doc_type: key.doc_type,
      business_key_type: key.business_key_type,
      business_key: key.business_key,
      ...canonicalPayload(row),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function unlockCanonicalDoc(pool, input) {
  const key = validateKey(input);
  if (key.error) {
    const err = new Error(key.error);
    err.status = 400;
    throw err;
  }
  const reason = norm(input.reason);
  if (!reason) {
    const err = new Error("reason required");
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT *
         FROM document_canonical_versions
        WHERE doc_type = $1 AND business_key_type = $2 AND business_key = $3 AND status = 'locked'
        ORDER BY version DESC, created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [key.doc_type, key.business_key_type, key.business_key]
    );
    const before = locked.rows[0];
    if (!before) {
      const err = new Error("locked canonical not found");
      err.status = 404;
      throw err;
    }

    const actor = norm(input.unlocked_by) || "unknown";
    const updated = await client.query(
      `UPDATE document_canonical_versions
          SET status = 'draft',
              version = version + 1,
              locked_at = NULL,
              locked_by = NULL
        WHERE id = $1
        RETURNING *`,
      [before.id]
    );
    const row = updated.rows[0];

    await client.query(
      `INSERT INTO document_canonical_audit_logs
         (canonical_version_id, doc_type, business_key_type, business_key, action, actor, reason, before_json, after_json)
       VALUES ($1,$2,$3,$4,'unlock',$5,$6,$7::jsonb,$8::jsonb)`,
      [
        row.id,
        key.doc_type,
        key.business_key_type,
        key.business_key,
        actor,
        reason,
        JSON.stringify(before),
        JSON.stringify(row),
      ]
    );

    await client.query("COMMIT");
    return {
      doc_type: key.doc_type,
      business_key_type: key.business_key_type,
      business_key: key.business_key,
      ...canonicalPayload(row),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  try {
    if (req.method === "GET") {
      if (norm(req.query?.action) === "candidates") {
        const data = await listCanonicalCandidates(pool, req.query || {});
        return res.status(200).json({ success: true, data });
      }
      const data = await getCanonicalDoc(pool, req.query || {});
      return res.status(200).json({ success: true, data });
    }

    if (req.method === "POST") {
      if (!WRITE_ROLES.has(req.user?.role)) {
        return res.status(403).json({ error: "Forbidden: admin, finance or ops role required" });
      }
      const body = req.body || {};
      const action = norm(body.action || req.query?.action);
      if (action === "lock") {
        const data = await lockCanonicalDoc(pool, {
          ...body,
          locked_by: body.locked_by || actorOf(req),
        });
        return res.status(200).json({ success: true, data });
      }
      if (action === "unlock") {
        const data = await unlockCanonicalDoc(pool, {
          ...body,
          unlocked_by: body.unlocked_by || actorOf(req),
        });
        return res.status(200).json({ success: true, data });
      }
      return res.status(400).json({ error: "action must be lock or unlock" });
    }

    return res.status(405).json({ error: "Method not allowed", allowed: ["GET", "POST"] });
  } catch (err) {
    console.error("[canonical-doc] error:", err);
    return res.status(err.status || 500).json({ error: err.message || "internal" });
  }
}
