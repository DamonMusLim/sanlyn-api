// HS/申报要素 检测端点 — 用真实报关单权威(customs_hs_authority)+products主数据，
// 核对一票报关汇总每行的 HS 是否与海关放行一致、申报要素是否完整。只读不写库。
// POST {rows:[{decl_name,hs_code,declaration_elements}]}  或  {bl_no}
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

var digits = function (s) { return String(s == null ? "" : s).replace(/[^0-9]/g, ""); };

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    var pool = getPool();
    var body = await readJsonBody(req);
    var rows = Array.isArray(body.rows) ? body.rows : [];

    if (!rows.length) return res.status(200).json({ ok: true, findings: [], authorityCount: 0 });

    // 报关单权威 (海关放行过的 报关品名→HS)
    var authRes = await pool.query("SELECT decl_name, hs_code FROM customs_hs_authority");
    var auth = authRes.rows || [];

    // products 主数据：同 declaration_name 的 HS 分布（用于无报关先例时给主流参考）
    var prodRes = await pool.query(
      "SELECT declaration_name dn, hs_code, count(*) c FROM products WHERE active=true " +
      "AND NULLIF(TRIM(declaration_name),'') IS NOT NULL AND NULLIF(TRIM(hs_code),'') IS NOT NULL " +
      "GROUP BY declaration_name, hs_code");
    var prodByName = {};
    (prodRes.rows || []).forEach(function (r) {
      if (!prodByName[r.dn]) prodByName[r.dn] = [];
      prodByName[r.dn].push({ hs: r.hs_code, c: Number(r.c) });
    });

    var findings = rows.map(function (r) {
      var dn = String((r.decl_name || r.declaration_name || "")).trim();
      var hs = digits(r.hs_code);
      var elem = String(r.declaration_elements || r.elements || "").trim();
      var elemMissing = !elem;

      // 1) 报关单权威：精确，再模糊（品名互相包含）
      var authHs = null, matchName = null, matchKind = null;
      var ex = auth.find(function (a) { return a.decl_name === dn; });
      if (ex) { authHs = ex.hs_code; matchName = dn; matchKind = "exact"; }
      else if (dn) {
        var fz = auth.find(function (a) {
          return a.decl_name && (dn.indexOf(a.decl_name) >= 0 || a.decl_name.indexOf(dn) >= 0);
        });
        if (fz) { authHs = fz.hs_code; matchName = fz.decl_name; matchKind = "fuzzy"; }
      }

      var status, note, suggestHs = null;
      if (authHs) {
        if (digits(authHs) === hs) {
          status = "ok";
          note = "✓ 与海关放行一致" + (matchKind === "fuzzy" ? "（参考「" + matchName + "」）" : "");
        } else {
          status = "mismatch";
          suggestHs = authHs;
          note = "海关放行用 " + authHs + "（" + matchName + "），当前 " + (hs || "空");
        }
      } else {
        // 2) 无报关先例 → 看 products 主数据主流
        var dist = prodByName[dn] || [];
        if (dist.length) {
          dist.sort(function (a, b) { return b.c - a.c; });
          var main = dist[0];
          if (digits(main.hs) === hs) { status = "no_ref_ok"; note = "无报关先例；与主数据主流一致"; }
          else { status = "no_ref"; suggestHs = main.hs; note = "无报关先例；主数据主流为 " + main.hs; }
        } else {
          status = "no_ref";
          note = "无报关先例，建议核报关单";
        }
      }

      return {
        decl_name: dn, current_hs: hs, authority_hs: authHs, suggest_hs: suggestHs,
        match: matchName, matchKind: matchKind, status: status, note: note,
        elemMissing: elemMissing,
      };
    });

    var summary = {
      total: findings.length,
      ok: findings.filter(function (f) { return f.status === "ok" || f.status === "no_ref_ok"; }).length,
      mismatch: findings.filter(function (f) { return f.status === "mismatch"; }).length,
      no_ref: findings.filter(function (f) { return f.status === "no_ref"; }).length,
      elem_missing: findings.filter(function (f) { return f.elemMissing; }).length,
    };

    return res.status(200).json({ ok: true, summary: summary, findings: findings, authorityCount: auth.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
