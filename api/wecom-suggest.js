// wecom-suggest.js — 侧边栏"守底价拟回复"（复用规则:砍价转人工/价格类查商城标待确认/普通AI）
// POST { text, external_userid? } → { draft, human?, needs_confirm?, reason? }
import { setCors } from "./db.js";
const RISK_RE = /(便宜|优惠|折扣|少点|降价|议价|最低|包邮|再送|抹零)/;
const PRICE_RE = /(多少钱|价格|价钱|几块|报价|怎么卖|什么价)/;
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  if (RISK_RE.test(text)) return res.status(200).json({ human: true, reason: "涉及砍价/优惠，人工把关（守底价）" });
  if (PRICE_RE.test(text)) {
    // 价格类：查 LuvSome 商城实时价，标待确认（铁律：价格人工确认再发）
    try {
      const q = encodeURIComponent(text.replace(PRICE_RE, "").slice(0, 20));
      const r = await fetch(`https://shop.sanlyn.cn/app-api/product/spu/page?keyword=${q}&pageNo=1&pageSize=3`, { headers: { "tenant-id": "1" } });
      const d = await r.json();
      const list = ((d.data && d.data.list) || []).filter(p => (p.price || 0) > 500);
      if (list.length) {
        const top = list[0];
        return res.status(200).json({ needs_confirm: true, draft: `亲，${(top.name||"").slice(0,24)} 现在¥${(top.price/100).toFixed(0)}，需要我帮您留一份吗？` });
      }
    } catch (e) {}
    return res.status(200).json({ needs_confirm: true, draft: "亲，这款的价格我帮您确认一下马上回您～" });
  }
  // 普通咨询：简洁友好模板（V1.1可接 MiniMax 口语化）
  return res.status(200).json({ draft: "在的亲～您具体想了解哪方面呢？我帮您详细介绍下😊" });
}
