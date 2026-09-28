// /api/db/upload-file — 按限时签名链接吐员工端图片原图字节(0928)。
// GET ?p=<sub/…/file>&e=<过期秒>&s=<签名>   签名由 lib/upload-link.mjs 在读接口里生成。
// 无 JWT(<img> 带不了登录头),凭签名放行;签名错/过期 403,不是图片 415。
// ⛔ 只吐 SIGNABLE_SUBS 白名单目录里的图片;符号链接跳出目录一律 404。
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_ROOT, verifyUploadLink } from "./lib/upload-link.mjs";

// 按文件头认类型,不信扩展名
function sniff(fd) {
  const b = Buffer.alloc(12);
  const n = fs.readSync(fd, b, 0, 12, 0);
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (n >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (n >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (n >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (n >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|mif1|msf1)$/.test(b.toString("latin1", 8, 12))) return "image/heic";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ success: false, error: "只支持 GET" });
  const rel = verifyUploadLink(req.query || {});
  if (!rel) return res.status(403).json({ success: false, error: "链接无效或已过期" });

  let fd, real;
  try {
    const sub = fs.realpathSync(path.join(UPLOAD_ROOT, rel.split("/")[0]));
    real = fs.realpathSync(path.join(UPLOAD_ROOT, rel));
    if (!real.startsWith(sub + path.sep)) return res.status(404).json({ success: false, error: "文件不存在" });
    fd = fs.openSync(real, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return res.status(404).json({ success: false, error: "文件不存在" });
    const type = sniff(fd);
    if (!type) return res.status(415).json({ success: false, error: "不是图片" });

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    if (req.method === "HEAD") return res.status(200).end();
    res.status(200);
    const stream = fs.createReadStream(real, { fd, autoClose: true });
    fd = null; // 交给流关
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    if (e && e.code === "ENOENT") return res.status(404).json({ success: false, error: "文件不存在" });
    return res.status(500).json({ success: false, error: "读取失败" });
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}
