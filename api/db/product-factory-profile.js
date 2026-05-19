// api/db/product-factory-profile.js — Factory Write-in V1 (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/db/products/:sku/factory-profile
//
// Lets a factory (or an admin/finance/logistics acting as proxy) write the
// factory-side product profile into products.raw. V1 transition surface;
// future versions migrate this to a normalized product_factory_profile table.
//
// Hard constraints (Damon 2026-05-20):
//   • Only writes raw.factory_profile and raw.aliases.factory[<code>].
//   • Never writes raw.pricing, customer aliases, top-level columns, or
//     anything outside the FACTORY_PROFILE_WRITABLE_KEYS allow-list.
//   • Read-modify-write under SELECT … FOR UPDATE so the merge is atomic
//     and cannot stomp another writer's concurrent changes.
//   • Backup of the row's raw BEFORE write to /tmp/product-factory-
//     writein-backup-<ts>.jsonl (one line per request).
//   • audit_log via api/audit.js writeAuditLog with
//       action = "PRODUCT_FACTORY_PROFILE_UPDATED"
//
// Permission: api/lib/product-scope.js canWriteFactoryProfile().
//   - admin / finance / logistics / platform_* → must pass target_factory_company_code
//   - factory → locked to own company_code (body's target is IGNORED)
//   - everyone else → 403

import fs from "node:fs";
import path from "node:path";
import { getPool, setCors } from "../db.js";
import { writeAuditLog, getClientInfo } from "../audit.js";
import {
  canWriteFactoryProfile,
  FACTORY_PROFILE_WRITABLE_KEYS,
  FACTORY_PROFILE_REJECTED_KEYS,
} from "../lib/product-scope.js";

const SOURCE_TAG = "factory_writein_v1";
const BACKUP_DIR = "/tmp";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Pulls the SKU from the route param, falling back to ?sku= or body.sku for
// flat-mount setups. SKU is treated as a literal value (parameterized in SQL),
// never interpolated.
function extractSku(req) {
  const fromParam = req.params && (req.params.sku || req.params[0]);
  if (fromParam) return String(fromParam).trim();
  if (req.query && req.query.sku) return String(req.query.sku).trim();
  if (req.body && req.body.sku) return String(req.body.sku).trim();
  return "";
}

// Whitelists the body. Returns { patch, rejected } where:
//   patch    = object of accepted writable keys
//   rejected = array of keys that appeared but are not on the allow-list
function pickWritablePatch(body) {
  if (!isPlainObject(body)) return { patch: {}, rejected: [] };
  const patch = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === "target_factory_company_code") continue; // routing field
    if (FACTORY_PROFILE_WRITABLE_KEYS.includes(k)) {
      if (v !== undefined) patch[k] = v;
    } else {
      // Surface unknown keys as rejected. Explicit rejection of obviously
      // dangerous keys (factory_price, pricing, aliases, raw, …) is clearer
      // than silent ignore.
      if (FACTORY_PROFILE_REJECTED_KEYS.includes(k) || k.startsWith("_")) {
        rejected.push(k);
      } else {
        rejected.push(k);
      }
    }
  }
  return { patch, rejected };
}

function nowIso() {
  return new Date().toISOString();
}

// Append a JSONL backup record. Best-effort: if /tmp is unwritable we surface
// the error so the caller can decide. We do NOT swallow this — the rule is
// "backup before write". If backup fails we reject the request.
function writeBackup(record) {
  const ts = record.timestamp.replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `product-factory-writein-backup-${ts.slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8" });
  return file;
}

// Merge the patch into existing raw.factory_profile. Returns the new
// factory_profile object (caller is responsible for assigning it back to raw).
function buildFactoryProfile(prevProfile, patch, targetCode, factoryName, actor) {
  const base = isPlainObject(prevProfile) ? { ...prevProfile } : {};
  // Apply only the whitelisted keys
  for (const k of FACTORY_PROFILE_WRITABLE_KEYS) {
    if (patch[k] !== undefined) base[k] = patch[k];
  }
  base.factory_company_code = targetCode;
  if (factoryName) base.factory_name = factoryName;
  base.updated_by_user_id = actor.user_id;
  base.updated_by_role = actor.role;
  base.updated_by_company_code = actor.company_code;
  base.updated_at = nowIso();
  base.source = SOURCE_TAG;
  return base;
}

function buildFactoryAlias(prevAlias, patch, actor) {
  const base = isPlainObject(prevAlias) ? { ...prevAlias } : {};
  if (patch.factory_product_code !== undefined) base.code = patch.factory_product_code;
  if (patch.factory_product_name !== undefined) base.name = patch.factory_product_name;
  if (patch.factory_spec        !== undefined) base.spec = patch.factory_spec;
  base.updated_by_user_id = actor.user_id;
  base.updated_at = nowIso();
  base.source = SOURCE_TAG;
  return base;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res, "PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed", method: req.method });
  }

  try {
    if (!req.user) {
      return res.status(403).json({ error: "Forbidden", message: "no req.user" });
    }

    const body = req.body || {};
    const requestedTarget = typeof body.target_factory_company_code === "string"
      ? body.target_factory_company_code.trim()
      : "";

    const auth = canWriteFactoryProfile(req.user, requestedTarget);
    if (!auth.ok) {
      return res.status(403).json({ error: "Forbidden", message: auth.reason });
    }
    const targetCode = auth.targetFactoryCompanyCode;

    const sku = extractSku(req);
    if (!sku) return res.status(400).json({ error: "sku required" });

    const { patch, rejected } = pickWritablePatch(body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        error: "no writable fields",
        message: "body must contain at least one of: " + FACTORY_PROFILE_WRITABLE_KEYS.join(", "),
        rejected,
      });
    }

    const actor = {
      user_id: req.user.id || req.user.uid || req.user.sub || null,
      role: String(req.user.role || "").toLowerCase(),
      company_code: req.user.companyCode || req.user.company_code || null,
      user_name: req.user.name || req.user.account || null,
    };

    const pool = getPool();
    const client = await pool.connect();
    let backupFile = null;
    try {
      await client.query("BEGIN");

      // SELECT FOR UPDATE — atomic read-modify-write
      const sel = await client.query(
        "SELECT id, sku, raw, factory_name FROM products WHERE sku = $1 FOR UPDATE",
        [sku]
      );
      if (sel.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "product not found", sku });
      }
      const row = sel.rows[0];
      const prevRaw = isPlainObject(row.raw) ? row.raw : {};
      const prevProfile = isPlainObject(prevRaw.factory_profile) ? prevRaw.factory_profile : {};
      const prevAliases = isPlainObject(prevRaw.aliases) ? prevRaw.aliases : {};
      const prevFactoryMap = isPlainObject(prevAliases.factory) ? prevAliases.factory : {};
      const prevAlias = isPlainObject(prevFactoryMap[targetCode]) ? prevFactoryMap[targetCode] : {};

      const newProfile = buildFactoryProfile(
        prevProfile, patch, targetCode, row.factory_name, actor
      );
      const newAlias = buildFactoryAlias(prevAlias, patch, actor);

      // Build new raw by merging only the two whitelisted sub-paths. Never
      // assign `raw = body.raw`; we structurally know what's going in.
      const newRaw = { ...prevRaw };
      newRaw.factory_profile = newProfile;
      newRaw.aliases = {
        ...(isPlainObject(prevRaw.aliases) ? prevRaw.aliases : {}),
        factory: {
          ...prevFactoryMap,
          [targetCode]: newAlias,
        },
      };

      // ── Backup BEFORE commit ──────────────────────────────────────────
      const timestamp = nowIso();
      const backupRecord = {
        timestamp,
        product_id: row.id,
        sku: row.sku,
        actor,
        target_factory_company_code: targetCode,
        requested_patch: patch,
        rejected_keys: rejected,
        raw_before: prevRaw,
      };
      try {
        backupFile = writeBackup(backupRecord);
      } catch (e) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          error: "backup_failed",
          message: "refusing to write without backup: " + e.message,
        });
      }

      const upd = await client.query(
        "UPDATE products SET raw = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING id, sku",
        [JSON.stringify(newRaw), row.id]
      );

      await client.query("COMMIT");

      // ── Audit log (best-effort; writeAuditLog swallows its own errors) ─
      const changedKeys = Object.keys(patch);
      const clientInfo = getClientInfo(req);
      await writeAuditLog({
        tenant_id: "SANLYN",
        user_id: actor.user_id,
        user_name: actor.user_name,
        user_role: actor.role,
        table_name: "products",
        record_id: String(row.id),
        action: "PRODUCT_FACTORY_PROFILE_UPDATED",
        old_values: { factory_profile: prevProfile, alias: prevAlias },
        new_values: { factory_profile: newProfile, alias: newAlias },
        changes: {
          target_factory_company_code: targetCode,
          changed_keys: changedKeys,
          source: SOURCE_TAG,
        },
        ip_address: clientInfo.ip_address,
        user_agent: clientInfo.user_agent,
        note: `factory_writein_v1 by ${actor.role} ${actor.company_code || ""}`,
      });

      return res.status(200).json({
        success: true,
        id: upd.rows[0].id,
        sku: upd.rows[0].sku,
        target_factory_company_code: targetCode,
        changed_keys: changedKeys,
        rejected_keys: rejected,
        backup_file: backupFile,
        source: SOURCE_TAG,
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
