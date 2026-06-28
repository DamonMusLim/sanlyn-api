import { createReadStream, readFileSync, statSync } from "fs";
import { join } from "path";
import { createHmac } from "crypto";
import { setCors } from "../db.js";

// OSS config
var BUCKET   = "sanlyn-files";
var REGION   = "oss-cn-hongkong";
var ENDPOINT = BUCKET + "." + REGION + ".aliyuncs.com";
var OBJ_KEY  = "data/products.json";

// Credentials from env
var AK_ID     = process.env.ALI_AK_ID     || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID     || "";
var AK_SECRET = process.env.ALI_AK_SECRET || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "";

function ossSign(method, contentType, dateStr, resource) {
  var stringToSign = method + "\n\n" + contentType + "\n" + dateStr + "\n" + resource;
  var hmac = createHmac("sha1", AK_SECRET).update(stringToSign).digest("base64");
  return "OSS " + AK_ID + ":" + hmac;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Read products.json from repo
    var filePath = join(process.cwd(), "data", "products.json");
    var body;
    try {
      body = readFileSync(filePath, "utf-8");
    } catch (e) {
      // Try alternate path
      filePath = join(process.cwd(), "api", "data", "products.json");
      body = readFileSync(filePath, "utf-8");
    }

    if (!AK_ID || !AK_SECRET) {
      return res.status(200).json({
        success: false,
        error: "Missing ALI_AK_ID / ALI_AK_SECRET env vars. Set them in Vercel Environment Variables.",
        fileSize: body.length,
        productCount: JSON.parse(body).length,
      });
    }

    var contentType = "application/json";
    var dateStr = new Date().toUTCString();
    var resource = "/" + BUCKET + "/" + OBJ_KEY;
    var auth = ossSign("PUT", contentType, dateStr, resource);

    var url = "https://" + ENDPOINT + "/" + OBJ_KEY;
    var resp = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Date": dateStr,
        "Authorization": auth,
        "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      },
      body: body,
    });

    var respText = await resp.text();
    if (resp.ok) {
      return res.status(200).json({
        success: true,
        message: "Uploaded products.json to OSS",
        url: "https://files.sanlynos.com/data/products.json",
        size: body.length,
        productCount: JSON.parse(body).length,
        ossStatus: resp.status,
      });
    } else {
      return res.status(200).json({
        success: false,
        error: "OSS upload failed",
        ossStatus: resp.status,
        ossResponse: respText.slice(0, 500),
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
}
