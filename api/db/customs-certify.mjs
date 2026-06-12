// 报关/开票品名 权威认证 — 工厂不认/开不了票时,在开票方案上改名 → 写主数据 + 回灌 OLI + 留痕。
// 名字唯一真值 = 工厂能开票的名(发票品名=报关品名,同 declaration_name)。
// POST {sku, declaration_name, declaration_name_en?, hs_code?, reason, operator?, bl_no?, scope?}
//   scope: 'sku'(默认,该SKU全部订单,治漂移) | 'bl'(仅本BL订单)
// GET  ?sku=   → 该 SKU 认证历史
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function readBody(req){return new Promise(function(res,rej){if(req.body!==undefined){if(typeof req.body==="string"){try{res(req.body?JSON.parse(req.body):{});}catch(e){rej(e);}return;}res(req.body||{});return;}var c=[];req.on("data",function(x){c.push(x);});req.on("end",function(){var r=Buffer.concat(c).toString("utf8");if(!r){res({});return;}try{res(JSON.parse(r));}catch(e){rej(e);}});req.on("error",rej);});}

async function ensureTable(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS customs_cert_log (
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    source TEXT DEFAULT 'factory_confirmed',
    operator TEXT,
    bl_no TEXT,
    scope TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
}

export default async function handler(req, res){
  setCors(req, res, "GET, POST, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(!requireAuth(req,res)) return;
  var pool=getPool();
  try{
    await ensureTable(pool);

    // ── 认证历史 ──
    if(req.method==="GET"){
      var sku=req.query.sku;
      if(!sku) return res.status(400).json({error:"need sku"});
      var h=await pool.query("SELECT * FROM customs_cert_log WHERE sku=$1 ORDER BY created_at DESC LIMIT 100",[sku]);
      return res.status(200).json(h.rows);
    }

    if(req.method!=="POST") return res.status(405).json({error:"POST only"});
    var b=await readBody(req);
    var sku=(b.sku||"").trim();
    var dn=(b.declaration_name||"").trim();
    var dnEn=b.declaration_name_en!=null?String(b.declaration_name_en).trim():null;
    var hs=b.hs_code!=null?String(b.hs_code).trim():null;
    var reason=(b.reason||"").trim();
    var operator=b.operator||(req.user&&req.user.username)||"unknown";
    var blNo=b.bl_no||null;
    var scope=(b.scope==="bl")?"bl":"sku";
    if(!sku) return res.status(400).json({error:"need sku"});
    if(!dn)  return res.status(400).json({error:"need declaration_name(报关/开票品名)"});
    if(!reason) return res.status(400).json({error:"need reason(改名原因,如:工厂不认/开不了票)"});

    // 取当前 canonical(留痕用 old)
    var cur=await pool.query("SELECT declaration_name,declaration_name_en,hs_code FROM products WHERE sku=$1 ORDER BY id LIMIT 1",[sku]);
    var old=cur.rows[0]||{};

    // 1) 写主数据 products(该 sku 全部行,sku 不 UNIQUE)
    var setP=["declaration_name=$1"], valP=[dn];
    if(dnEn!=null){ setP.push("declaration_name_en=$"+(valP.length+1)); valP.push(dnEn); }
    if(hs!=null && hs!==""){ setP.push("hs_code=$"+(valP.length+1)); valP.push(hs); }
    valP.push(sku);
    var up1=await pool.query("UPDATE products SET "+setP.join(",")+" WHERE sku=$"+valP.length+" RETURNING id",valP);

    // 2) 回灌 order_line_items(默认该 sku 全部;scope=bl 仅本 BL 订单)
    var oliSql, oliVal;
    var setO=["declaration_name=$1"], idx=1;
    var baseVal=[dn];
    if(dnEn!=null){ idx++; setO.push("declaration_name_en=$"+idx); baseVal.push(dnEn); }
    if(hs!=null && hs!==""){ idx++; setO.push("hs_code=$"+idx); baseVal.push(hs); }
    if(scope==="bl" && blNo){
      idx++; var skuPos=idx; baseVal.push(sku);
      idx++; var blPos=idx; baseVal.push(blNo);
      oliSql="UPDATE order_line_items SET "+setO.join(",")+
        " WHERE sku=$"+skuPos+" AND order_id IN (SELECT id FROM orders WHERE bl_no=$"+blPos+") RETURNING order_id";
      oliVal=baseVal;
    } else {
      idx++; baseVal.push(sku);
      oliSql="UPDATE order_line_items SET "+setO.join(",")+" WHERE sku=$"+idx+" RETURNING order_id";
      oliVal=baseVal;
    }
    var up2=await pool.query(oliSql,oliVal);

    // 3) 留痕(逐字段)
    async function log(field,ov,nv){
      if(nv==null||String(ov||"")===String(nv||"")) return;
      await pool.query("INSERT INTO customs_cert_log (sku,field,old_value,new_value,reason,source,operator,bl_no,scope) VALUES ($1,$2,$3,$4,$5,'factory_confirmed',$6,$7,$8)",
        [sku,field,ov!=null?String(ov):null,String(nv),reason,operator,blNo,scope]);
    }
    await log("declaration_name", old.declaration_name, dn);
    if(dnEn!=null) await log("declaration_name_en", old.declaration_name_en, dnEn);
    if(hs!=null && hs!=="") await log("hs_code", old.hs_code, hs);

    return res.status(200).json({
      ok:true, sku:sku, scope:scope,
      products_updated:up1.rowCount,
      oli_updated:up2.rowCount,
      oli_orders:[...new Set(up2.rows.map(function(r){return r.order_id;}))],
      old:{declaration_name:old.declaration_name,declaration_name_en:old.declaration_name_en,hs_code:old.hs_code},
      new:{declaration_name:dn,declaration_name_en:dnEn,hs_code:hs}
    });
  }catch(e){ return res.status(500).json({error:String(e&&e.message||e)}); }
}
