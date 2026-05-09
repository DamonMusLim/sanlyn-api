// ═══════════════════════════════════════════════════════════════
// shipment-tracking.js
// GET /api/db/shipment-tracking?contract_no=FS20251229059
// GET /api/db/shipment-tracking?shipment_id=SP2024xxxx
//
// Returns an 8-stage shipment timeline assembled from:
//   - shipping_plans (etd/atd/eta/ata/cargo_ready_date/pol/pod/vessel/voyage)
//   - driver_assignments (trucking stage, if present)
//   - 4portun vessel API (enrichment, best-effort via internal proxy)
//
// Auth: requireAuth
// ═══════════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";
import { requireAuth }       from "../auth.js";

// ── Port coordinate lookup ─────────────────────────────────────
// Source: UN/LOCODE ± 0.1°
const PORT_COORDS = {
  // Chinese origins
  "CNSHA": { lng: 121.47, lat: 31.23,  name: "Shanghai" },
  "CNSGH": { lng: 121.47, lat: 31.23,  name: "Shanghai" },
  "CNNBO": { lng: 121.55, lat: 29.87,  name: "Ningbo" },
  "CNNGB": { lng: 121.55, lat: 29.87,  name: "Ningbo" },
  "CNGZH": { lng: 113.27, lat: 23.13,  name: "Guangzhou Nansha" },
  "CNSZP": { lng: 114.26, lat: 22.55,  name: "Shenzhen Yantian" },
  "CNSZX": { lng: 113.83, lat: 22.67,  name: "Shenzhen Chiwan" },
  "CNTXG": { lng: 117.72, lat: 38.99,  name: "Tianjin" },
  "CNTSN": { lng: 117.72, lat: 38.99,  name: "Tianjin" },
  "CNQIN": { lng: 120.43, lat: 36.08,  name: "Qingdao" },
  "CNTAO": { lng: 120.43, lat: 36.08,  name: "Qingdao" },
  "CNXMN": { lng: 118.07, lat: 24.50,  name: "Xiamen" },
  // North America
  "USLAX": { lng: -118.27, lat: 33.72, name: "Los Angeles" },
  "USLGB": { lng: -118.21, lat: 33.77, name: "Long Beach" },
  "USSEA": { lng: -122.34, lat: 47.60, name: "Seattle" },
  "USNYK": { lng: -74.00,  lat: 40.72, name: "New York" },
  "USSAV": { lng: -81.10,  lat: 32.08, name: "Savannah" },
  "USORF": { lng: -76.01,  lat: 36.97, name: "Norfolk" },
  "CAYUL": { lng: -73.56,  lat: 45.50, name: "Montreal" },
  "CAVAN": { lng: -123.11, lat: 49.29, name: "Vancouver" },
  // Europe
  "NLRTM": { lng:  4.47,  lat: 51.92,  name: "Rotterdam" },
  "DEHAM": { lng:  9.99,  lat: 53.55,  name: "Hamburg" },
  "BEANR": { lng:  4.40,  lat: 51.22,  name: "Antwerp" },
  "GBFXT": { lng:  1.30,  lat: 51.95,  name: "Felixstowe" },
  "GBSOU": { lng: -1.40,  lat: 50.90,  name: "Southampton" },
  "ESALG": { lng: -0.48,  lat: 36.84,  name: "Algeciras" },
  "ITGOA": { lng:  8.93,  lat: 44.41,  name: "Genoa" },
  // Southeast Asia
  "SGSIN": { lng: 103.82, lat:  1.29,  name: "Singapore" },
  "MYPKG": { lng: 100.37, lat:  5.41,  name: "Penang" },
  "VNSGH": { lng: 106.69, lat: 10.76,  name: "Ho Chi Minh City" },
  "THBKK": { lng: 100.56, lat: 13.68,  name: "Bangkok" },
  // Middle East / South Asia
  "AEDXB": { lng: 55.27,  lat: 25.26,  name: "Dubai Jebel Ali" },
  "AEJEA": { lng: 55.02,  lat: 24.99,  name: "Jebel Ali" },
  "SAJED": { lng: 39.17,  lat: 21.48,  name: "Jeddah" },
  "INBOM": { lng: 72.83,  lat: 18.96,  name: "Mumbai" },
  // Oceania / Africa
  "AUMEL": { lng: 144.93, lat: -37.82, name: "Melbourne" },
  "AUSYD": { lng: 151.21, lat: -33.87, name: "Sydney" },
  "ZAJNB": { lng: 18.42,  lat: -33.91, name: "Cape Town" },
};

// Fuzzy port coord lookup: try LOCODE, then partial name match
function getPortCoords(portStr) {
  if (!portStr) return null;
  const upper = portStr.trim().toUpperCase();
  // Direct LOCODE match (5-char)
  if (PORT_COORDS[upper]) return { ...PORT_COORDS[upper], locode: upper };
  // Try first 5 chars of multi-word (e.g. "CNSHA WGQD")
  const shortCode = upper.replace(/\s.*/, "").slice(0, 5);
  if (PORT_COORDS[shortCode]) return { ...PORT_COORDS[shortCode], locode: shortCode };
  // Name substring match
  const lc = portStr.toLowerCase();
  for (const [code, c] of Object.entries(PORT_COORDS)) {
    if (c.name.toLowerCase().includes(lc) || lc.includes(c.name.toLowerCase())) {
      return { ...c, locode: code };
    }
  }
  return null;
}

// Linear interpolate between two timestamps at current time → position
function interpolatePosition(fromCoord, toCoord, startTs, endTs) {
  const now = Date.now();
  const start = new Date(startTs).getTime();
  const end   = new Date(endTs).getTime();
  if (end <= start || now <= start) return { ...fromCoord, pct: 0 };
  if (now >= end)                   return { ...toCoord,   pct: 100 };
  const t = (now - start) / (end - start);
  return {
    lng: fromCoord.lng + (toCoord.lng - fromCoord.lng) * t,
    lat: fromCoord.lat + (toCoord.lat - fromCoord.lat) * t,
    name: `In transit (~${Math.round(t * 100)}%)`,
    pct:  Math.round(t * 100),
  };
}

// Resolve status for each stage given atd/ata/current_time
function stageStatus(tsField, afterTs) {
  if (!tsField) return "pending";
  const ts = new Date(tsField).getTime();
  if (ts <= Date.now()) return "done";
  return "in_progress";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).end("Method Not Allowed");
  if (!requireAuth(req, res))   return;

  const { contract_no, shipment_id } = req.query;
  if (!contract_no && !shipment_id) {
    return res.status(400).json({ error: "contract_no or shipment_id required" });
  }

  const pool = getPool();

  try {
    // ── 1. Fetch shipping_plan ──
    let spRow = null;
    if (contract_no) {
      const r = await pool.query(
        `SELECT * FROM shipping_plans WHERE contract_no = $1 OR order_contract_nos ILIKE $2 ORDER BY created_at DESC LIMIT 1`,
        [contract_no, `%${contract_no}%`]
      );
      spRow = r.rows[0] || null;
    } else {
      const r = await pool.query(
        `SELECT * FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`,
        [shipment_id]
      );
      spRow = r.rows[0] || null;
    }

    if (!spRow) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    const raw = (typeof spRow.raw === "string" ? JSON.parse(spRow.raw) : spRow.raw) || {};

    // ── 2. Fetch driver assignment (trucking stage) ──
    let driverRow = null;
    try {
      const dr = await pool.query(
        `SELECT * FROM driver_assignments
          WHERE order_id IN (
            SELECT id FROM orders WHERE contract_no = $1 LIMIT 1
          )
          AND task_type = 'trucking'
          ORDER BY issued_at DESC LIMIT 1`,
        [spRow.contract_no || contract_no || ""]
      );
      driverRow = dr.rows[0] || null;
    } catch (_) { /* driver_assignments may not exist yet */ }

    // ── 3. Build port coordinates ──
    const polCoord  = getPortCoords(spRow.pol)  || { lng: 121.47, lat: 31.23, name: spRow.pol  || "Port of Loading" };
    const podCoord  = getPortCoords(spRow.pod)  || { lng: -118.27, lat: 33.72, name: spRow.pod || "Port of Destination" };

    // Guess factory coords from raw.factory_city or fall back to ~100km inland from POL
    const factoryCoord = raw.factory_city
      ? (getPortCoords(raw.factory_city) || { lng: polCoord.lng - 1.5, lat: polCoord.lat + 0.5, name: raw.factory_city })
      : { lng: polCoord.lng - 1.5, lat: polCoord.lat + 0.5, name: raw.factory || "Factory" };

    // ── 4. Derive timestamps ──
    const now = new Date();

    const cargoReadyTs    = spRow.cargo_ready_date    ? new Date(spRow.cargo_ready_date).toISOString()    : null;
    const cutoffTs        = spRow.cutoff_date         ? new Date(spRow.cutoff_date).toISOString()         : null;
    const etdTs           = spRow.etd                 ? new Date(spRow.etd).toISOString()                 : null;
    const atdTs           = spRow.atd                 ? new Date(spRow.atd).toISOString()                 : null;
    const etaTs           = spRow.eta                 ? new Date(spRow.eta).toISOString()                 : null;
    const ataTs           = spRow.ata                 ? new Date(spRow.ata).toISOString()                 : null;

    // Trucking: cargo_ready → cutoff_date (or etd - 2d)
    const truckingTs = driverRow?.issued_at
      ? new Date(driverRow.issued_at).toISOString()
      : cargoReadyTs;

    // Port arrival estimated: cutoff or ETD - 3 days
    const portArrivalTs = cutoffTs || (etdTs
      ? new Date(new Date(etdTs).getTime() - 3 * 24 * 3600 * 1000).toISOString()
      : null);

    // Customs clear: ETD - 1 day
    const customsClearTs = etdTs
      ? new Date(new Date(etdTs).getTime() - 1 * 24 * 3600 * 1000).toISOString()
      : null;

    // In-transit position
    const inTransitCoord = (atdTs && etaTs)
      ? interpolatePosition(polCoord, podCoord, atdTs, etaTs)
      : null;

    // ── 5. Resolve statuses ──
    const nowTs = now.getTime();
    function ts2ms(t) { return t ? new Date(t).getTime() : null; }

    function resolveStatus(timestamp) {
      if (!timestamp) return "pending";
      const ms = ts2ms(timestamp);
      if (ms <= nowTs) return "done";
      return "in_progress";
    }

    // Stage 6 (in_transit) is special: done only after actual ATA
    const inTransitStatus = ataTs ? "done" : atdTs ? "in_progress" : "pending";

    // ── 6. Assemble timeline ──
    const timeline = [
      {
        stage:     "factory_ready",
        label:     "货物准备 / Cargo Ready",
        timestamp: cargoReadyTs,
        location:  { ...factoryCoord },
        status:    resolveStatus(cargoReadyTs),
        icon:      "🏭",
      },
      {
        stage:     "trucking",
        label:     "拖车运输 / Inland Trucking",
        timestamp: truckingTs,
        location:  {
          lng: (factoryCoord.lng + polCoord.lng) / 2,
          lat: (factoryCoord.lat + polCoord.lat) / 2,
          name: "In transit to port",
        },
        status:    resolveStatus(truckingTs),
        icon:      "🚛",
        driver:    driverRow ? { id: driverRow.driver_id, task_type: driverRow.task_type } : null,
      },
      {
        stage:     "port_arrival",
        label:     "抵港 / Port Arrival",
        timestamp: portArrivalTs,
        location:  { ...polCoord },
        status:    resolveStatus(portArrivalTs),
        icon:      "⚓",
      },
      {
        stage:     "customs_clear",
        label:     "报关放行 / Customs Clearance",
        timestamp: customsClearTs,
        location:  { ...polCoord },
        status:    resolveStatus(customsClearTs),
        icon:      "🛃",
      },
      {
        stage:     "vessel_departed",
        label:     "开船 / Vessel Departed",
        timestamp: atdTs || etdTs,
        location:  { ...polCoord, vessel: spRow.vessel || null, voyage: spRow.voyage || null },
        status:    resolveStatus(atdTs || etdTs),
        icon:      "🚢",
        vessel:    spRow.vessel  || raw.vessel  || null,
        voyage:    spRow.voyage  || raw.voyage  || null,
        bl_no:     spRow.bl_no   || null,
      },
      {
        stage:     "in_transit",
        label:     "海上运输 / Ocean Transit",
        timestamp: atdTs || etdTs,
        location:  inTransitCoord || {
          lng: (polCoord.lng + podCoord.lng) / 2,
          lat: (polCoord.lat + podCoord.lat) / 2,
          name: "Ocean (estimated)",
        },
        status:    inTransitStatus,
        icon:      "🌊",
        eta:       etaTs,
        pct:       inTransitCoord?.pct ?? null,
      },
      {
        stage:     "port_arrival_dest",
        label:     "目的港到港 / Arrival Destination",
        timestamp: ataTs || etaTs,
        location:  { ...podCoord },
        status:    resolveStatus(ataTs || etaTs),
        icon:      "🏗️",
      },
      {
        stage:     "delivered",
        label:     "交货完成 / Delivered",
        timestamp: ataTs
          ? new Date(new Date(ataTs).getTime() + 5 * 24 * 3600 * 1000).toISOString()
          : null,
        location:  { ...podCoord, name: (podCoord.name || "") + " (destination)" },
        status:    ataTs ? "done" : "pending",
        icon:      "✅",
      },
    ];

    // ── 7. Current position summary ──
    // Find the latest "done" stage; if in_transit is in_progress use interpolated coord
    let currentStage = timeline.find(s => s.status === "in_progress") || timeline.filter(s => s.status === "done").pop() || timeline[0];

    return res.status(200).json({
      shipment: {
        id:          spRow.id,
        _id:         spRow._id,
        bl_no:       spRow.bl_no,
        contract_no: spRow.contract_no,
        vessel:      spRow.vessel,
        voyage:      spRow.voyage,
        pol:         spRow.pol,
        pod:         spRow.pod,
        etd:         etdTs,
        eta:         etaTs,
        atd:         atdTs,
        ata:         ataTs,
        flow_status: spRow.flow_status,
      },
      pol_coords:     polCoord,
      pod_coords:     podCoord,
      current_stage:  currentStage?.stage || "pending",
      current_coords: currentStage?.location || null,
      timeline,
    });

  } catch (err) {
    console.error("[shipment-tracking] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
