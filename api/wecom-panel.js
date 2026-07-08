// wecom-panel.js — 识流机器人看板(多端):机器人POST推草稿,登录后GET看
// POST x-panel-token(=TASK_INGEST_SECRET复用): {chat_name,chat_type,content,draft,needs_confirm,human,reason,delay_seconds}
// GET  需JWT(admin):返回最近50条
import { getPool, setCors } from "./db.js";
import { extractUser } from "./auth.js";
async function ensure(pool){ await pool.query(`CREATE TABLE IF NOT EXISTS wecom_panel (id BIGSERIAL PRIMARY KEY, entry JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`); }
export default async function handler(req, res){
  setCors(req,res,"GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, X-Panel-Token");
  if(req.method==="OPTIONS") return res.status(200).end();
  const pool=getPool(); await ensure(pool);
  if(req.method==="POST"){
    const tok=req.headers["x-panel-token"]||"";
    if(!process.env.TASK_INGEST_SECRET||tok!==process.env.TASK_INGEST_SECRET) return res.status(403).json({error:"forbidden"});
    const e=req.body||{}; if(!e.chat_name&&!e.content) return res.status(400).json({error:"empty"});
    await pool.query("INSERT INTO wecom_panel(entry) VALUES($1::jsonb)",[JSON.stringify(e)]);
    await pool.query("DELETE FROM wecom_panel WHERE id < (SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM wecom_panel ORDER BY id DESC LIMIT 50) t)");
    return res.status(200).json({ok:true});
  }
  if(req.method==="GET"){
    const u=extractUser(req); if(!u) return res.status(401).json({error:"Unauthorized",message:"请先登录"});
    const r=await pool.query("SELECT entry, created_at FROM wecom_panel ORDER BY id DESC LIMIT 50");
    return res.status(200).json({ list: r.rows.map(x=>({...x.entry, _t:x.created_at})) });
  }
  return res.status(405).json({error:"GET/POST only"});
}
