// /api/db/container-bookings.js
// Container-level shipment / VGM / trucking records (一柜一行)
// Subtable of shipping_plans — links a specific container to its order + driver + truck.
//
//   GET    ?bl_no=YMJAI228525573        → list all containers for a BL
//   GET    ?contract_no=FS2026...       → list containers for an order
//   GET    ?id=123                      → single record
//   POST   { ...fields }                → create one container booking (upsert by bl_no+container_no)
//   PATCH  { id, ...fields }            → update by id
//   DELETE ?id=123                      → delete

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const ALL_FIELDS = [
  "bl_no","booking_no","shipping_plan_id","contract_no","container_no","seal_no","container_type",
  "tare_weight_kg","cargo_weight_kg","pickup_time","pickup_yard","return_yard",
  "loading_address","loading_contact","truck_plate","trailer_plate",
  "driver_name","driver_phone","trucking_company","note",
  // Driver-submitted evidence (filled at weighbridge / loading scene)
  "evidence_photos","seal_photo_url","weight_ticket_url","driver_submitted_at",
];

// JSONB columns need JSON.stringify on insert
const JSONB_FIELDS = new Set(["evidence_photos"]);

function pickBody(body){
  var out={};
  ALL_FIELDS.forEach(function(k){
    if(body[k]!==undefined){
      var v = body[k]===""?null:body[k];
      if(v!=null && JSONB_FIELDS.has(k) && typeof v !== "string") v = JSON.stringify(v);
      out[k]=v;
    }
  });
  return out;
}

export default async function handler(req,res){
  setCors(req,res,"GET, POST, PATCH, DELETE, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(!requireAuth(req,res)) return;
  const pool = getPool();

  try {
    // ── GET ──────────────────────────────────────────────────────
    if(req.method==="GET"){
      var { id, bl_no, contract_no, container_no } = req.query;
      if(id){
        var r=await pool.query("SELECT * FROM container_bookings WHERE id=$1",[id]);
        return res.json({ success:true, data:r.rows[0]||null });
      }
      // 2026-07-05 根治: 每柜按 contract_no 关联订单,附加 订单号/CBM/件数(Σqty_ctn) 三列(additive,不动现有列)
      var enrich =
        ", (SELECT o.order_no FROM orders o WHERE o.contract_no=cb.contract_no ORDER BY o.id LIMIT 1) AS order_no_derived" +
        ", (SELECT o.total_cbm FROM orders o WHERE o.contract_no=cb.contract_no ORDER BY o.id LIMIT 1) AS order_cbm" +
        ", (SELECT SUM(oli.qty_ctn) FROM order_line_items oli JOIN orders o ON o.id=oli.order_id WHERE o.contract_no=cb.contract_no) AS order_cartons" +
        ", (SELECT COALESCE(o.factory_address, (SELECT c.address FROM companies c WHERE (c.name_cn=o.factory OR c.code=o.factory_code) AND c.address IS NOT NULL LIMIT 1)) FROM orders o WHERE o.contract_no=cb.contract_no ORDER BY o.id LIMIT 1) AS order_factory_addr";
      var q="SELECT cb.*"+enrich+" FROM container_bookings cb", w=[], p=[];
      if(bl_no){        p.push(bl_no);        w.push("cb.bl_no=$"+p.length); }
      if(contract_no){  p.push(contract_no);  w.push("cb.contract_no=$"+p.length); }
      if(container_no){ p.push(container_no); w.push("cb.container_no=$"+p.length); }
      if(w.length) q+=" WHERE "+w.join(" AND ");
      q+=" ORDER BY cb.pickup_time ASC NULLS LAST, cb.id ASC";
      var rl=await pool.query(q,p);
      return res.json({ success:true, data:rl.rows, count:rl.rowCount });
    }

    // ── POST (upsert by bl_no + container_no) ────────────────────
    if(req.method==="POST"){
      var body=req.body||{};
      if(!body.bl_no||!body.container_no) return res.status(400).json({ error:"bl_no and container_no required" });
      var vals=pickBody(body);
      var cols=Object.keys(vals);
      var ph=cols.map(function(_,i){return"$"+(i+1);});
      var setCols=cols.filter(function(c){return c!=="bl_no"&&c!=="container_no";})
                      .map(function(c){return c+"=EXCLUDED."+c;}).concat(["updated_at=NOW()"]);
      var sql="INSERT INTO container_bookings ("+cols.join(",")+",created_by) VALUES ("+ph.join(",")+",$"+(cols.length+1)+")"+
              " ON CONFLICT (bl_no,container_no) DO UPDATE SET "+setCols.join(",")+
              " RETURNING *";
      var params=cols.map(function(c){return vals[c];}).concat([(req.user&&req.user.username)||"api"]);
      var ri=await pool.query(sql,params);
      return res.json({ success:true, data:ri.rows[0] });
    }

    // ── PATCH ────────────────────────────────────────────────────
    if(req.method==="PATCH"){
      var body2=req.body||{};
      if(!body2.id) return res.status(400).json({ error:"id required" });
      var vals2=pickBody(body2);
      var cols2=Object.keys(vals2);
      if(!cols2.length) return res.status(400).json({ error:"no fields to update" });
      var set2=cols2.map(function(c,i){return c+"=$"+(i+1);}).concat(["updated_at=NOW()"]);
      var params2=cols2.map(function(c){return vals2[c];});
      params2.push(body2.id);
      var ru=await pool.query("UPDATE container_bookings SET "+set2.join(",")+" WHERE id=$"+params2.length+" RETURNING *",params2);
      return res.json({ success:true, data:ru.rows[0]||null });
    }

    // ── DELETE ───────────────────────────────────────────────────
    if(req.method==="DELETE"){
      var delId=req.query.id||(req.body&&req.body.id);
      if(!delId) return res.status(400).json({ error:"id required" });
      await pool.query("DELETE FROM container_bookings WHERE id=$1",[delId]);
      return res.json({ success:true });
    }

    return res.status(405).end();
  } catch (e) {
    console.error("[container-bookings] error:",e);
    return res.status(500).json({ error:e.message });
  }
}
