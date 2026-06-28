// migrate-containers.js — creates shipment_group + containers + order_containers per v3.2 §6.3
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  if (!req.user) extractUser(req);
  const okJwt  = req.user && ["admin", "system"].includes(req.user.role);
  const okCron = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!okJwt && !okCron) return res.status(403).json({ success: false, error: "Forbidden" });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shipment_group (
        id          BIGSERIAL PRIMARY KEY,
        group_code  VARCHAR(32) UNIQUE,
        bl_master   VARCHAR(64),
        vessel      VARCHAR(64),
        voyage      VARCHAR(32),
        pol         VARCHAR(64),
        pod         VARCHAR(64),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS containers (
        id                BIGSERIAL PRIMARY KEY,
        shipment_group_id BIGINT REFERENCES shipment_group(id),
        container_no      VARCHAR(16),
        seal_no           VARCHAR(24),
        container_type    VARCHAR(8),
        gross_weight_kg   NUMERIC(10,2),
        total_cbm         NUMERIC(8,3),
        loaded_at         TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_containers (
        order_id     INT NOT NULL,
        container_id BIGINT NOT NULL REFERENCES containers(id),
        ctn_count    INT,
        cbm          NUMERIC(8,3),
        PRIMARY KEY (order_id, container_id)
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_containers_shipment_group ON containers(shipment_group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_containers_order ON order_containers(order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_containers_container ON order_containers(container_id)`);

    return res.status(200).json({ success: true, message: "shipment_group + containers + order_containers tables created" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
