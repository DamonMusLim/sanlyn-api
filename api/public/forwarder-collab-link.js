// api/public/forwarder-collab-link.js
// GET /api/public/forwarder-collab-link/:code?plan_id=<shipping_plans.id>
// 货代门户「进入协同」真实接线（2026-07-17）：按票签发 supplier_portal 协同链接。
// 此前 V21Modals 的进入协同按钮是 mockup 桩（只弹 toast），Damon 抓包报 bug。
//
// 鉴权链（fail-closed）：
//   :code → forwarder_portal_tokens → company_id
//   plan_id 必须满足 shipping_plans.forwarder_company_id = company_id，否则 403 —— 拿不到别家的票。
// token 惯例照 booking-collab.js：genRaw 48hex → sha256 存 magic_links（原文不落库，短码铁律），7天。
// magic_links 只存 hash 取不回原文 → 每次点击签发新链接（旧的自然过期，无需吊销）。
// segments：ocean 恒有；truck/customs 仅当该票 trucking_arrange/customs_arrange = 'agent'（货代承包段）。
//   collab-portal.html 靠它做 Lens（"只显示贵司承包的段"、运费价格无权访问），绝不放大。
import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function genRaw() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex，booking-collab validate 要求 ≥16
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method" });
  const pool = getPool();

  const code = String(req.params && req.params.code || "").trim();
  const planId = parseInt(req.query && req.query.plan_id, 10);
  if (!code || !planId) return res.status(400).json({ ok: false, error: "code/plan_id 必填" });

  const tk = await pool.query(
    "SELECT company_id, forwarder_co, expires_at FROM forwarder_portal_tokens WHERE code = $1 LIMIT 1",
    [code]
  );
  if (!tk.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
  const token = tk.rows[0];
  if (token.expires_at && new Date(token.expires_at) < new Date())
    return res.status(410).json({ ok: false, error: "expired" });
  if (!token.company_id)
    return res.status(403).json({ ok: false, error: "token 未绑定 company_id" });

  const sp = await pool.query(
    `SELECT id, _id, shipment_no, trucking_arrange, customs_arrange
       FROM shipping_plans
      WHERE id = $1 AND forwarder_company_id = $2
      LIMIT 1`,
    [planId, token.company_id]
  );
  if (!sp.rows.length) return res.status(403).json({ ok: false, error: "本票不属于该货代" });
  const plan = sp.rows[0];

  // 2026-07-18 Damon 纠正：门户货代 = 协同中枢的「海运方」，只进海运段。
  // 车队/报关在中枢是独立的方（车队·工厂自理 / 报关·巴匕自理），各有各的链——
  // 就算这票拖车由货代安排，也不从这个入口放段，段位归中枢管。
  const segments = ["ocean"];

  const co = await pool.query("SELECT name_cn FROM companies WHERE id = $1 LIMIT 1", [token.company_id]);
  const companyLabel = (co.rows[0] && co.rows[0].name_cn) || token.forwarder_co || "";

  // 与协同中枢 handleSendPortalLink 同口径：先吊销该票该方旧链——一票一方只一条活链。
  // 门户点开 = 等价中枢对海运方点「发」，两个入口共用同一条链体系，不各签各的。
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL
        AND COALESCE(meta->>'company_label','') = COALESCE($2,'')`,
    [plan.id, String(companyLabel || "").slice(0, 60)]
  );

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({
      shipment_id: plan.id,
      plan_business_id: plan._id,
      segments,
      company_label: String(companyLabel || "").slice(0, 60) || undefined,
      company_id: token.company_id,
      issued_via: "forwarder_portal",
    })]
  );

  return res.json({ ok: true, url: `${APP_BASE}/public/collab-portal.html?token=${raw}` });
}
