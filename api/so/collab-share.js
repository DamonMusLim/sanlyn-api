// /api/so/collab-share.js — SO 协同表魔法链接分发
// POST /api/so/collab-share   { dispatch_job_id, role, contact, contact_type }
// GET  /api/so/collab-public/:token  (公开端点，无 JWT)
import { getPool, setCors } from "../db/db.js";
import { requireAuth } from "../auth.js";
import crypto from "crypto";

// trucking 角色隐藏的字段
const TRUCKING_HIDDEN = ["bl_no", "vessel", "voyage", "forwarder_cn", "forwarder_en"];

function stripTrucking(plan) {
  if (!plan) return plan;
  const out = { ...plan };
  for (const k of TRUCKING_HIDDEN) delete out[k];
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const path = req.url?.split("?")[0] || "";

  // ── POST /api/so/collab-share ────────────────────────────────────────────
  if (req.method === "POST" && path.includes("/collab-share") && !path.includes("/collab-public")) {
    if (!requireAuth(req, res)) return;
    const { dispatch_job_id, role, contact, contact_type } = req.body || {};
    if (!dispatch_job_id) return res.status(400).json({ error: "dispatch_job_id required" });
    if (!role) return res.status(400).json({ error: "role required" });
    if (!contact) return res.status(400).json({ error: "contact required" });

    try {
      // 验证 dispatch_job_id 存在
      const jobR = await pool.query("SELECT id FROM so_dispatch_jobs WHERE id = $1", [dispatch_job_id]);
      if (!jobR.rows.length) return res.status(404).json({ error: "dispatch_job not found" });

      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expires_at = new Date(Date.now() + 72 * 3600 * 1000);

      const userId = req.user?.id || req.user?.user_id || null;

      await pool.query(
        `INSERT INTO collab_shares
           (dispatch_job_id, owner_user_id, shared_to_contact, contact_type, inherited_role, magic_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [dispatch_job_id, userId, contact, contact_type || "wechat", role, tokenHash, expires_at]
      );

      return res.json({
        share_url: `https://ai.sanlyn.cn/collab/${rawToken}`,
        expires_at,
        role,
      });
    } catch (e) {
      console.error("collab-share POST error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/so/collab-public/:token ─────────────────────────────────────
  if (req.method === "GET" && path.includes("/collab-public/")) {
    const parts = path.split("/collab-public/");
    const token = parts[1]?.split("?")[0];
    if (!token) return res.status(400).json({ error: "token required" });

    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      // 查 share
      const shareR = await pool.query(
        `SELECT * FROM collab_shares
         WHERE magic_token_hash = $1
           AND expires_at > NOW()
           AND revoked_at IS NULL`,
        [tokenHash]
      );
      if (!shareR.rows.length) return res.status(404).json({ error: "link expired or not found" });
      const share = shareR.rows[0];
      const role = share.inherited_role;

      // 查 dispatch_job
      const jobR = await pool.query("SELECT * FROM so_dispatch_jobs WHERE id = $1", [share.dispatch_job_id]);
      if (!jobR.rows.length) return res.status(404).json({ error: "dispatch_job not found" });
      const job = jobR.rows[0];

      // 查 shipping_plan
      const planR = await pool.query("SELECT * FROM shipping_plans WHERE id = $1", [job.shipping_plan_id]);
      const rawPlan = planR.rows[0] || null;
      const shipping_plan = role === "trucking" ? stripTrucking(rawPlan) : rawPlan;

      // 查 orders via so_dispatch_jobs → shipping_plans → orders
      let orders = [];
      let line_items = [];
      if (rawPlan) {
        const ordersR = await pool.query(
          `SELECT o.* FROM orders o
           WHERE o.so_no = $1 OR o.shipment_no = $1
              OR EXISTS (
                SELECT 1 FROM unnest(ARRAY[o.order_no]) AS x
                WHERE x = ANY($2::text[])
              )
           LIMIT 50`,
          [rawPlan.so_no || rawPlan.shipment_no, rawPlan.order_nos || []]
        );
        orders = ordersR.rows;

        if (orders.length > 0) {
          const orderIds = orders.map(o => o.id);
          const liR = await pool.query(
            `SELECT * FROM order_line_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id`,
            [orderIds]
          );
          line_items = liR.rows;
        }
      }

      // trucking_assignment
      let trucking_assignment = null;
      if (job.loading_sheet_id) {
        const taR = await pool.query(
          "SELECT * FROM so_loading_sheets WHERE id = $1",
          [job.loading_sheet_id]
        );
        trucking_assignment = taR.rows[0] || null;
      }

      // customs_notification (仅非 trucking 角色)
      let customs_notification = null;
      if (role !== "trucking" && job.collab_sheet_id) {
        const cnR = await pool.query(
          "SELECT * FROM so_collab_sheets WHERE id = $1",
          [job.collab_sheet_id]
        );
        customs_notification = cnR.rows[0] || null;
      }

      return res.json({
        role,
        dispatch_job: job,
        shipping_plan,
        orders,
        trucking_assignment,
        customs_notification,
        line_items,
      });
    } catch (e) {
      console.error("collab-public GET error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(404).json({ error: "route not found" });
}
