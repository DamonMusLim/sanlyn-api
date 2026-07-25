// api/db/trucking-fill.js  v2 — 协同共享表单
// 无 JWT，用 bl_token（能力令牌）授权整批次访问
//
// GET  ?bl_token=<token>
//   → 返回该批次所有 dispatch 行 + 车队司机列表
//
// POST { bl_token, section:"fleet", trucks:[{driver_id?,truck_plate,note?},...] }
//   → 批量 upsert 车队信息（可新增台数），写 fleet_submitted_at
//
// POST { bl_token, section:"factory", rows:[{dispatch_id, contract_no, seal_no, photos?, factory_note?}] }
//   → 更新工厂字段，写 factory_submitted_at（按 dispatch_id 逐行更新）
//
// POST { bl_token, section:"weight", dispatch_id, container_weight_kg, photos }
//   → 更新过磅，写 driver_submitted_at
//
// POST { bl_token, section:"arrive", dispatch_id }
//   → 司机到厂打卡，写 actual_arrive_at = NOW()

import { getPool, setCors } from "../db.js";
import { randomUUID } from "crypto";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── GET: 拿整批次数据 ────────────────────────────────────────────────────
  if (req.method === "GET") {
    const bl_token = req.query?.bl_token;

    // 旧模式兼容：?id=<dispatch_uuid>
    if (!bl_token && req.query?.id) {
      return legacyGet(req, res, pool);
    }

    if (!bl_token) return res.status(400).json({ success: false, error: "bl_token required" });

    try {
      // 所有该批次 dispatch 行
      const rows = await pool.query(`
        SELECT
          td.*,
          d.name       AS driver_name,
          d.phone      AS driver_phone,
          d.photo_url  AS driver_photo_url
        FROM trucking_dispatches td
        LEFT JOIN drivers d ON d.id = td.driver_id
        WHERE td.bl_token = $1
        ORDER BY td.created_at
      `, [bl_token]);

      if (!rows.rows.length) {
        return res.status(404).json({ success: false, error: "token invalid or expired" });
      }

      const first = rows.rows[0];

      // 同车队的所有司机
      let fleetDrivers = [];
      if (first.trucking_co) {
        const dr = await pool.query(`
          SELECT id, name, phone, truck_plate, photo_url
          FROM drivers WHERE trucking_co = $1 AND is_active = true ORDER BY name
        `, [first.trucking_co]);
        fleetDrivers = dr.rows;
      }

      return res.status(200).json({
        success: true,
        meta: {
          bl_no: first.bl_no,
          order_no: first.order_no,
          container_no: first.container_no,
          loading_time: first.loading_time,
          loading_addr: first.loading_addr,
          trucking_co: first.trucking_co,
        },
        dispatches: rows.rows,
        fleetDrivers,
      });
    } catch (err) {
      console.error("[trucking-fill v2 GET]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST ────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const bl_token = body.bl_token;

    // 旧模式兼容
    if (!bl_token && body.id) {
      return legacyPost(req, res, pool, body);
    }

    if (!bl_token) return res.status(400).json({ success: false, error: "bl_token required" });

    // 先拿 anchor（第一行，拿 BL 基础信息）
    const anchor = await pool.query(
      `SELECT * FROM trucking_dispatches WHERE bl_token = $1 ORDER BY created_at LIMIT 1`,
      [bl_token]
    );
    if (!anchor.rows.length) {
      return res.status(404).json({ success: false, error: "token invalid" });
    }
    const base = anchor.rows[0];

    try {
      const { section } = body;

      // ── 车队提交：批量 upsert 司机 + 车牌 ─────────────────────────────
      if (section === "fleet") {
        const trucks = body.trucks || [];
        if (!trucks.length) return res.status(400).json({ success: false, error: "trucks required" });

        // 拿现有行
        const existing = await pool.query(
          `SELECT id FROM trucking_dispatches WHERE bl_token = $1 ORDER BY created_at`,
          [bl_token]
        );
        const existIds = existing.rows.map(r => r.id);

        const results = [];
        for (let i = 0; i < trucks.length; i++) {
          const t = trucks[i];
          const dispatchId = existIds[i] || randomUUID();
          const isNew = !existIds[i];

          if (isNew) {
            // INSERT 新台
            await pool.query(`
              INSERT INTO trucking_dispatches
                (id, bl_token, bl_no, order_no, container_no, trucking_co,
                 loading_time, loading_addr, pickup_depot, drop_depot,
                 container_type, container_weight_kg, seal_no,
                 driver_id, truck_plate, driver_name_override, driver_phone_override,
                 fleet_submitted_at, status, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),'fleet_confirmed',NOW(),NOW())
            `, [
              dispatchId, bl_token, base.bl_no, base.order_no, base.container_no, base.trucking_co,
              base.loading_time, base.loading_addr, base.pickup_depot, base.drop_depot,
              base.container_type, base.container_weight_kg, base.seal_no,
              t.driver_id || null, t.truck_plate || null,
              t.driver_name || null, t.driver_phone || null,
            ]);
          } else {
            // UPDATE 现有行
            await pool.query(`
              UPDATE trucking_dispatches SET
                driver_id             = $1,
                truck_plate           = $2,
                driver_name_override  = $3,
                driver_phone_override = $4,
                fleet_submitted_at    = NOW(),
                status                = 'fleet_confirmed',
                updated_at            = NOW()
              WHERE id = $5
            `, [t.driver_id || null, t.truck_plate || null,
               t.driver_name || null, t.driver_phone || null, dispatchId]);
          }
          results.push(dispatchId);
        }
        return res.status(200).json({ success: true, dispatch_ids: results });
      }

      // ── 工厂提交：按 dispatch_id 逐行更新合同号 + 封签 + 照片 ─────────
      if (section === "factory") {
        const rows = body.rows || [];
        if (!rows.length) return res.status(400).json({ success: false, error: "rows required" });

        for (const row of rows) {
          const sets = [], vals = [];
          if (row.contract_no !== undefined) { sets.push(`contract_no = $${vals.length+1}`); vals.push(row.contract_no || null); }
          if (row.seal_no !== undefined)     { sets.push(`seal_no = $${vals.length+1}`);     vals.push(row.seal_no || null); }
          if (row.factory_note !== undefined){ sets.push(`factory_note = $${vals.length+1}`);vals.push(row.factory_note || null); }
          if (row.photos && row.photos.length > 0) {
            sets.push(`photos = (SELECT COALESCE(photos,'[]'::jsonb) || $${vals.length+1}::jsonb FROM trucking_dispatches WHERE id = $${vals.length+2})`);
            vals.push(JSON.stringify(row.photos)); vals.push(row.dispatch_id);
          }
          sets.push(`factory_submitted_at = NOW()`);
          sets.push(`status = 'factory_loaded'`);
          sets.push(`updated_at = NOW()`);
          vals.push(row.dispatch_id);
          await pool.query(
            `UPDATE trucking_dispatches SET ${sets.join(', ')} WHERE id = $${vals.length} AND bl_token = $${vals.length+1}`,
            [...vals, bl_token]
          );
        }
        return res.status(200).json({ success: true });
      }

      // ── 时间协调：工厂报就绪时间 / 车队报到厂时间 / 双方确认 ─────────
      if (section === "time") {
        const { role, time, confirm } = body;
        if (!role) return res.status(400).json({ success: false, error: "role required" });

        if (time) {
          // 设置时间 → 重置双方确认状态
          const field = role === "factory" ? "factory_ready_time" : "fleet_eta";
          await pool.query(
            `UPDATE trucking_dispatches SET ${field} = $1, factory_time_confirmed = false, fleet_time_confirmed = false, updated_at = NOW() WHERE bl_token = $2`,
            [time, bl_token]
          );
        }

        if (confirm === true) {
          const field = role === "factory" ? "factory_time_confirmed" : "fleet_time_confirmed";
          await pool.query(
            `UPDATE trucking_dispatches SET ${field} = true, updated_at = NOW() WHERE bl_token = $1`,
            [bl_token]
          );
          // 两方都确认 → 锁定 agreed_loading_time = max(factory_ready, fleet_eta)
          const chk = await pool.query(
            `SELECT factory_ready_time, fleet_eta, factory_time_confirmed, fleet_time_confirmed FROM trucking_dispatches WHERE bl_token = $1 LIMIT 1`,
            [bl_token]
          );
          const r = chk.rows[0];
          if (r.factory_time_confirmed && r.fleet_time_confirmed && r.factory_ready_time && r.fleet_eta) {
            const agreed = r.factory_ready_time >= r.fleet_eta ? r.factory_ready_time : r.fleet_eta;
            await pool.query(
              `UPDATE trucking_dispatches SET agreed_loading_time = $1, updated_at = NOW() WHERE bl_token = $2`,
              [agreed, bl_token]
            );
          }
        }

        return res.status(200).json({ success: true });
      }

      // ── 司机到厂打卡 ──────────────────────────────────────────────────
      if (section === "arrive") {
        const { dispatch_id } = body;
        await pool.query(
          `UPDATE trucking_dispatches SET actual_arrive_at = NOW(), updated_at = NOW() WHERE id = $1 AND bl_token = $2`,
          [dispatch_id, bl_token]
        );
        return res.status(200).json({ success: true });
      }

      // ── 过磅提交 ──────────────────────────────────────────────────────
      if (section === "weight") {
        const { dispatch_id, container_weight_kg, photos } = body;
        const sets = [], vals = [];
        if (container_weight_kg) { sets.push(`container_weight_kg = $${vals.length+1}`); vals.push(parseInt(container_weight_kg, 10)); }
        if (photos && photos.length > 0) {
          sets.push(`photos = (SELECT COALESCE(photos,'[]'::jsonb) || $${vals.length+1}::jsonb FROM trucking_dispatches WHERE id = $${vals.length+2})`);
          vals.push(JSON.stringify(photos)); vals.push(dispatch_id);
        }
        sets.push(`driver_submitted_at = NOW()`);
        sets.push(`status = 'done'`);
        sets.push(`updated_at = NOW()`);
        vals.push(dispatch_id);
        await pool.query(
          `UPDATE trucking_dispatches SET ${sets.join(', ')} WHERE id = $${vals.length} AND bl_token = $${vals.length+1}`,
          [...vals, bl_token]
        );
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ success: false, error: "unknown section" });

    } catch (err) {
      console.error("[trucking-fill v2 POST]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "method not allowed" });
}

// ── 旧版单台 dispatch_id 兼容 ─────────────────────────────────────────────
async function legacyGet(req, res, pool) {
  const id = req.query.id;
  try {
    const r = await pool.query(`
      SELECT td.*, d.name AS driver_name, d.phone AS driver_phone, d.photo_url AS driver_photo_url
      FROM trucking_dispatches td LEFT JOIN drivers d ON d.id = td.driver_id WHERE td.id = $1
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "dispatch not found" });
    const dispatch = r.rows[0];
    let fleetDrivers = [];
    if (dispatch.trucking_co) {
      const dr = await pool.query(`SELECT id,name,phone,truck_plate,photo_url FROM drivers WHERE trucking_co=$1 AND is_active=true ORDER BY name`, [dispatch.trucking_co]);
      fleetDrivers = dr.rows;
    }
    return res.status(200).json({ success: true, data: dispatch, fleetDrivers });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}

async function legacyPost(req, res, pool, body) {
  const { id, add_truck, ...rest } = body;
  try {
    if (add_truck) {
      const orig = await pool.query(`SELECT * FROM trucking_dispatches WHERE id=$1`, [id]);
      if (!orig.rows.length) return res.status(404).json({ success: false, error: "not found" });
      const o = orig.rows[0];
      const newId = randomUUID();
      await pool.query(`
        INSERT INTO trucking_dispatches (id,order_no,bl_no,container_no,trucking_co,loading_time,loading_addr,pickup_depot,drop_depot,container_type,container_weight_kg,seal_no,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NOW(),NOW())
      `, [newId,o.order_no,o.bl_no,o.container_no,o.trucking_co,o.loading_time,o.loading_addr,o.pickup_depot,o.drop_depot,o.container_type,o.container_weight_kg,o.seal_no]);
      return res.status(201).json({ success: true, new_dispatch_id: newId });
    }
    const check = await pool.query(`SELECT driver_submitted_at FROM trucking_dispatches WHERE id=$1`, [id]);
    if (!check.rows.length) return res.status(404).json({ success: false, error: "not found" });
    if (check.rows[0].driver_submitted_at) return res.status(409).json({ success: false, error: "already_submitted", message: "该记录已提交" });
    const sets = [], vals = [];
    if (rest.driver_id)               { sets.push(`driver_id=$${vals.length+1}`);              vals.push(rest.driver_id); }
    if (rest.truck_plate!==undefined) { sets.push(`truck_plate=$${vals.length+1}`);            vals.push(rest.truck_plate||null); }
    if (rest.seal_no!==undefined)     { sets.push(`seal_no=$${vals.length+1}`);                vals.push(rest.seal_no||null); }
    if (rest.container_weight_kg!==undefined) { sets.push(`container_weight_kg=$${vals.length+1}`); vals.push(rest.container_weight_kg?parseInt(rest.container_weight_kg,10):null); }
    if (rest.photos?.length>0) { sets.push(`photos=(SELECT COALESCE(photos,'[]'::jsonb)||$${vals.length+1}::jsonb FROM trucking_dispatches WHERE id=$${vals.length+2})`); vals.push(JSON.stringify(rest.photos)); vals.push(id); }
    if (rest.status) { sets.push(`status=$${vals.length+1}`); vals.push(rest.status); }
    sets.push(`driver_submitted_at=$${vals.length+1}`); vals.push(rest.driver_submitted_at||new Date().toISOString());
    sets.push(`updated_at=NOW()`); vals.push(id);
    const sql = `UPDATE trucking_dispatches SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`;
    const result = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
