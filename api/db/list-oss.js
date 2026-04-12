// api/db/list-oss.js — 列出 OSS bucket 中指定前缀的文件
// GET /api/db/list-oss?prefix=payments/&search=CY2025001
import OSS from "ali-oss";
import { setCors } from "../db.js";

function getClient() {
  return new OSS({
    region:          process.env.OSS_REGION           || "oss-cn-hongkong",
    accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket:          process.env.OSS_BUCKET           || "sanlyn-files",
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  var { prefix = "", search = "", maxKeys = "200" } = req.query;

  try {
    var client = getClient();
    var result = await client.list({ prefix, "max-keys": parseInt(maxKeys) || 200 });

    var objects = result.objects || [];
    // Filter by search term if provided
    if (search) {
      var q = search.toLowerCase();
      objects = objects.filter(function(o) {
        return (o.name || "").toLowerCase().includes(q);
      });
    }

    var files = objects.map(function(o) {
      var bucket = process.env.OSS_BUCKET || "sanlyn-files";
      var region = process.env.OSS_REGION || "oss-cn-hongkong";
      return {
        key:          o.name,
        name:         o.name,
        url:          "https://" + bucket + "." + region + ".aliyuncs.com/" + o.name,
        size:         o.size,
        lastModified: o.lastModified,
        etag:         o.etag,
      };
    });

    return res.status(200).json({ success: true, files, total: files.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, files: [] });
  }
}
