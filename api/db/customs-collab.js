// api/db/customs-collab.js — route entry + router.
// 2026-07-14: logic split into sibling modules to satisfy the ≤500-line rule.
//   customs-collab-shared.js     auth / rate-limit / factory resolvers / fileUrl
//   customs-collab-rows.js       fetchRows + list / factory_list handlers
//   customs-collab-detail.js     detail + invoice-template builder
//   customs-collab-upload.js     factory invoice + slip upload
//   customs-collab-mutations.js  finance confirm + correction
import { setCors } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { handleFactoryDoc } from "./customs-collab-docs.js";
import { handleList, handleFactoryList } from "./customs-collab-rows.js";
import { handleDetail } from "./customs-collab-detail.js";
import { handleUpload } from "./customs-collab-upload.js";
import { handleConfirm, handleCorrection } from "./customs-collab-mutations.js";
import { json } from "./customs-collab-shared.js";

export const config = { api: { bodyParser: false } };

// Re-export so existing importers keep resolving from ./customs-collab.js:
//   customs-collab-docs.js         → resolveFactory, assertFactoryCustoms
//   factory-invoice-reconcile.js   → fetchRows
//   recon-shadow.js (dynamic)      → fetchRows
export { resolveFactory, assertFactoryCustoms } from "./customs-collab-shared.js";
export { fetchRows } from "./customs-collab-rows.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const action = cleanString(req.query?.action);
    if (req.method === "GET" && action === "list") return handleList(req, res);
    if (req.method === "GET" && action === "factory_list") return handleFactoryList(req, res);
    if (req.method === "GET" && action === "factory_doc") return handleFactoryDoc(req, res);
    if (req.method === "GET" && action === "detail") return handleDetail(req, res);
    if (req.method === "POST" && action === "confirm") return handleConfirm(req, res);
    if (req.method === "POST" && action === "upload") return handleUpload(req, res);
    if (req.method === "POST" && action === "upload_slip") return json(res, 403, { error: "工厂侧仅可查看水单，水单由巴匕内部上传" });
    if (req.method === "POST" && action === "correction") return handleCorrection(req, res);
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[customs-collab]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
