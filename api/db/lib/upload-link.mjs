// upload-link.mjs — /opt/sanlyn-uploads 下员工端图片的「限时签名链接」(0928)。
//
// 🩸 0928 实测 ai.sanlyn.cn/uploads/… 返回的是网页不是图(nginx 没挂 /opt/sanlyn-uploads),
//    开店点检照片 / 报销小票 / 手册配图 / 盘点照片存下的公网 URL 全是死链(文件都在盘上)。
// ⛔ 不开公开目录:同一个根下还有 collab / po-collab / acfin(合同、单据),小票也可能带个人信息。
//    改成【读出时】把库里存的旧 URL 换成 /api/db/upload-file?p=&e=&s= 限时签名链接,
//    <img> 直接能显示、不用带登录头;库里的值不动(随时可回退)。
// ⛔ 只签下面白名单子目录。身份证在 /opt/sanlyn-private,不在这个根下,也永远别加进来。
import crypto from "node:crypto";

export const UPLOAD_ROOT = "/opt/sanlyn-uploads";
export const SIGNABLE_SUBS = new Set(["reimbursement", "handbook", "staff-stock-report", "staff-inbox"]);
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const TTL_SEC = 12 * 3600;

function key() {
  const s = process.env.UPLOAD_LINK_SECRET || process.env.JWT_SECRET;
  // 派生子密钥:签名泄漏也换不出 JWT 密钥;没配密钥就不签不验(fail-closed)
  return s ? crypto.createHmac("sha256", s).update("upload-link:v1").digest() : null;
}

// "reimbursement/1785566997273/open.jpg" → 原样;任何 ../ 空段 / 非白名单目录 → null
export function normRel(rel) {
  const s = String(rel || "");
  if (!s || s.length > 300 || /[\\\0]/.test(s)) return null;
  const segs = s.split("/");
  if (segs.length < 2 || segs.some((x) => !x || x === "." || x === "..")) return null;
  if (!SIGNABLE_SUBS.has(segs[0])) return null;
  return segs.join("/");
}

function sig(k, rel, exp) {
  return crypto.createHmac("sha256", k).update(`${rel}\n${exp}`).digest("base64url");
}

// 库里存的 https://ai.sanlyn.cn/uploads/<sub>/… → 签名链接;别的值(外链、空、非白名单)原样返回
export function signUploadUrl(url, nowMs = Date.now()) {
  if (typeof url !== "string") return url;
  const m = url.match(/^(?:https?:\/\/[^/]+)?\/uploads\/([^?#]+)$/);
  const rel = m && normRel(m[1]);
  const k = rel && key();
  if (!k) return url;
  // 过期时间取整到小时:同一小时内同一张图 URL 不变,浏览器缓存能用上
  const exp = Math.ceil((nowMs / 1000 + TTL_SEC) / 3600) * 3600;
  return `${PUBLIC_HOST}/api/db/upload-file?p=${encodeURIComponent(rel)}&e=${exp}&s=${sig(k, rel, exp)}`;
}

// 手册 images 是 [{url,caption}],盘点照片是 [url]:都认
export function signUploadList(list) {
  if (!Array.isArray(list)) return list;
  return list.map((x) => (x && typeof x === "object" && "url" in x ? { ...x, url: signUploadUrl(x.url) } : signUploadUrl(x)));
}

// 前端编辑后把签名链接原样回传(手册 PATCH)→ 还原成库里的原 URL,⛔别把会过期的链接存进库
export function unsignUploadUrl(url) {
  if (typeof url !== "string" || !url.startsWith(`${PUBLIC_HOST}/api/db/upload-file?`)) return url;
  const rel = normRel(new URL(url).searchParams.get("p"));
  return rel ? `${PUBLIC_HOST}/uploads/${rel}` : url;
}

// 通过 → 相对路径;不通过 → null
export function verifyUploadLink(q, nowMs = Date.now()) {
  const rel = normRel(q?.p);
  const exp = Number(q?.e);
  const k = key();
  if (!rel || !k || !Number.isInteger(exp) || exp * 1000 < nowMs) return null;
  const want = Buffer.from(sig(k, rel, exp));
  const got = Buffer.from(String(q?.s || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? rel : null;
}
