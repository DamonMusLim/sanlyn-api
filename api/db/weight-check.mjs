// 限重预警 检测端点 — 用国家主数据(countries+country_aliases)解析目的国，
// 查 weight_limit_rules 比对订单每柜毛重是否超目的国/船司限重。只读不写库。
// 绝不造数：无规则/无国家/无毛重/缺柜量 → 返回中性状态(不告警)，只有真超限才 over。
// POST {rows:[{order_no?, country, container_type, container_qty, gross_weight}]}
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    if (req.body !== undefined) {
      if (typeof req.body === "string") {
        try { resolve(req.body ? JSON.parse(req.body) : {}); } catch (e) { reject(e); }
        return;
      }
      resolve(req.body || {});
      return;
    }
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      var raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

var norm = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };
var num = function (s) { var n = Number(String(s == null ? "" : s).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : null; };
// 归一化柜型：40HQ/40HC/40'HQ → 40HQ；20GP/20'/20DC → 20GP
var normCntr = function (s) {
  var x = String(s == null ? "" : s).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/40/.test(x)) return "40HQ";
  if (/20/.test(x)) return "20GP";
  return x || null;
};

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    var pool = getPool();
    var body = await readJsonBody(req);
    var rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(200).json({ ok: true, findings: [], summary: { ok: 0, over: 0, no_rule: 0, incomplete: 0 } });

    // 国家主数据 + 别名（脏国名归一化到 country_id）
    var cRes = await pool.query("SELECT id, code, name_en, name_cn FROM countries");
    var byKey = {};               // 归一化串 → country row
    (cRes.rows || []).forEach(function (c) {
      [c.code, c.name_en, c.name_cn].forEach(function (k) { if (k) byKey[norm(k)] = c; });
    });
    var aRes = await pool.query("SELECT alias_text, country_id FROM country_aliases").catch(function () { return { rows: [] }; });
    var idToCountry = {};
    (cRes.rows || []).forEach(function (c) { idToCountry[c.id] = c; });
    (aRes.rows || []).forEach(function (a) {
      var c = idToCountry[a.country_id];
      if (c && a.alias_text) byKey[norm(a.alias_text)] = c;
    });

    // 限重规则
    var rRes = await pool.query(
      "SELECT country_id, port_code, container_type, max_gross_kg, weight_basis, trade_direction, source, confidence, verified " +
      "FROM weight_limit_rules WHERE COALESCE(trade_direction,'export')='export'");
    var rulesByCountry = {};
    (rRes.rows || []).forEach(function (r) {
      (rulesByCountry[r.country_id] = rulesByCountry[r.country_id] || []).push(r);
    });

    function resolveCountry(raw) {
      if (!raw) return null;
      var k = norm(raw);
      if (byKey[k]) return byKey[k];
      // 容错：取首词（"Kingdom of Saudi Arabia" 等多词，先精确，未来加别名）
      return null;
    }

    var summary = { ok: 0, over: 0, no_rule: 0, no_country: 0, incomplete: 0 };
    var findings = rows.map(function (r) {
      var orderNo = r.order_no || r.order_id || null;
      var country = resolveCountry(r.country);
      var cntr = normCntr(r.container_type);
      var qty = num(r.container_qty);
      var gw = num(r.gross_weight);

      var base = { order_no: orderNo, country_in: r.country || null,
        country_code: country ? country.code : null,
        container_type: cntr, container_qty: qty, gross_weight: gw };

      if (!country) { summary.no_country++; return Object.assign(base, { status: "no_country", note: "目的国无法识别，未挂国家主数据" }); }

      var rules = rulesByCountry[country.id] || [];
      if (!rules.length) { summary.no_rule++; return Object.assign(base, { status: "no_rule", note: country.name_cn + " 暂无限重规则" }); }

      // 选规则：优先柜型精确匹配，否则取该国最严(最小 max_gross_kg)兜底参考
      var rule = rules.filter(function (x) { return normCntr(x.container_type) === cntr; })[0];
      var matchKind = "container";
      if (!rule) {
        rule = rules.slice().sort(function (a, b) { return Number(a.max_gross_kg) - Number(b.max_gross_kg); })[0];
        matchKind = "min_fallback";
      }
      var limit = Number(rule.max_gross_kg);

      // 每柜毛重 = 订单总毛重 / 柜量（绝不造数：缺柜量/毛重无法判定）
      if (gw == null || !qty) {
        summary.incomplete++;
        return Object.assign(base, { status: "incomplete", limit: limit, basis: rule.weight_basis,
          verified: rule.verified, confidence: rule.confidence, source: rule.source,
          note: "缺毛重或柜量，无法核算每柜重" });
      }
      var perCntr = gw / qty;
      var over = perCntr > limit;
      if (over) summary.over++; else summary.ok++;

      return Object.assign(base, {
        status: over ? "over" : "ok",
        per_container_kg: Math.round(perCntr * 10) / 10,
        limit: limit, basis: rule.weight_basis, match: matchKind,
        verified: rule.verified, confidence: rule.confidence, source: rule.source,
        note: over
          ? ("⚠ 每柜 " + Math.round(perCntr) + "kg 超 " + country.name_cn + " 限重 " + limit + "kg（" + rule.source + (rule.verified ? "" : "·待核实") + "）")
          : ("✓ 每柜 " + Math.round(perCntr) + "kg ≤ 限重 " + limit + "kg")
      });
    });

    return res.status(200).json({ ok: true, findings: findings, summary: summary, ruleCount: (rRes.rows || []).length });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
