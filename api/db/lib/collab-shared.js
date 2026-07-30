// collab-shared.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import crypto from "crypto";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function genRaw() {
  // 10位字母数字短码：kp?c=CODE 复用;code本身即token(hash存token_hash)
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.randomBytes(10);
  let out = "";
  for (const x of b) out += A[x % A.length];
  return out;
}

export { APP_BASE, rawToHash, genRaw };
