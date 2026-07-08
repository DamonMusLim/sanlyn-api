// wecom-jssdk-sign.js — 企业微信 JS-SDK 两段签名（会话侧边栏用）
// GET ?url=<当前页面完整URL(不含#)> → { corpid, agentid, timestamp, nonceStr, signature, agentSignature }
//   signature      给 wx.config 用(corp级 jsapi_ticket)
//   agentSignature 给 wx.agentConfig 用(agent级 jsapi_ticket, type=agent_config)
// 依赖 env: WECOM_CORPID / WECOM_CUSTOMER_ASSIST_SECRET / WECOM_CUSTOMER_ASSIST_AGENTID
import crypto from "crypto";
import { setCors } from "./db.js";

const CORPID = process.env.WECOM_CORPID;
const SECRET = process.env.WECOM_CUSTOMER_ASSIST_SECRET;
const AGENTID = process.env.WECOM_CUSTOMER_ASSIST_AGENTID;
const BASE = "https://qyapi.weixin.qq.com/cgi-bin";

// 内存缓存(access_token/两种ticket各~7200s;签名端点低频,进程内缓存足够)
const cache = { token: null, tokenExp: 0, corpTicket: null, corpExp: 0, agentTicket: null, agentExp: 0 };

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}
async function getToken() {
  if (cache.token && cache.tokenExp > Date.now() + 60000) return cache.token;
  const d = await getJson(`${BASE}/gettoken?corpid=${CORPID}&corpsecret=${SECRET}`);
  if (!d.access_token) throw new Error(`gettoken失败: ${JSON.stringify(d)}`);
  cache.token = d.access_token;
  cache.tokenExp = Date.now() + (d.expires_in - 200) * 1000;
  return cache.token;
}
async function getCorpTicket() {
  if (cache.corpTicket && cache.corpExp > Date.now() + 60000) return cache.corpTicket;
  const t = await getToken();
  const d = await getJson(`${BASE}/get_jsapi_ticket?access_token=${t}`);
  if (d.errcode !== 0) throw new Error(`corp ticket失败: ${JSON.stringify(d)}`);
  cache.corpTicket = d.ticket;
  cache.corpExp = Date.now() + (d.expires_in - 200) * 1000;
  return cache.corpTicket;
}
async function getAgentTicket() {
  if (cache.agentTicket && cache.agentExp > Date.now() + 60000) return cache.agentTicket;
  const t = await getToken();
  const d = await getJson(`${BASE}/ticket/get?access_token=${t}&type=agent_config`);
  if (d.errcode !== 0) throw new Error(`agent ticket失败: ${JSON.stringify(d)}`);
  cache.agentTicket = d.ticket;
  cache.agentExp = Date.now() + (d.expires_in - 200) * 1000;
  return cache.agentTicket;
}
function sign(ticket, noncestr, timestamp, url) {
  const raw = `jsapi_ticket=${ticket}&noncestr=${noncestr}&timestamp=${timestamp}&url=${url}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!CORPID || !SECRET || !AGENTID) return res.status(500).json({ error: "企微凭证未配置" });

  const url = (req.query.url || "").split("#")[0];
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = crypto.randomBytes(8).toString("hex");
    const [corpTicket, agentTicket] = await Promise.all([getCorpTicket(), getAgentTicket()]);
    return res.status(200).json({
      corpid: CORPID,
      agentid: AGENTID,
      timestamp,
      nonceStr,
      signature: sign(corpTicket, nonceStr, timestamp, url),      // wx.config
      agentSignature: sign(agentTicket, nonceStr, timestamp, url), // wx.agentConfig
    });
  } catch (e) {
    console.error("[wecom-jssdk-sign]", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
