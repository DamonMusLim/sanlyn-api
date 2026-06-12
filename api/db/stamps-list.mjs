import { getPool, setCors } from "../db.js";
// GET /api/db/stamps-list → 可选公章清单(供"更换公章")。只读。
export default async function handler(req, res){
  setCors(req, res, "GET, OPTIONS");
  if(req.method==='OPTIONS') return res.status(204).end();
  const pool=getPool();
  try{
    const r=await pool.query("SELECT company_code, COALESCE(name, company_code) AS title, COALESCE(is_default,false) AS is_default FROM customer_stamps WHERE COALESCE(is_active,true) ORDER BY is_default DESC, company_code");
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.send(JSON.stringify({ stamps: r.rows }));
  }catch(e){
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ stamps: [], error: e.message }));
  }
}
