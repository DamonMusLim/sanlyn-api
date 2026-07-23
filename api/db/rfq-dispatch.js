import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolvePort } from "./port-resolver.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function code() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPH[b % ALPH.length];
  return out;
}

function badPort(res, side, r) {
  return res.status(400).json({ ok: false, error: `${side}_port_${r.status}`, side, candidates: r.candidates || [] });
}

function wechatText(name, rfq, url) {
  return `${name || "联系人"}您好，${rfq.pol}→${rfq.pod} ${rfq.ctnr_type}的运价麻烦补一下，点开30秒填完：${url}。客户在等价，今天给到还来得及订${rfq.etd || "近期"}的舱。`;
}

async function shortlink(client, itemId, etd) {
  for (let i = 0; i < 4; i += 1) {
    const c = code();
    try {
      const r = await client.query(
        `INSERT INTO freight_quote_shortlinks (code, item_id, expires_at)
         VALUES ($1, $2, COALESCE($3::date + INTERVAL '7 days', NOW() + INTERVAL '14 days'))
         ON CONFLICT (code) DO NOTHING`,
        [c, itemId, etd || null]
      );
      if (r.rowCount) return c;
    } catch (e) {
      if (e.code !== "23505") throw e;
    }
  }
  throw new Error("shortlink_collision");
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;

  const b = req.body || {};
  if (!b.pol || !b.pod || !Array.isArray(b.forwarder_company_ids) || !b.forwarder_company_ids.length) {
    return res.status(400).json({ ok: false, error: "pol, pod, forwarder_company_ids required" });
  }
  const pool = getPool();
  const [pol, pod] = await Promise.all([resolvePort(pool, b.pol), resolvePort(pool, b.pod)]);
  if (pol.status !== "resolved") return badPort(res, "pol", pol);
  if (pod.status !== "resolved") return badPort(res, "pod", pod);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ct = String(b.ctnr_type || "40HQ").toUpperCase().replace("HC", "HQ");
    const found = await client.query(
      `SELECT * FROM freight_rfqs
        WHERE pol_port_id = $1 AND pod_port_id = $2 AND ctnr_type = $3
          AND status = 'open'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [pol.port_id, pod.port_id, ct]
    );
    let rfq = found.rows[0];
    if (!rfq) {
      const ins = await client.query(
        `INSERT INTO freight_rfqs
           (pol, pod, pol_port_id, pod_port_id, ctnr_type, etd, status, route,
            customer_company_id, order_id, created_by, service_type, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,'ocean',NOW())
         RETURNING *`,
        [pol.canonical_name, pod.canonical_name, pol.port_id, pod.port_id, ct,
         b.etd || null, `${pol.canonical_name}→${pod.canonical_name}`,
         b.customer_company_id || null, b.order_id || null, req.user?.username || "rfq_dispatch"]
      );
      rfq = ins.rows[0];
    }
    const companies = await client.query(
      `SELECT id, COALESCE(name_cn, name_en, code, id::text) AS name
         FROM companies WHERE id = ANY($1::int[])`,
      [b.forwarder_company_ids.map(Number).filter(Number.isFinite)]
    );
    const invites = [];
    for (const co of companies.rows) {
      // 先查后插：RFQ 行已 FOR UPDATE 锁住，同单同货代只留一条 invited
      // （部分唯一索引带 IS NOT NULL 谓词，ON CONFLICT 推断不了，别再改回去）
      let itemId = (await client.query(
        `SELECT id FROM freight_rfq_items
          WHERE rfq_id=$1 AND forwarder_company_id=$2 AND status='invited' LIMIT 1`,
        [rfq.id, co.id]
      )).rows[0]?.id;
      if (!itemId) {
        itemId = (await client.query(
          `INSERT INTO freight_rfq_items
             (rfq_id, forwarder_company_id, forwarder_co, status, notes, container_type, usd_rate, submitted_at)
           VALUES ($1,$2,$3,'invited',$4,$5,NULL,NULL)
           RETURNING id`,
          [rfq.id, co.id, co.name, b.notes || null, ct]
        )).rows[0].id;
      }
      const sl = await shortlink(client, itemId, b.etd);
      const url = `${APP_BASE}/freight-quote/${encodeURIComponent(sl)}`;
      invites.push({ forwarder_company_id: co.id, name: co.name, url, wechat_text: wechatText(co.name, rfq, url) });
    }
    await client.query("COMMIT");
    return res.json({ ok: true, rfq_id: rfq.id, invites });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
}
