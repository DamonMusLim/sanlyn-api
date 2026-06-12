// api/partner-portal-collab.js — Full collab portal: 6 roles + event stream
// Roles: factory | trucker | customs | carrier | customer_quote | customer_shipment
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";

const UPLOAD_DIR = "/opt/sanlyn-web/uploads";
const BASE_URL   = "https://damon.sanlyn.cn";
const MAX_BODY   = 10 * 1024 * 1024; // 10 MB

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw Object.assign(new Error("too_large"), { code: "PAYLOAD_TOO_LARGE" });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error("bad_json"), { code: "INVALID_JSON" }); }
}

async function emitEvent(pool, cardId, type, actorRole, actorToken, payload) {
  pool.query(
    "INSERT INTO collab_events(card_id,event_type,actor_role,actor_token,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
    [cardId, type, actorRole, actorToken ? String(actorToken) : null, JSON.stringify(payload || {})]
  ).catch(e => console.error("[collab-event]", e.message));
}

async function ensureThread(pool, cardId, contractNo) {
  const tid = `collab-card-${cardId}`;
  await pool.query(
    `INSERT INTO collaboration_threads(id,task_id,owner_object_type,owner_object_id,owner_object_label,status,created_by)
     VALUES($1,$1,'logistics',$2,$3,'open','system') ON CONFLICT(id) DO NOTHING`,
    [tid, String(cardId), contractNo || `Card #${cardId}`]
  );
  return tid;
}

// ─────────────────────────────────────────────
// Load full card row (all joined tables)
// ─────────────────────────────────────────────
export async function loadCard(pool, cardId) {
  if (!cardId) return null;
  const { rows } = await pool.query(`
    SELECT sc.*,
           tr.id AS tr_id, tr.truck_no, tr.driver_name, tr.driver_phone,
           tr.pickup_at, tr.port_arrival_at, tr.confirmed_at AS truck_confirmed_at, tr.note AS truck_note,
           so.id AS so_record_id, so.so_no, so.container_no AS so_container,
           so.seal_no AS so_seal, so.items AS so_items,
           so.gross_weight_kg AS so_gw, so.total_cartons AS so_cartons,
           so.port_of_loading, so.port_of_discharge, so.generated_at AS so_generated_at,
           cr.id AS cr_id, cr.vessel_name, cr.voyage_no, cr.etd, cr.eta, cr.bl_no,
           cr.release_doc_url, cr.released_at, cr.ocean_unlocked_at,
           lcs.loading  AS factory_loading,
           lcs.photos   AS factory_photos,
           lcs.status   AS factory_status,
           lcs.submitted_at AS factory_submitted_at,
           lcs.products AS factory_products
    FROM collab_shipment_cards sc
    LEFT JOIN collab_truck_records   tr ON tr.id = sc.truck_record_id
    LEFT JOIN collab_so_records      so ON so.id = sc.so_id
    LEFT JOIN collab_carrier_records cr ON cr.id = sc.carrier_record_id
    LEFT JOIN loading_collab_sheets lcs ON lcs.id = sc.sheet_id
    WHERE sc.id = $1
  `, [cardId]);
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// Project card by role (strict whitelist)
// ─────────────────────────────────────────────
export function projectCard(card, role) {
  if (!card) return null;
  const base = {
    id: card.id, order_no: card.order_no, contract_no: card.contract_no,
    stage: card.stage, trade_terms: card.trade_terms,
    route: (card.pol && card.pod) ? `${card.pol} → ${card.pod}` : null,
    pol: card.pol, pod: card.pod,
    products: card.products || card.factory_products || [],
  };

  switch (role) {
    case "factory":
      return { ...base,
        sheet_id: card.sheet_id,
        factory_loading: card.factory_loading || {},
        factory_photos: Array.isArray(card.factory_photos) ? card.factory_photos : [],
        factory_status: card.factory_status,
        factory_submitted_at: card.factory_submitted_at,
        factory_note: card.factory_note,
        // SO summary (read-only)
        so_no: card.so_no || null,
      };

    case "trucker":
      return { ...base,
        // Read from factory sheet
        container_no: card.factory_loading?.container_no || null,
        seal_no:      card.factory_loading?.seal_no || null,
        gross_weight_kg: card.factory_loading?.gross_weight_kg || null,
        total_cartons:   card.factory_loading?.total_cartons || null,
        factory_submitted: !!card.factory_submitted_at,
        // Truck fill fields
        truck_no: card.truck_no || null, driver_name: card.driver_name || null,
        driver_phone: card.driver_phone || null, truck_note: card.truck_note || null,
        pickup_at: card.pickup_at || null, port_arrival_at: card.port_arrival_at || null,
        truck_confirmed_at: card.truck_confirmed_at || null,
        so_no: card.so_no || null,
      };

    case "customs":
      return { ...base,
        so_available: !!card.so_record_id,
        so_no: card.so_no || null, so_generated_at: card.so_generated_at || null,
        container_no: card.so_container || card.factory_loading?.container_no || null,
        seal_no:      card.so_seal     || card.factory_loading?.seal_no      || null,
        so_items:     card.so_items    || card.products || [],
        gross_weight_kg: card.so_gw    || card.factory_loading?.gross_weight_kg || null,
        total_cartons:   card.so_cartons || card.factory_loading?.total_cartons || null,
        port_of_loading:    card.port_of_loading    || card.pol || null,
        port_of_discharge:  card.port_of_discharge  || card.pod || null,
        release_doc_url: card.release_doc_url || null,
        released_at: card.released_at || null,
      };

    case "carrier":
      return { ...base,
        container_no:  card.so_container || card.factory_loading?.container_no || null,
        seal_no:       card.so_seal      || card.factory_loading?.seal_no      || null,
        ocean_available: !!card.released_at,
        vessel_name: card.vessel_name || null, voyage_no: card.voyage_no || null,
        etd: card.etd || null, eta: card.eta || null, bl_no: card.bl_no || null,
        release_doc_url: card.release_doc_url || null, released_at: card.released_at || null,
        ocean_unlocked_at: card.ocean_unlocked_at || null,
      };

    case "customer_quote":
      return { ...base,
        vessel_name: card.vessel_name || null,
        etd: card.etd || null, eta: card.eta || null,
        customer_note: card.customer_note || null,
      };

    case "customer_shipment":
      return { ...base,
        so_no: card.so_no || null,
        container_no: card.so_container || null, seal_no: card.so_seal || null,
        vessel_name: card.vessel_name || null, voyage_no: card.voyage_no || null,
        etd: card.etd || null, eta: card.eta || null, bl_no: card.bl_no || null,
        released_at: card.released_at || null, ocean_unlocked_at: card.ocean_unlocked_at || null,
        so_generated_at: card.so_generated_at || null,
      };

    default: return base;
  }
}

// ─────────────────────────────────────────────
// Main collab route handler
// ─────────────────────────────────────────────
export async function handleCollab(pool, party, subpath, req, res) {
  const role   = party.role || party.party_type;
  const cardId = party.card_id;

  // ── GET card ──────────────────────────────
  if (req.method === "GET" && subpath === "card") {
    const card = await loadCard(pool, cardId);
    if (!card) { res.writeHead(404); return res.end(JSON.stringify({ error: "card_not_found" })); }
    const tid = await ensureThread(pool, card.id, card.contract_no);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      success: true, role,
      card: projectCard(card, role),
      thread_id: tid,
      party: { name_cn: party.name_cn, contact_name: party.contact_name },
    }));
  }

  // ── GET messages ──────────────────────────
  if (req.method === "GET" && subpath === "messages") {
    if (!cardId) { res.writeHead(400); return res.end(JSON.stringify({ error: "no_card" })); }
    const tid = `collab-card-${cardId}`;
    const { rows } = await pool.query(
      "SELECT id,author,author_role,body,kind,created_at FROM collaboration_messages WHERE thread_id=$1 ORDER BY created_at ASC LIMIT 100",
      [tid]
    );
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, messages: rows }));
  }

  // ── POST messages ─────────────────────────
  if (req.method === "POST" && subpath === "messages") {
    if (!cardId) { res.writeHead(400); return res.end(JSON.stringify({ error: "no_card" })); }
    const body = req.body || await readBody(req);
    const text = (body.text || "").trim().slice(0, 1000);
    if (!text) { res.writeHead(400); return res.end(JSON.stringify({ error: "text required" })); }
    const card = await loadCard(pool, cardId);
    const tid  = await ensureThread(pool, cardId, card?.contract_no);
    const mid  = randomUUID().replace(/-/g,'');
    const author = party.contact_name || party.name_cn || role;
    await pool.query(
      "INSERT INTO collaboration_messages(id,thread_id,author,author_role,body,kind,created_at) VALUES($1,$2,$3,$4,$5,'text',NOW())",
      [mid, tid, author, role, text]
    );
    pool.query("UPDATE collaboration_threads SET last_message_at=NOW() WHERE id=$1", [tid]).catch(() => {});
    await emitEvent(pool, cardId, "MESSAGE_ADDED", role, party.token, {});
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, id: mid }));
  }

  // ── PATCH truck data ──────────────────────
  if (req.method === "PATCH" && subpath === "truck") {
    if (role !== "trucker") { res.writeHead(403); return res.end(JSON.stringify({ error: "trucker only" })); }
    const body = req.body || await readBody(req);
    const { rows: cRows } = await pool.query("SELECT truck_record_id FROM collab_shipment_cards WHERE id=$1", [cardId]);
    if (!cRows.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not found" })); }
    let tid = cRows[0].truck_record_id;
    const f = (v) => v !== undefined ? v || null : undefined;
    if (!tid) {
      const { rows: ins } = await pool.query(
        "INSERT INTO collab_truck_records(card_id,truck_no,driver_name,driver_phone,pickup_at,port_arrival_at,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [cardId, f(body.truck_no), f(body.driver_name), f(body.driver_phone), f(body.pickup_at), f(body.port_arrival_at), f(body.note)]
      );
      tid = ins[0].id;
      await pool.query("UPDATE collab_shipment_cards SET truck_record_id=$1,updated_at=NOW() WHERE id=$2", [tid, cardId]);
    } else {
      const sets = []; const vals = []; let i = 1;
      for (const [k, v] of Object.entries({ truck_no: body.truck_no, driver_name: body.driver_name,
          driver_phone: body.driver_phone, pickup_at: body.pickup_at,
          port_arrival_at: body.port_arrival_at, note: body.note })) {
        if (v !== undefined) { sets.push(`${k}=$${i++}`); vals.push(v || null); }
      }
      if (sets.length) { sets.push("updated_at=NOW()"); vals.push(tid);
        await pool.query(`UPDATE collab_truck_records SET ${sets.join(",")} WHERE id=$${i}`, vals); }
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true }));
  }

  // ── POST truck/confirm → generate SO ─────
  if (req.method === "POST" && subpath === "truck/confirm") {
    if (role !== "trucker") { res.writeHead(403); return res.end(JSON.stringify({ error: "trucker only" })); }
    const card = await loadCard(pool, cardId);
    if (!card) { res.writeHead(404); return res.end(JSON.stringify({ error: "not found" })); }
    if (!card.factory_submitted_at) {
      res.writeHead(409); return res.end(JSON.stringify({ error: "factory_not_submitted" }));
    }
    // Mark truck confirmed
    if (card.truck_record_id) {
      await pool.query("UPDATE collab_truck_records SET confirmed_at=NOW(),updated_at=NOW() WHERE id=$1", [card.truck_record_id]);
    }
    // Generate SO
    if (!card.so_record_id) {
      const soNo = "SO-" + (card.contract_no || card.id) + "-" + Date.now().toString(36).toUpperCase();
      const ld = card.factory_loading || {};
      const { rows: soR } = await pool.query(
        `INSERT INTO collab_so_records(card_id,so_no,container_no,seal_no,items,gross_weight_kg,total_cbm,total_cartons,port_of_loading,port_of_discharge)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING id`,
        [cardId, soNo, ld.container_no||null, ld.seal_no||null,
         JSON.stringify(card.products||[]),
         ld.gross_weight_kg||null, ld.total_cbm||null, ld.total_cartons||null,
         card.pol||null, card.pod||null]
      );
      await pool.query(
        "UPDATE collab_shipment_cards SET so_id=$1,stage='so_created',updated_at=NOW() WHERE id=$2",
        [soR[0].id, cardId]
      );
      await emitEvent(pool, cardId, "SO_CREATED",       role, party.token, { so_no: soNo });
      await emitEvent(pool, cardId, "TRUCK_CONFIRMED",  role, party.token, {});
      // Auto-post thread message
      await ensureThread(pool, cardId, card.contract_no);
      const mid2 = randomUUID().replace(/-/g,'');
      await pool.query(
        "INSERT INTO collaboration_messages(id,thread_id,author,author_role,body,kind,created_at) VALUES($1,$2,'system','system',$3,'event',NOW())",
        [mid2, `collab-card-${cardId}`, `SO已生成: ${soNo}`]
      );
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, stage: "so_created" }));
  }

  // ── PATCH carrier vessel ──────────────────
  if (req.method === "PATCH" && subpath === "carrier") {
    if (role !== "carrier") { res.writeHead(403); return res.end(JSON.stringify({ error: "carrier only" })); }
    const body = req.body || await readBody(req);
    const { rows: cRows } = await pool.query("SELECT carrier_record_id FROM collab_shipment_cards WHERE id=$1", [cardId]);
    if (!cRows.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "not found" })); }
    let cid = cRows[0].carrier_record_id;
    if (!cid) {
      const { rows: ins } = await pool.query(
        "INSERT INTO collab_carrier_records(card_id,vessel_name,voyage_no,etd,eta,bl_no) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [cardId, body.vessel_name||null, body.voyage_no||null, body.etd||null, body.eta||null, body.bl_no||null]
      );
      cid = ins[0].id;
      await pool.query("UPDATE collab_shipment_cards SET carrier_record_id=$1,updated_at=NOW() WHERE id=$2", [cid, cardId]);
    } else {
      const sets = []; const vals = []; let i = 1;
      for (const [k,v] of Object.entries({vessel_name:body.vessel_name,voyage_no:body.voyage_no,etd:body.etd,eta:body.eta,bl_no:body.bl_no})) {
        if (v !== undefined) { sets.push(`${k}=$${i++}`); vals.push(v||null); }
      }
      if (sets.length) { sets.push("updated_at=NOW()"); vals.push(cid);
        await pool.query(`UPDATE collab_carrier_records SET ${sets.join(",")} WHERE id=$${i}`, vals); }
    }
    await emitEvent(pool, cardId, "VESSEL_UPDATED", role, party.token, { vessel_name: body.vessel_name });
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true }));
  }

  // ── POST customs/release ─────────────────
  if (req.method === "POST" && subpath === "customs/release") {
    if (role !== "customs") { res.writeHead(403); return res.end(JSON.stringify({ error: "customs only" })); }
    const body = req.body || await readBody(req);
    const { data: b64, ext: rawExt } = body || {};
    if (!b64) { res.writeHead(400); return res.end(JSON.stringify({ error: "data required (base64)" })); }
    const ext = (rawExt||"pdf").replace(/[^a-z0-9]/g,"").slice(0,4)||"pdf";
    await mkdir(UPLOAD_DIR, { recursive: true });
    const fname = randomUUID().replace(/-/g,'') + "." + ext;
    await writeFile(`${UPLOAD_DIR}/${fname}`, Buffer.from(b64.replace(/^data:[^;]+;base64,/,""),"base64"));
    const url = `${BASE_URL}/uploads/${fname}`;
    const { rows: cRows } = await pool.query("SELECT carrier_record_id FROM collab_shipment_cards WHERE id=$1", [cardId]);
    let cid = cRows[0]?.carrier_record_id;
    if (!cid) {
      const { rows: ins } = await pool.query(
        "INSERT INTO collab_carrier_records(card_id,release_doc_url,released_at) VALUES($1,$2,NOW()) RETURNING id",
        [cardId, url]
      );
      cid = ins[0].id;
      await pool.query("UPDATE collab_shipment_cards SET carrier_record_id=$1,stage='customs_cleared',updated_at=NOW() WHERE id=$2", [cid, cardId]);
    } else {
      await pool.query("UPDATE collab_carrier_records SET release_doc_url=$1,released_at=NOW(),updated_at=NOW() WHERE id=$2", [url, cid]);
      await pool.query("UPDATE collab_shipment_cards SET stage='customs_cleared',updated_at=NOW() WHERE id=$1", [cardId]);
    }
    await emitEvent(pool, cardId, "CUSTOMS_RELEASED", role, party.token, { url });
    await emitEvent(pool, cardId, "OCEAN_UNLOCKED",   role, party.token, {});
    // Thread notification
    await ensureThread(pool, cardId, null);
    await pool.query(
      "INSERT INTO collaboration_messages(id,thread_id,author,author_role,body,kind,created_at) VALUES($1,$2,'system','system',$3,'event',NOW())",
      [randomUUID().replace(/-/g,''), `collab-card-${cardId}`, "放行单已上传，海运已解锁"]
    );
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, url, stage: "customs_cleared" }));
  }

  // ── POST upload-doc (generic) ─────────────
  if (req.method === "POST" && subpath === "upload-doc") {
    const body = req.body || await readBody(req);
    const { data: b64, ext: rawExt } = body || {};
    if (!b64) { res.writeHead(400); return res.end(JSON.stringify({ error: "data required" })); }
    const ext = (rawExt||"pdf").replace(/[^a-z0-9]/g,"").slice(0,4)||"pdf";
    await mkdir(UPLOAD_DIR, { recursive: true });
    const fname = randomUUID().replace(/-/g,'') + "." + ext;
    await writeFile(`${UPLOAD_DIR}/${fname}`, Buffer.from(b64.replace(/^data:[^;]+;base64,/,""),"base64"));
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, url: `${BASE_URL}/uploads/${fname}` }));
  }

  return null; // not handled — caller should 405
}
