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
];

function pickBody(body){
  var out={};
  ALL_FIELDS.forEach(function(k){ if(body[k]!==undefined) out[k]=body[k]===""?null:body[k]; });
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
      var q="SELECT * FROM container_bookings", w=[], p=[];
      if(bl_no){        p.push(bl_no);        w.push("bl_no=$"+p.length); }
      if(contract_no){  p.push(contract_no);  w.push("contract_no=$"+p.length); }
      if(container_no){ p.push(container_no); w.push("container_no=$"+p.length); }
      if(w.length) q+=" WHERE "+w.join(" AND ");
      q+=" ORDER BY pickup_time ASC NULLS LAST, id ASC";
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
