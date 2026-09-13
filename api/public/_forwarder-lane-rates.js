import { rateColumn } from "./_container-type.js";

async function findRate(client, line) {
  var col = rateColumn(line.container_type);
  var colFilter = col ? `AND fr.${col} IS NOT NULL` : "";
  const { rows } = await client.query(
    `SELECT id
       FROM freight_rates fr
      WHERE fr.forwarder_company_id = $1
        AND COALESCE(fr.carrier, '') = COALESCE($2, '')
        AND lower(btrim(fr.pol)) = lower(btrim($3))
        AND lower(btrim(fr.pod)) = lower(btrim($4))
        AND fr.source = 'portal_quote'
        ${colFilter}
        AND COALESCE(fr.sail_date::date::text, '') = COALESCE($5::text, '')
      ORDER BY fr.updated_at DESC NULLS LAST, fr.id DESC
      LIMIT 1
      FOR UPDATE`,
    [line.forwarder_company_id, line.carrier, line.pol, line.pod, line.etd]
  );
  return rows[0] ? rows[0].id : null;
}

async function expireOverlaps(client, line, keepId) {
  var col = rateColumn(line.container_type);
  var colFilter = col ? `AND freight_rates.${col} IS NOT NULL` : "";
  await client.query(
    `UPDATE freight_rates
        SET status = 'expired', updated_at = now()
      WHERE freight_rates.forwarder_company_id = $1
        AND COALESCE(freight_rates.carrier, '') = COALESCE($2, '')
        AND lower(btrim(freight_rates.pol)) = lower(btrim($3))
        AND lower(btrim(freight_rates.pod)) = lower(btrim($4))
        AND freight_rates.source = 'portal_quote'
        ${colFilter}
        AND freight_rates.status = 'active'
        AND COALESCE(freight_rates.sail_date::date::text, '') = COALESCE($5::text, '')
        AND ($6::int IS NULL OR freight_rates.id <> $6)`,
    [line.forwarder_company_id, line.carrier, line.pol, line.pod, line.etd, keepId]
  );
}

async function upsertRateBox(client, rateId, line) {
  await client.query(
    `INSERT INTO freight_rate_boxes
       (rate_id, container_type, cost, customer_price, remarks)
     VALUES ($1, $2, $3, NULL, NULL)
     ON CONFLICT (rate_id, container_type)
     DO UPDATE SET cost = EXCLUDED.cost, updated_at = now()`,
    [rateId, line.container_type, line.unguaranteed_usd]
  );
}

function rateRaw(line, rfqItemId, code) {
  return {
    rfq_item_id: rfqItemId,
    submitted_by_portal_code: code,
    forwarder_company_code: line.forwarder_company_code,
    week_idx: line.week_idx,
    week_from: line.week_from,
    week_to: line.week_to,
    etd: line.etd,
    vessel: line.vessel,
    voyage: line.voyage,
    guaranteed_usd: line.guaranteed_usd,
    penalty_cny: line.penalty_cny,
    deposit_cny: line.deposit_cny,
  };
}

async function updateRateBase(client, rateId, line, raw) {
  const upd = await client.query(
    `UPDATE freight_rates
        SET forwarder = $2,
            carrier = $3,
            pol = $4,
            pod = $5,
            valid_from = $6,
            valid_to = $7,
            sail_date = $8::date,
            vessel_name = $9,
            voyage_no = $10,
            transit_days = $11,
            status = 'active',
            source = 'portal_quote',
            raw = COALESCE(raw, '{}'::jsonb) || $12::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [
      rateId,
      line.forwarder_name,
      line.carrier,
      line.pol,
      line.pod,
      line.valid_from,
      line.valid_to,
      line.etd,
      line.vessel,
      line.voyage,
      line.transit_days,
      JSON.stringify(raw),
    ]
  );
  return upd.rows[0].id;
}

async function insertRateBase(client, line, raw) {
  const ins = await client.query(
    `INSERT INTO freight_rates
       (forwarder_company_id, forwarder, carrier, pol, pod,
        valid_from, valid_to, sail_date, vessel_name, voyage_no, transit_days,
        status, source, raw, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,'active','portal_quote',$12::jsonb,now(),now())
     RETURNING id`,
    [
      line.forwarder_company_id,
      line.forwarder_name,
      line.carrier,
      line.pol,
      line.pod,
      line.valid_from,
      line.valid_to,
      line.etd,
      line.vessel,
      line.voyage,
      line.transit_days,
      JSON.stringify(raw),
    ]
  );
  return ins.rows[0].id;
}

function pairedReset(col) {
  if (col === "gp20") return ", hq40 = NULL";
  if (col === "hq40") return ", gp20 = NULL";
  return "";
}

async function updateRateColumn(client, rateId, line, raw, col) {
  const upd = await client.query(
    `UPDATE freight_rates
        SET forwarder = $2,
            carrier = $3,
            pol = $4,
            pod = $5,
            ${col} = $6${pairedReset(col)},
            valid_from = $7,
            valid_to = $8,
            sail_date = $9::date,
            vessel_name = $10,
            voyage_no = $11,
            transit_days = $12,
            status = 'active',
            source = 'portal_quote',
            raw = COALESCE(raw, '{}'::jsonb) || $13::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [
      rateId,
      line.forwarder_name,
      line.carrier,
      line.pol,
      line.pod,
      line.unguaranteed_usd,
      line.valid_from,
      line.valid_to,
      line.etd,
      line.vessel,
      line.voyage,
      line.transit_days,
      JSON.stringify(raw),
    ]
  );
  return upd.rows[0].id;
}

async function insertRateColumn(client, line, raw, col) {
  const ins = await client.query(
    `INSERT INTO freight_rates
       (forwarder_company_id, forwarder, carrier, pol, pod, ${col},
        valid_from, valid_to, sail_date, vessel_name, voyage_no, transit_days,
        status, source, raw, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,'active','portal_quote',$13::jsonb,now(),now())
     RETURNING id`,
    [
      line.forwarder_company_id,
      line.forwarder_name,
      line.carrier,
      line.pol,
      line.pod,
      line.unguaranteed_usd,
      line.valid_from,
      line.valid_to,
      line.etd,
      line.vessel,
      line.voyage,
      line.transit_days,
      JSON.stringify(raw),
    ]
  );
  return ins.rows[0].id;
}

export async function upsertRate(client, line, rfqItemId, code) {
  var col = rateColumn(line.container_type);
  var existingId = await findRate(client, line);
  var raw = rateRaw(line, rfqItemId, code);
  await expireOverlaps(client, line, existingId);
  if (!col) {
    var rateId = existingId
      ? await updateRateBase(client, existingId, line, raw)
      : await insertRateBase(client, line, raw);
    await upsertRateBox(client, rateId, line);
    return rateId;
  }
  return existingId
    ? updateRateColumn(client, existingId, line, raw, col)
    : insertRateColumn(client, line, raw, col);
}
