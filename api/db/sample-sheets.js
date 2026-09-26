import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function cleanText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function pickSampleBrief(input) {
  const b = input && typeof input === "object" ? input : {};
  return {
    product_name: cleanText(b.product_name),
    spec: cleanText(b.spec),
    qty: b.qty === undefined || b.qty === null || b.qty === "" ? null : b.qty,
    unit: cleanText(b.unit),
    notes: cleanText(b.notes),
  };
}

function requireBrief(brief) {
  if (!brief.product_name) return "sample_brief.product_name_required";
  if (!brief.spec) return "sample_brief.spec_required";
  if (brief.qty === null) return "sample_brief.qty_required";
  if (!brief.unit) return "sample_brief.unit_required";
  return null;
}

function parseSamplePath(req) {
  const pathname = (req.url || "").split("?")[0];
  const m = pathname.match(/\/api\/db\/sample-sheets\/(\d+)(?:\/(qc|ship|sign))?$/);
  return m ? { id: parseInt(m[1], 10), action: m[2] || null } : { id: null, action: null };
}

function actorId(req) { return (req.user && (req.user.username || req.user.uid)) || "admin"; }

function statusConflict(res, current, required) {
  return sendError(res, 409, "invalid_status", `当前状态 ${current || "-"}，本动作要求 ${required}`);
}

function requireOneOf(res, value, allowed, field) {
  if (!allowed.includes(value)) {
    sendError(res, 400, "invalid_" + field, `${field} must be one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

async function ensureTask(client, sheetId, node, title, description, ownerType, ownerId, createdBy) {
  const existing = await client.query(
    `SELECT task_id, title, workflow_node, status FROM sample_workflow_tasks
      WHERE sample_sheet_id = $1 AND workflow_node = $2 ORDER BY created_at DESC LIMIT 1`,
    [sheetId, node]);
  if (existing.rows.length) return existing.rows[0];

  const created = await client.query(
    `INSERT INTO sample_workflow_tasks
       (title, description, sample_sheet_id, workflow_node, risk_level,
        status, owner_type, owner_id, created_by)
     VALUES ($1, $2, $3, $4, 'P3', 'NEW', $5, $6, $7)
     RETURNING task_id, title, workflow_node, status`,
    [title, description, sheetId, node, ownerType, ownerId, createdBy]);
  return created.rows[0];
}

async function completeTask(client, taskId) {
  await client.query(
    `UPDATE sample_workflow_tasks SET status = 'DONE',
        completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE task_id = $1`,
    [taskId]);
}

async function logEvent(client, taskId, eventType, fromStatus, toStatus, actor, note, payload) {
  await client.query(
    `INSERT INTO sample_task_events
       (task_id, event_type, from_status, to_status, actor_type, actor_id, note, payload)
     VALUES ($1, $2, $3, $4, 'HUMAN', $5, $6, $7::jsonb)`,
    [taskId, eventType, fromStatus, toStatus, actor, note, JSON.stringify(payload || {})]);
}

async function loadSheetForAction(client, sheetId) {
  const { rows } = await client.query(
    `SELECT id, status, order_no, contract_no, owner_company_code, sample_brief
       FROM sample_delivery_sheets WHERE id = $1 FOR UPDATE`,
    [sheetId]);
  return rows[0] || null;
}

function factoryCodeOf(sheet) {
  const brief = sheet && sheet.sample_brief && typeof sheet.sample_brief === "object" ? sheet.sample_brief : {};
  return cleanText(brief.factory_code) || cleanText(sheet.owner_company_code);
}

async function handleQc(req, res, pool, sheetId) {
  const b = req.body || {};
  const qcResult = cleanText(b.qc_result);
  if (!requireOneOf(res, qcResult, ["pass", "fail"], "qc_result")) return;
  const operator = cleanText(b.qc_by) || actorId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sheet = await loadSheetForAction(client, sheetId);
    if (!sheet) { await client.query("ROLLBACK"); return sendError(res, 404, "not_found"); }
    if (sheet.status !== "factory_confirmed") { await client.query("ROLLBACK"); return statusConflict(res, sheet.status, "factory_confirmed"); }

    const brief = sheet.sample_brief && typeof sheet.sample_brief === "object" ? sheet.sample_brief : {};
    const factoryCode = factoryCodeOf(sheet);
    const orderContractNo = cleanText(sheet.contract_no) || cleanText(sheet.order_no) || `SAMPLE-${sheet.id}`;
    const qc = await client.query(
      `INSERT INTO qc_checks
         (order_contract_no, product_id, product_sku, batch_no, production_date,
          best_before, qty, qc_result, qc_date, qc_by, checklist, photos,
          fail_reason, entry_mode, factory_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10,
               $11::jsonb, $12::jsonb, $13, 'sample_delivery', $14)
       RETURNING *`,
      [
        orderContractNo,
        b.product_id ? parseInt(b.product_id, 10) : null,
        cleanText(b.product_sku) || cleanText(brief.sku),
        cleanText(b.batch_no),
        cleanText(b.production_date),
        cleanText(b.best_before),
        b.qty === undefined || b.qty === null || b.qty === "" ? 0 : b.qty,
        qcResult,
        cleanText(b.qc_date),
        operator,
        JSON.stringify(b.checklist || {}),
        JSON.stringify(b.photos || []),
        cleanText(b.fail_reason) || "",
        factoryCode,
      ]
    );

    const nextStatus = qcResult === "pass" ? "qc_passed" : "qc_failed";
    const qcNote = qcResult === "pass" ? "QC pass" : (cleanText(b.fail_reason) || "QC fail");
    await client.query(
      `UPDATE sample_delivery_sheets
          SET status = $1,
              qc_check_id = $2,
              qc_passed_at = CASE WHEN $1 = 'qc_passed' THEN NOW() ELSE NULL END,
              qc_note = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [nextStatus, qc.rows[0].id, qcNote, sheetId]
    );

    const task = await ensureTask(client, sheetId, "QC", `样品 QC · ${brief.product_name || sheetId}`, "录入样品 QC 结果", "HUMAN", operator, actorId(req));
    await completeTask(client, task.task_id);
    await logEvent(client, task.task_id, "QC_RESULT", sheet.status, nextStatus, actorId(req), qcNote, {
      sheet_id: sheetId,
      qc_check_id: qc.rows[0].id,
      qc_result: qcResult,
      factory_code: factoryCode,
    });

    if (qcResult === "pass") {
      await ensureTask(client, sheetId, "SHIPMENT", `样品寄出 · ${brief.product_name || sheetId}`, "登记快递公司与单号", "HUMAN", actorId(req), actorId(req));
    }

    await client.query("COMMIT");
    return res.status(200).json({ ok: true, data: { sheet_id: sheetId, status: nextStatus, qc_check: qc.rows[0] } });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function handleShip(req, res, pool, sheetId) {
  const b = req.body || {};
  const courier = cleanText(b.courier);
  const trackingNo = cleanText(b.tracking_no);
  if (!courier) return sendError(res, 400, "courier_required");
  if (!trackingNo) return sendError(res, 400, "tracking_no_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sheet = await loadSheetForAction(client, sheetId);
    if (!sheet) { await client.query("ROLLBACK"); return sendError(res, 404, "not_found"); }
    if (sheet.status !== "qc_passed") { await client.query("ROLLBACK"); return statusConflict(res, sheet.status, "qc_passed"); }

    await client.query(
      `UPDATE sample_delivery_sheets
          SET status = 'shipped',
              shipped_at = COALESCE($1::timestamptz, NOW()),
              tracking_no = $2,
              courier = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [cleanText(b.shipped_at), trackingNo, courier, sheetId]
    );

    const brief = sheet.sample_brief && typeof sheet.sample_brief === "object" ? sheet.sample_brief : {};
    const task = await ensureTask(client, sheetId, "SHIPMENT", `样品寄出 · ${brief.product_name || sheetId}`, "登记快递公司与单号", "HUMAN", actorId(req), actorId(req));
    await completeTask(client, task.task_id);
    await logEvent(client, task.task_id, "SAMPLE_SHIPPED", sheet.status, "shipped", actorId(req), `样品已寄出：${courier} ${trackingNo}`, {
      sheet_id: sheetId,
      courier,
      tracking_no: trackingNo,
    });
    await ensureTask(client, sheetId, "CUSTOMER_SIGN", `客户签收 · ${brief.product_name || sheetId}`, "登记客户签收状态", "HUMAN", actorId(req), actorId(req));

    await client.query("COMMIT");
    return res.status(200).json({ ok: true, data: { sheet_id: sheetId, status: "shipped", courier, tracking_no: trackingNo } });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function handleSign(req, res, pool, sheetId) {
  const b = req.body || {};
  const signedStatus = cleanText(b.signed_status);
  const signedType = cleanText(b.signed_type);
  if (!requireOneOf(res, signedStatus, ["signed", "partial", "rejected"], "signed_status")) return;
  if (signedType && !requireOneOf(res, signedType, ["self", "proxy", "electronic"], "signed_type")) return;
  const rating = b.rating === undefined || b.rating === null || b.rating === "" ? null : parseInt(b.rating, 10);
  if (rating !== null && (Number.isNaN(rating) || rating < 1 || rating > 5)) return sendError(res, 400, "invalid_rating", "rating must be 1-5");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sheet = await loadSheetForAction(client, sheetId);
    if (!sheet) { await client.query("ROLLBACK"); return sendError(res, 404, "not_found"); }
    if (sheet.status !== "shipped") { await client.query("ROLLBACK"); return statusConflict(res, sheet.status, "shipped"); }

    const finalStatus = signedStatus === "rejected" ? "rejected" : "signed";
    await client.query(
      `UPDATE sample_delivery_sheets
          SET status = $1,
              customer_signed_at = COALESCE($2::timestamptz, NOW()),
              customer_signed_status = $3,
              customer_signed_type = $4,
              customer_feedback = $5,
              customer_rating = $6,
              updated_at = NOW()
        WHERE id = $7`,
      [finalStatus, cleanText(b.signed_at), signedStatus, signedType, cleanText(b.feedback), rating, sheetId]
    );

    const brief = sheet.sample_brief && typeof sheet.sample_brief === "object" ? sheet.sample_brief : {};
    const task = await ensureTask(client, sheetId, "CUSTOMER_SIGN", `客户签收 · ${brief.product_name || sheetId}`, "登记客户签收状态", "HUMAN", actorId(req), actorId(req));
    await completeTask(client, task.task_id);
    await logEvent(client, task.task_id, "CUSTOMER_SIGN", sheet.status, finalStatus, actorId(req), `客户签收状态：${signedStatus}`, {
      sheet_id: sheetId,
      signed_status: signedStatus,
      signed_type: signedType,
      rating,
    });

    await client.query("COMMIT");
    return res.status(200).json({ ok: true, data: { sheet_id: sheetId, status: finalStatus, signed_status: signedStatus } });
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

  const role = roleFromAuth(req);
  if (!isInternalRole(role)) return sendError(res, 403, "admin_only");

  const pool = getPool();

  try {
    if (req.method === "GET") {
      const path = parseSamplePath(req);
      const id = path.id || (req.query?.id ? parseInt(req.query.id, 10) : null);

      if (id) {
        const { rows } = await pool.query(
          `SELECT s.*,
                  c.name_cn AS factory_name_cn,
                  c.name_en AS factory_name_en,
                  t.task_id, t.title AS current_task_title, t.workflow_node,
                  t.status AS task_status, t.due_at AS task_due_at,
                  EXISTS (
                    SELECT 1 FROM driver_assignments da
                     WHERE da.collab_sheet_table = 'sample_delivery_sheets'
                       AND da.collab_sheet_id = s.id
                       AND da.revoked_at IS NULL
                       AND da.expires_at > NOW()
                  ) AS has_active_link
             FROM sample_delivery_sheets s
             LEFT JOIN companies c ON c.code = COALESCE(s.sample_brief->>'factory_code', s.owner_company_code)
             LEFT JOIN LATERAL (
               SELECT task_id, title, workflow_node, status, due_at
                 FROM sample_workflow_tasks
                WHERE sample_sheet_id = s.id
                ORDER BY created_at DESC
                LIMIT 1
             ) t ON TRUE
            WHERE s.id = $1`,
          [id]
        );
        if (!rows.length) return sendError(res, 404, "not_found");

        const events = await pool.query(
          `SELECT e.event_id, e.task_id, e.event_type, e.from_status, e.to_status,
                  e.actor_type, e.actor_id, e.note, e.evidence_url, e.payload, e.created_at
             FROM sample_task_events e
             JOIN sample_workflow_tasks t ON t.task_id = e.task_id
            WHERE t.sample_sheet_id = $1
            ORDER BY e.created_at ASC`,
          [id]
        );
        return res.status(200).json({ ok: true, data: rows[0], events: events.rows });
      }

      const status = cleanText(req.query?.status);
      const limit = Math.min(parseInt(req.query?.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
      const vals = [];
      const where = [];
      if (status) {
        vals.push(status);
        where.push(`s.status = $${vals.length}`);
      }
      vals.push(limit);

      const { rows } = await pool.query(
        `SELECT s.id, s.order_id, s.order_no, s.contract_no, s.customer_code,
                s.owner_company_code, s.sample_brief->>'factory_code' AS factory_code,
                s.status, s.sample_brief, s.due_at,
                s.factory_capacity_ok, s.factory_schedule_date, s.factory_confirmed_at,
                s.qc_check_id, s.qc_passed_at, s.qc_note,
                s.shipped_at, s.tracking_no, s.courier,
                s.customer_signed_at, s.customer_signed_status, s.customer_signed_type,
                s.customer_feedback, s.customer_rating,
                s.created_at, s.updated_at,
                c.name_cn AS factory_name_cn,
                c.name_en AS factory_name_en,
                t.task_id, t.workflow_node, t.status AS task_status,
                EXISTS (
                  SELECT 1 FROM driver_assignments da
                   WHERE da.collab_sheet_table = 'sample_delivery_sheets'
                     AND da.collab_sheet_id = s.id
                     AND da.revoked_at IS NULL
                     AND da.expires_at > NOW()
                ) AS has_active_link
           FROM sample_delivery_sheets s
           LEFT JOIN companies c ON c.code = COALESCE(s.sample_brief->>'factory_code', s.owner_company_code)
           LEFT JOIN LATERAL (
             SELECT task_id, workflow_node, status
               FROM sample_workflow_tasks
              WHERE sample_sheet_id = s.id
              ORDER BY created_at DESC
              LIMIT 1
           ) t ON TRUE
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY s.created_at DESC
          LIMIT $${vals.length}`,
        vals
      );
      return res.status(200).json({ ok: true, data: rows });
    }

    if (req.method === "POST") {
      const path = parseSamplePath(req);
      if (path.id && path.action === "qc") return handleQc(req, res, pool, path.id);
      if (path.id && path.action === "ship") return handleShip(req, res, pool, path.id);
      if (path.id && path.action === "sign") return handleSign(req, res, pool, path.id);
      if (path.id) return sendError(res, 404, "unknown_sample_action");

      const b = req.body || {};
      const ownerCompanyCode = cleanText(b.owner_company_code);
      const factoryCode = cleanText(b.factory_code);
      const internalBudget = b.sample_brief && b.sample_brief.budget !== undefined && b.sample_brief.budget !== ""
        ? String(b.sample_brief.budget)
        : null;
      const sampleBrief = pickSampleBrief(b.sample_brief);
      const briefError = requireBrief(sampleBrief);

      if (!ownerCompanyCode) return sendError(res, 400, "owner_company_code_required");
      if (!factoryCode) return sendError(res, 400, "factory_code_required");
      if (briefError) return sendError(res, 400, briefError);
      const briefWithFactory = { ...sampleBrief, factory_code: factoryCode };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const factory = await client.query(
          `SELECT id, code, name_cn, name_en
             FROM companies
            WHERE code = $1
              AND (active IS DISTINCT FROM FALSE)
            LIMIT 1`,
          [factoryCode]
        );
        if (!factory.rows.length) {
          await client.query("ROLLBACK");
          return sendError(res, 400, "factory_code_not_found");
        }

        const sheet = await client.query(
          `INSERT INTO sample_delivery_sheets
             (order_no, contract_no, customer_code, owner_company_code,
              status, sample_brief, due_at, visible_note, admin_note)
           VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6, $7, $8)
           RETURNING id, status, order_no, contract_no, customer_code,
                     owner_company_code, sample_brief, due_at, created_at`,
          [
            cleanText(b.order_no),
            cleanText(b.contract_no),
            cleanText(b.customer_code),
            ownerCompanyCode,
            JSON.stringify(briefWithFactory),
            cleanText(b.due_at),
            sampleBrief.notes,
            internalBudget ? `budget:${internalBudget}` : null,
          ]
        );
        const sheetRow = sheet.rows[0];

        const task = await client.query(
          `INSERT INTO sample_workflow_tasks
             (title, description, sample_sheet_id, workflow_node, risk_level,
              status, owner_type, owner_id, due_at, created_by)
           VALUES ($1, $2, $3, 'FACTORY_CONFIRM', 'P3',
                   'NEW', 'factory', $4, $5, $6)
           RETURNING task_id, title, workflow_node, status, owner_type, owner_id, due_at`,
          [
            `样品产能确认 · ${sampleBrief.product_name}`,
            `请确认样品规格、数量与排期：${sampleBrief.spec} / ${sampleBrief.qty}${sampleBrief.unit}`,
            sheetRow.id,
            factoryCode,
            cleanText(b.due_at),
            (req.user && (req.user.username || req.user.uid)) || "admin",
          ]
        );
        const taskRow = task.rows[0];

        await client.query(
          `INSERT INTO sample_task_events
             (task_id, event_type, from_status, to_status, actor_type, actor_id, note, payload)
           VALUES ($1, 'created', NULL, 'draft', 'HUMAN', $2, $3, $4::jsonb)`,
          [
            taskRow.task_id,
            (req.user && (req.user.username || req.user.uid)) || "admin",
            "样品单已创建，等待工厂确认",
            JSON.stringify({ sheet_id: sheetRow.id, factory_code: factoryCode }),
          ]
        );

        await client.query("COMMIT");
        return res.status(201).json({
          ok: true,
          sheet_id: sheetRow.id,
          task_id: taskRow.task_id,
          data: { sheet: sheetRow, task: taskRow, factory: factory.rows[0] },
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[sample-sheets]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
