// api/public/_forwarder-portal-auth.js
// 货代门户统一鉴权 —— 只认 HttpOnly cookie 里的高熵 secret，URL 路径的 :code(slug) 永不当凭证。
//
// 2026-07-18 P0 根治：此前 forwarder_portal_tokens.code 是低熵可猜 slug(nbcosco/wanhui)，
// 数据端点直接拿 URL 路径 slug 鉴权 → 任何人猜到 slug 就能冒充货代拉真 BL/工厂名/账单流水。
// 根治=凭证与标识分离：
//   - secret(48hex/192bit) = 唯一凭证，只在 kp?c= 流程写入 fwd_session HttpOnly cookie，从不出现在 URL。
//   - code(slug) = 纯 URL 标签/显示别名，鉴权时完全忽略。
// 所有 /api/public/forwarder-* 端点必须走本 helper 解析货代身份，绝不再 `WHERE code = 路径参数`。

export function fwdCookieSecret(req) {
  const raw = String((req && req.headers && req.headers.cookie) || "");
  const hit = raw.split(";").map(p => p.trim()).find(p => p.indexOf("fwd_session=") === 0);
  if (!hit) return "";
  return decodeURIComponent(hit.slice("fwd_session=".length));
}

// 返回 { token:{code,forwarder_co,company_id,expires_at} } 或 { error, body }
export async function resolveForwarder(pool, req) {
  const secret = fwdCookieSecret(req);
  // 高熵门槛：低于 24 字符直接拒(挡住残留的旧 slug cookie 和空 cookie)
  if (!secret || secret.length < 24) {
    return { error: 401, body: { ok: false, error: "unauthorized", message: "请通过货代门户短链进入" } };
  }
  const { rows } = await pool.query(
    `SELECT code, forwarder_co, company_id, expires_at
       FROM forwarder_portal_tokens
      WHERE secret = $1
      LIMIT 1`,
    [secret]
  );
  if (!rows.length) {
    return { error: 401, body: { ok: false, error: "unauthorized" } };
  }
  const t = rows[0];
  if (t.expires_at && new Date(t.expires_at) < new Date()) {
    return { error: 410, body: { ok: false, error: "expired", message: "链接已过期" } };
  }
  return { token: t };
}
