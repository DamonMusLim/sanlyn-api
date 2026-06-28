import OSS from "ali-oss";

export function getOSSClient() {
  return new OSS({
    region: process.env.OSS_REGION || "oss-cn-hongkong",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "sanlyn-files",
  });
}

export async function ossUploadBuffer(ossPath, buffer, mimeType = "application/octet-stream") {
  const client = getOSSClient();
  await client.put(ossPath, buffer, { mime: mimeType });
  return `https://${process.env.OSS_BUCKET || "sanlyn-files"}.${process.env.OSS_REGION || "oss-cn-hongkong"}.aliyuncs.com/${ossPath}`;
}

export async function ossUploadJSON(ossPath, data) {
  const buf = Buffer.from(JSON.stringify(data, null, 0), "utf-8");
  return ossUploadBuffer(ossPath, buf, "application/json");
}

export async function ossReadJSON(ossPath) {
  const client = getOSSClient();
  const result = await client.get(ossPath);
  return JSON.parse(result.content.toString("utf-8"));
}
