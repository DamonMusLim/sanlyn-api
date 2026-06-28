// /api/db/invoice-portal.js — 工厂开票 magic-link 门户（无登录，token验证）
// 工厂端：下载开票申请(报关价/13%) + 上传开好的发票 → 落 finance_invoices_in(财务归口)
// GET  ?token=X                         → 验证+返回开票申请数据+已传发票
// GET  ?action=gen&order_no=X  (需JWT)  → 签发该订单的开票链接token
// POST {token, action:'upload', invoice_no, issue_date, amount_ex_tax, total_tax, amount_incl_tax, tax_rate, file_b64, filename}
//                                       → 存OSS + document_uploads + finance_invoices_in(seller=工厂)
import { getPool, setCors } from "../db.js";
import crypto from "crypto";
import OSS from "ali-oss";

const SECRET = process.env.PORTAL_TOKEN_SECRET || process.env.JWT_SECRET || "sanlyn-invoice-portal-2026";
function sign(orderNo){ return crypto.createHmac("sha256", SECRET).update("inv:"+orderNo).digest("base64url").slice(0,16); }
function genToken(orderNo){ return Buffer.from(orderNo).toString("base64url") + "." + sign(orderNo); }
function verifyToken(token){
  const [b64, sig] = String(token||"").split(".");
  if(!b64||!sig) return null;
  let orderNo; try{ orderNo = Buffer.from(b64,"base64url").toString("utf8"); }catch{ return null; }
  return sig === sign(orderNo) ? orderNo : null;
}
function ossClient(){ return new OSS({ region:process.env.OSS_REGION||"oss-cn-hongkong", accessKeyId:process.env.OSS_ACCESS_KEY_ID, accessKeySecret:process.env.OSS_ACCESS_KEY_SECRET, bucket:process.env.OSS_BUCKET||"sanlyn-files" }); }
const num=v=>{const n=parseFloat(String(v??"").replace(/[, ]/g,""));return isFinite(n)?n:null;};
function shortCode(){ return crypto.randomBytes(9).toString("base64url").replace(/[^a-zA-Z0-9]/g,"").slice(0,12).toUpperCase(); }
async function ensureLinkTable(pool){ await pool.query(`CREATE TABLE IF NOT EXISTS invoice_links(code text PRIMARY KEY, order_no text NOT NULL, created_at timestamptz DEFAULT NOW(), expires_at timestamptz)`).catch(()=>{}); await pool.query(`ALTER TABLE invoice_links ADD COLUMN IF NOT EXISTS expires_at timestamptz`).catch(()=>{}); }
async function resolveOrder(req, pool){
  // 初期无token: ?o=订单号直接用; ?c=短码查表; ?t/?token=hmac(旧)
  const c = req.query.c || req.body?.c;
  if(c){ const r=await pool.query(`SELECT order_no FROM invoice_links WHERE code=$1 AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`,[c]).catch(()=>({rows:[]})); return r.rows[0]?.order_no||null; }
  const t = req.query.token || req.query.t || req.body?.token || req.body?.t;
  if(t) return verifyToken(t);
  return null;
}

export default async function handler(req, res){
  setCors(req, res, "GET, POST, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  const pool = getPool();
  try{
    // 签发链接(管理端,简单JWT存在即可)
    if(req.method==="GET" && req.query.action==="gen"){
      const orderNo = String(req.query.order_no||"");
      if(!orderNo) return res.status(400).json({success:false,error:"需 order_no"});
      await ensureLinkTable(pool);
      // 复用已有短码,没有则生成
      let code; const ex=await pool.query(`SELECT code FROM invoice_links WHERE order_no=$1 LIMIT 1`,[orderNo]).catch(()=>({rows:[]}));
      if(ex.rows.length){ code=ex.rows[0].code; }
      else { code=shortCode(); await pool.query(`INSERT INTO invoice_links(code,order_no,expires_at) VALUES($1,$2,NOW()+INTERVAL '60 days')`,[code,orderNo]).catch(()=>{}); }
      return res.status(200).json({success:true, order_no:orderNo, code,
        url:`https://ai.sanlyn.cn/api/db/kp?c=${code}`,
        token:genToken(orderNo)});
    }
    const orderNo = await resolveOrder(req, pool);
    if(!orderNo) return res.status(401).json({success:false,error:"无效的开票链接"});

    if(req.method==="GET"){
      // 开票申请数据: 订单+工厂+报关明细(报关价) ; 已上传发票
      const o = await pool.query(`
        SELECT o.order_no, o.contract_no, o.currency,
               c.name_cn AS factory_name, c.tax_id AS factory_tax_id,
               b.name_cn AS buyer_name, b.tax_id AS buyer_tax_id
        FROM orders o
        LEFT JOIN companies c ON c.id=o.factory_company_id
        LEFT JOIN companies b ON b.code=o.seller_code OR b.id=o.seller_company_id
        WHERE o.order_no=$1 LIMIT 1`, [orderNo]);
      if(!o.rows.length) return res.status(404).json({success:false,error:"订单不存在"});
      const ord = o.rows[0];
      // 报关明细(按HS, 报关价) — 来自 OLI
      const lines = await pool.query(`
        SELECT oli.declaration_name AS name, oli.hs_code,
               SUM(oli.qty_ctn)::numeric AS qty,
               SUM(COALESCE(oli.declare_amount_per_box,0)*COALESCE(oli.qty_ctn,0))::numeric AS decl_total,
               SUM(COALESCE(oli.gw_ctn,0)*COALESCE(oli.qty_ctn,0))::numeric AS gw
        FROM orders o JOIN order_line_items oli ON oli.order_id=o.id
        WHERE o.order_no=$1 AND oli.declaration_name IS NOT NULL
        GROUP BY oli.declaration_name, oli.hs_code`, [orderNo]);
      const declTotal = lines.rows.reduce((s,l)=>s+Number(l.decl_total||0),0);
      const vat = ord.factory_name?.includes("中宠")?0.09:0.13;
      const uploaded = await pool.query(`
        SELECT invoice_no, to_char(issue_date,'YYYY-MM-DD') AS issue_date, amount_incl_tax, tax_rate, created_at
        FROM finance_invoices_in WHERE $1 = ANY(COALESCE(contract_nos,'{}')) OR remark LIKE '%'||$2||'%'
        ORDER BY created_at DESC`, [ord.contract_no, orderNo]);
      return res.status(200).json({success:true, order_no:orderNo, contract_no:ord.contract_no,
        factory:{name:ord.factory_name, tax_id:ord.factory_tax_id},
        buyer:{name:ord.buyer_name||"厦门巴匕进出口有限公司", tax_id:ord.buyer_tax_id||"91350206MA34RW3852"},
        lines:lines.rows, decl_total:declTotal, vat_rate:vat,
        invoice_excl:declTotal, vat_amt:Math.round(declTotal*vat*100)/100, invoice_incl:Math.round(declTotal*(1+vat)*100)/100,
        uploaded:uploaded.rows});
    }

    if(req.method==="POST" && req.body?.action==="upload"){
      const b = req.body;
      if(!b.invoice_no) return res.status(400).json({success:false,error:"发票号必填"});
      // 订单工厂(卖方) + 巴匕(买方) 公司信息
      const o = await pool.query(`SELECT o.contract_no, c.name_cn factory_name, c.tax_id factory_tax, c.code factory_code, o.factory_company_id FROM orders o LEFT JOIN companies c ON c.id=o.factory_company_id WHERE o.order_no=$1 LIMIT 1`, [orderNo]);
      const ord = o.rows[0]||{};
      // 存PDF到OSS(可选)
      let url=null;
      if(b.file_b64 && b.filename){
        try{ const key=`invoices/${orderNo}/${Date.now()}_${b.filename}`;
          await ossClient().put(key, Buffer.from(b.file_b64,"base64")); url=key;
          await pool.query(`INSERT INTO document_uploads(doc_id,doc_type,contract_no,url,name,uploader,uploaded_at,mime) VALUES($1,'purchase_invoice',$2,$3,$4,'工厂门户',NOW(),'application/pdf')`,[orderNo,ord.contract_no,url,b.filename]).catch(()=>{});
        }catch(e){ /* OSS可失败不阻断 */ }
      }
      // 落 finance_invoices_in (财务归口)
      const ex=num(b.amount_ex_tax), tax=num(b.total_tax), incl=num(b.amount_incl_tax), rate=num(b.tax_rate);
      const exist = await pool.query(`SELECT id FROM finance_invoices_in WHERE invoice_no=$1`,[b.invoice_no]);
      if(exist.rows.length){
        await pool.query(`UPDATE finance_invoices_in SET issue_date=COALESCE($2::date,issue_date),amount_ex_tax=$3,total_tax=$4,amount_incl_tax=$5,tax_rate=$6,seller_name=$7,seller_company_code=$8,factory_id=$9,contract_nos=ARRAY[$10]::text[],source='factory_portal',review_status='pending',updated_at=NOW() WHERE id=$1`,
          [exist.rows[0].id,b.issue_date||null,ex,tax,incl,rate,ord.factory_name,ord.factory_code,ord.factory_company_id,ord.contract_no]);
      } else {
        await pool.query(`INSERT INTO finance_invoices_in(invoice_no,invoice_type,issue_date,seller_name,seller_tax_id,buyer_name,amount_ex_tax,total_tax,amount_incl_tax,tax_rate,currency,seller_company_code,factory_id,contract_nos,source,review_status,created_at,updated_at) VALUES($1,'增值税专用发票',$2,$3,$4,'厦门巴匕进出口有限公司',$5,$6,$7,$8,'CNY',$9,$10,ARRAY[$11]::text[],'factory_portal','pending',NOW(),NOW())`,
          [b.invoice_no,b.issue_date||null,ord.factory_name,ord.factory_tax,ex,tax,incl,rate,ord.factory_code,ord.factory_company_id,ord.contract_no]);
      }
      return res.status(200).json({success:true, message:"发票已上传，待 Sanlyn 财务审核确认入账", invoice_no:b.invoice_no, pdf:!!url});
    }
    return res.status(405).json({success:false,error:"method/action 不支持"});
  }catch(e){ return res.status(500).json({success:false,error:e.message}); }
}
