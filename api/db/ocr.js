// api/db/ocr.js
// Generic document OCR for AI智能下单.
//
// POST /api/db/ocr
//   multipart/form-data: file=<png|jpg image>
//   or JSON: { image_base64, media_type }
//   returns: { ok: true, text }

import { setCors, requireAuth } from "../db.js";

var MM_URL = "https://api.minimaxi.com/anthropic/v1/messages";
var MM_KEY = process.env.MINIMAX_API_KEY || "";
var MM_MODEL = "MiniMax-M3";
var OCR_PROMPT = "请把这张订单单据(PI/SC/采购合同/装箱单)里的全部文字原样提取出来,保留产品行、数量、单价、客户等信息,输出纯文本,不要遗漏不要编造。";

var IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function cleanBase64(data) {
  if (!data) return "";
  var s = String(data).trim();
  var m = s.match(/^data:([^;,]+);base64,(.*)$/s);
  return m ? m[2].replace(/\s+/g, "") : s.replace(/\s+/g, "");
}

function mediaTypeFromDataUrl(data) {
  var m = String(data || "").match(/^data:([^;,]+);base64,/);
  return m ? m[1] : "";
}

async function readRequestBuffer(req) {
  var chunks = [];
  for await (var chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseBoundary(contentType) {
  var m = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return m ? (m[1] || m[2] || "").trim() : "";
}

function parseMultipart(buffer, boundary) {
  var marker = Buffer.from("--" + boundary);
  var parts = [];
  var pos = buffer.indexOf(marker);

  while (pos !== -1) {
    var next = buffer.indexOf(marker, pos + marker.length);
    if (next === -1) break;

    var part = buffer.slice(pos + marker.length, next);
    pos = next;

    if (part.length >= 2 && part[0] === 45 && part[1] === 45) continue;
    if (part.slice(0, 2).toString() === "\r\n") part = part.slice(2);
    if (part.slice(-2).toString() === "\r\n") part = part.slice(0, -2);

    var headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    var headerText = part.slice(0, headerEnd).toString("utf8");
    var data = part.slice(headerEnd + 4);
    var headers = {};
    headerText.split(/\r\n/).forEach(function(line) {
      var idx = line.indexOf(":");
      if (idx > -1) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
    });

    var disposition = headers["content-disposition"] || "";
    var nameMatch = disposition.match(/name="([^"]+)"/i);
    var filenameMatch = disposition.match(/filename="([^"]*)"/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : "",
      media_type: headers["content-type"] || "application/octet-stream",
      data,
    });
  }

  return parts;
}

async function getImageInput(req) {
  var contentType = req.headers["content-type"] || "";
  var body = req.body || {};

  if (body.image_base64) {
    return {
      data: cleanBase64(body.image_base64),
      media_type: body.media_type || mediaTypeFromDataUrl(body.image_base64) || "image/png",
    };
  }

  if (String(contentType).toLowerCase().includes("multipart/form-data")) {
    var boundary = parseBoundary(contentType);
    if (!boundary) throw new Error("multipart boundary missing");

    var buffer = await readRequestBuffer(req);
    var parts = parseMultipart(buffer, boundary);
    var filePart = parts.find(function(p) {
      return p.filename || p.name === "file" || p.name === "image" || p.name === "upload";
    });

    if (!filePart || !filePart.data || !filePart.data.length) {
      throw new Error("file required");
    }

    return {
      data: filePart.data.toString("base64"),
      media_type: filePart.media_type || "application/octet-stream",
      filename: filePart.filename || "",
    };
  }

  throw new Error("image_base64 or multipart file required");
}

function assertSupportedImage(mediaType) {
  var mt = String(mediaType || "").toLowerCase().split(";")[0].trim();
  if (mt === "application/pdf") {
    throw new Error("PDF upload is not supported in phase 1; upload a PNG/JPG image");
  }
  if (!IMAGE_TYPES.has(mt)) {
    throw new Error("unsupported media_type: " + (mediaType || "unknown"));
  }
  return mt === "image/jpg" ? "image/jpeg" : mt;
}

async function callMiniMaxOcr(image) {
  if (!MM_KEY) throw new Error("MINIMAX_API_KEY not set");

  var body = {
    model: MM_MODEL,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: OCR_PROMPT },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.media_type,
            data: image.data,
          },
        },
      ],
    }],
  };

  var r = await fetch(MM_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + MM_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  var rawText = await r.text();
  var j = null;
  try { j = rawText ? JSON.parse(rawText) : null; } catch (_) {}

  if (!r.ok) {
    var message = j?.error?.message || j?.message || rawText || ("MiniMax OCR HTTP " + r.status);
    throw new Error(message);
  }

  var blocks = Array.isArray(j?.content) ? j.content : [];
  var text = blocks
    .filter(function(block) { return block && block.type === "text"; })
    .map(function(block) { return block.text || ""; })
    .join("\n")
    .trim();

  if (!text && typeof j?.choices?.[0]?.message?.content === "string") {
    text = j.choices[0].message.content.trim();
  }

  if (!text) throw new Error("MiniMax OCR returned no text");
  return text;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return sendError(res, 405, "POST only");

  try {
    var auth = await requireAuth(req, res);
    if (auth === false) return;

    var image = await getImageInput(req);
    image.media_type = assertSupportedImage(image.media_type);

    var text = await callMiniMaxOcr(image);
    return res.status(200).json({ ok: true, text });
  } catch (e) {
    return sendError(res, 200, e?.message || "OCR failed");
  }
}
