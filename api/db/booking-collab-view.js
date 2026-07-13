// booking-collab-view.js — 协同中枢视图补充端点（路由入口）
// Mounted by booking-collab.js. Handlers 拆在 booking-collab-view-{master,actions,ai}.js（2026-07-13 拆分,原541行超500铁律）
import { handleMasterView } from "./booking-collab-view-master.js";
import { handleSupplyChain, handleAssignOrders, handleConfirmShipment, handleAddFactory } from "./booking-collab-view-actions.js";
import { handleAiFillFromDocs, handleAiSuggest } from "./booking-collab-view-ai.js";
export { derivePlanFactories } from "./booking-collab-view-lib.js";

const WRITE_ROLES = ["admin", "finance", "internal_ops"];
export async function registerBookingCollabView(req, res, pool, ctx = {}) {
  const { pathSuffix, requireAuth } = ctx;
  const gate = () => {
    if (!requireAuth) { res.status(403).json({ ok: false, error: "auth_required" }); return false; }
    return requireAuth(req, res);
  };
  const requireWrite = () => {
    const role = String((req.user && req.user.role) || "").toLowerCase();
    if (!WRITE_ROLES.includes(role)) { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
    return true;
  };
  const routes = {
    "master-view": { methods: ["GET", "POST"], fn: handleMasterView, write: req.method === "POST" },
    "supply-chain": { methods: ["POST"], fn: handleSupplyChain, write: true },
    "assign-orders": { methods: ["POST"], fn: handleAssignOrders, write: true },
    "confirm-shipment": { methods: ["POST"], fn: handleConfirmShipment, write: true },
    "add-factory": { methods: ["POST"], fn: handleAddFactory, write: true },
    "ai-suggest": { methods: ["POST"], fn: handleAiSuggest, write: false },
    "ai-fill-from-docs": { methods: ["POST"], fn: handleAiFillFromDocs, write: false },
  };
  const r = routes[pathSuffix];
  if (r && r.methods.includes(req.method)) {
    if (!gate()) return true;
    if (r.write && !requireWrite()) return true;
    await r.fn(req, res, pool);
    return true;
  }
  return false;
}
