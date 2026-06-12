// 单据邮寄追踪 — mailings(邮寄批次) + mailing_docs(关联单据) CRUD
// 一次邮寄=一条mailing(快递公司+快递号+收件人+方向+状态),含多份单据(mailing_docs)。
// GET  ?bl_no= / ?status= / ?direction=        → 邮寄批次列表(含docs)
// GET  ?pending=1&bl_no=                        → 待寄清单(需正本original_required且无已寄记录)
// POST {bl_no,courier_company,tracking_no,recipient_type,recipient_name,direction,status,sent_at,note,docs:[{doc_upload_id,doc_type,doc_label}]}
// PATCH {id,...}                                → 改批次(状态/快递号等)
// DELETE ?id=
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function readBody(req){return new Promise(function(res,rej){if(req.body!==undefined){if(typeof req.body==="string"){try{res(req.body?JSON.parse(req.body):{});}catch(e){rej(e);}return;}res(req.body||{});return;}var c=[];req.on("data",function(x){c.push(x);});req.on("end",function(){var r=Buffer.concat(c).toString("utf8");if(!r){res({});return;}try{res(JSON.parse(r));}catch(e){rej(e);}});req.on("error",rej);});}

export default async function handler(req, res){
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(!requireAuth(req,res)) return;
  var pool=getPool();
  try{
    // ── 待寄清单 ──
    if(req.method==="GET" && (req.query.pending==="1"||req.query.pending==="true")){
      var blP=req.query.bl_no||null;
      var q=`SELECT du.* FROM document_uploads du
             WHERE du.original_required=true
               AND ($1::text IS NULL OR du.bl_no=$1 OR du.doc_id=$1 OR du.doc_id LIKE 'BL::'||$1)
               AND NOT EXISTS (
                 SELECT 1 FROM mailing_docs md JOIN mailings m ON m.id=md.mailing_id
                 WHERE md.doc_upload_id=du.id AND m.status IN ('sent','delivered'))
             ORDER BY du.created_at DESC NULLS LAST`;
      var r=await pool.query(q,[blP]).catch(function(){return {rows:[]};});
      return res.status(200).json(r.rows);
    }
    // ── 列表 ──
    if(req.method==="GET"){
      var w=[],p=[];
      ["bl_no","status","direction","contract_no"].forEach(function(k){if(req.query[k]){p.push(req.query[k]);w.push(k+"=$"+p.length);}});
      var sql="SELECT * FROM mailings"+(w.length?" WHERE "+w.join(" AND "):"")+" ORDER BY sent_at DESC NULLS LAST, created_at DESC LIMIT 500";
      var mr=await pool.query(sql,p);
      var ids=mr.rows.map(function(x){return x.id;});
      var docs={};
      if(ids.length){
        var dr=await pool.query("SELECT * FROM mailing_docs WHERE mailing_id=ANY($1)",[ids]);
        dr.rows.forEach(function(d){(docs[d.mailing_id]=docs[d.mailing_id]||[]).push(d);});
      }
      mr.rows.forEach(function(m){m.docs=docs[m.id]||[];});
      return res.status(200).json(mr.rows);
    }
    // ── 新建邮寄批次 + 关联单据 ──
    if(req.method==="POST"){
      var b=await readBody(req);
      var ins=await pool.query(
        `INSERT INTO mailings (bl_no,contract_no,direction,courier_company,tracking_no,recipient_type,recipient_name,sender_name,status,sent_at,delivered_at,note)
         VALUES ($1,$2,COALESCE($3,'send'),$4,$5,$6,$7,$8,COALESCE($9,'draft'),$10,$11,$12) RETURNING *`,
        [b.bl_no||null,b.contract_no||null,b.direction||null,b.courier_company||null,b.tracking_no||null,
         b.recipient_type||null,b.recipient_name||null,b.sender_name||null,b.status||null,b.sent_at||null,b.delivered_at||null,b.note||null]);
      var m=ins.rows[0];
      if(Array.isArray(b.docs)) for(var i=0;i<b.docs.length;i++){var d=b.docs[i];
        await pool.query("INSERT INTO mailing_docs (mailing_id,doc_upload_id,doc_type,doc_label) VALUES ($1,$2,$3,$4)",
          [m.id,d.doc_upload_id||null,d.doc_type||null,d.doc_label||null]);}
      var dr2=await pool.query("SELECT * FROM mailing_docs WHERE mailing_id=$1",[m.id]);
      m.docs=dr2.rows;
      return res.status(201).json(m);
    }
    // ── 改批次 ──
    if(req.method==="PATCH"){
      var bo=await readBody(req); var id=bo.id||req.query.id;
      if(!id) return res.status(400).json({error:"id required"});
      var cols=["bl_no","contract_no","direction","courier_company","tracking_no","recipient_type","recipient_name","sender_name","status","sent_at","delivered_at","note"];
      var sets=[],vals=[];
      cols.forEach(function(c){if(c in bo){vals.push(bo[c]);sets.push(c+"=$"+vals.length);}});
      if(!sets.length) return res.status(400).json({error:"no fields"});
      sets.push("updated_at=now()"); vals.push(id);
      var up=await pool.query("UPDATE mailings SET "+sets.join(",")+" WHERE id=$"+vals.length+" RETURNING *",vals);
      return res.status(200).json(up.rows[0]||null);
    }
    // ── 删 ──
    if(req.method==="DELETE"){
      var did=req.query.id; if(!did) return res.status(400).json({error:"id required"});
      await pool.query("DELETE FROM mailings WHERE id=$1",[did]);
      return res.status(200).json({ok:true});
    }
    return res.status(405).json({error:"Method not allowed"});
  }catch(e){ return res.status(500).json({error:String(e&&e.message||e)}); }
}
