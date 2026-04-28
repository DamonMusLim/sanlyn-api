import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// v2 Network Layer migration
// Implements the multi-tier supply-chain graph described in
// docs/SANLYN-BLUEPRINT-V2-NETWORK.md (commit 366305ef).
//
// New tables:
//   relationships          — edges between companies (graph model)
//   company_capabilities   — what each company can do (factory/shipping/...)
//   network_invites        — outstanding invitations driving network growth
//   thread_events          — unified per-company event timeline
//                           (CRM activity feed; surface for AI推进)
//
// All FKs point to `customers` (the universal company table per
// partner_master_data_model.md). No new "companies" table — `customers`
// IS the company table, just history-named.
// ═══════════════════════════════════════════════════════════════

var STATEMENTS = [
  // ── 1. relationships ────────────────────────────────────────
  // An edge from one company to another. Same pair can have multiple
  // edges of different types (e.g. A buys from B AND ships via B).
  `CREATE TABLE IF NOT EXISTS relationships (
    id                 BIGSERIAL PRIMARY KEY,
    from_company_id    INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    to_company_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    type               VARCHAR(32) NOT NULL,
      -- 'buys_from' | 'sells_to' | 'ships_via' | 'serves' | 'partners_with'
    category           VARCHAR(64) DEFAULT '',
      -- domain hint: 'pet_food' | 'ocean_freight' | 'trucking' | 'inspection' | ...
    status             VARCHAR(16) DEFAULT 'active',
      -- 'active' | 'paused' | 'ended'
    started_at         TIMESTAMPTZ DEFAULT NOW(),
    ended_at           TIMESTAMPTZ DEFAULT NULL,

    -- Aggregate stats (refreshed nightly by job, NOT real-time)
    volume_ytd_cny     NUMERIC(15,2) DEFAULT 0,
    order_count_ytd    INT DEFAULT 0,
    on_time_rate       NUMERIC(4,3) DEFAULT NULL,    -- 0.000 ~ 1.000
    last_interaction_at TIMESTAMPTZ DEFAULT NULL,

    -- Provenance
    invited_by_user_id INT DEFAULT NULL,             -- who created this edge
    invite_id          BIGINT DEFAULT NULL,          -- references network_invites.id

    -- 2-hop visibility flag (decision 3 from blueprint v2)
    visibility_to_partners VARCHAR(16) DEFAULT 'private',
      -- 'private'   = only the two parties see this edge details
      -- 'shared'    = both parties' direct partners can see it
      -- 'public'    = anyone in Sanlyn network can see (rare)

    notes              TEXT DEFAULT '',
    raw                JSONB DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (from_company_id, to_company_id, type)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_rel_from   ON relationships(from_company_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_to     ON relationships(to_company_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_type   ON relationships(type)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_active ON relationships(from_company_id, type) WHERE status = 'active'`,

  // Self-edge guard — a company cannot have a relationship with itself
  `ALTER TABLE relationships DROP CONSTRAINT IF EXISTS rel_no_self_loop`,
  `ALTER TABLE relationships ADD CONSTRAINT rel_no_self_loop CHECK (from_company_id <> to_company_id)`,

  // ── 2. company_capabilities ─────────────────────────────────
  // What this company can do. One row per capability so they can be
  // verified and scored independently.
  `CREATE TABLE IF NOT EXISTS company_capabilities (
    company_id   INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    capability   VARCHAR(32) NOT NULL,
      -- 'manufacture' | 'trade' | 'shipping' | 'trucking' | 'customs'
      -- | 'warehouse' | 'inspection' | 'insurance' | 'finance' | 'translation'
    category     VARCHAR(64) DEFAULT '',
      -- specific category within the capability
    moq          VARCHAR(64) DEFAULT '',           -- minimum order qty (free-text per cap)
    lead_days    INT DEFAULT NULL,                 -- typical lead time
    capacity     VARCHAR(128) DEFAULT '',          -- e.g. "200 containers/year"
    pricing_note TEXT DEFAULT '',                  -- "$240-450/inspection"
    cert_list    JSONB DEFAULT '[]'::jsonb,        -- ["BRC", "HACCP", "ISO22000"]
    verified_by  VARCHAR(128) DEFAULT '',          -- 'sanlyn-admin' | 'self' | 'auditor'
    verified_at  TIMESTAMPTZ DEFAULT NULL,
    sanlyn_score NUMERIC(3,2) DEFAULT NULL,        -- 0.00 ~ 5.00 (recommendation algo)
    is_published BOOLEAN DEFAULT false,            -- visible in Sanlyn directory
    raw          JSONB DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (company_id, capability)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cap_capability ON company_capabilities(capability) WHERE is_published = true`,
  `CREATE INDEX IF NOT EXISTS idx_cap_score      ON company_capabilities(capability, sanlyn_score DESC NULLS LAST) WHERE is_published = true`,

  // ── 3. network_invites ──────────────────────────────────────
  // Outstanding invitations. Once accepted, becomes a row in users
  // (and triggers a relationship edge to be created).
  `CREATE TABLE IF NOT EXISTS network_invites (
    id                BIGSERIAL PRIMARY KEY,
    token             VARCHAR(64) NOT NULL UNIQUE,    -- random URL-safe token
    inviter_user_id   INT NOT NULL,                   -- who sent the invite
    inviter_company_id INT NOT NULL REFERENCES customers(id),
    target_role       VARCHAR(32) NOT NULL,
      -- 'contact' | 'factory' | 'trader' | 'shipping'
      -- | 'trucking' | 'customs' | 'inspection' | ...
    target_company_name VARCHAR(256) DEFAULT '',     -- recipient's company (free text on invite)
    target_contact_name VARCHAR(128) DEFAULT '',
    target_email      VARCHAR(128) DEFAULT '',
    target_phone      VARCHAR(64)  DEFAULT '',
    target_wechat     VARCHAR(64)  DEFAULT '',
    channels_sent     JSONB DEFAULT '[]'::jsonb,     -- ['email', 'wechat', 'whatsapp']
    personal_message  TEXT DEFAULT '',
    status            VARCHAR(16) DEFAULT 'pending',
      -- 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked'
    accepted_user_id  INT DEFAULT NULL,              -- once they sign up
    accepted_at       TIMESTAMPTZ DEFAULT NULL,
    expires_at        TIMESTAMPTZ DEFAULT NULL,
    quarantine_until  TIMESTAMPTZ DEFAULT NULL,      -- before first transaction (decision 3-b in v1)
    raw               JSONB DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_inv_inviter ON network_invites(inviter_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_inv_status  ON network_invites(status, expires_at)`,

  // ── 4. thread_events ────────────────────────────────────────
  // Unified per-company timeline. Same row appears on the threads
  // of BOTH parties (filtered by visibility rules in the API layer).
  // This is the data behind Customer Thread / Supplier Thread / etc.
  `CREATE TABLE IF NOT EXISTS thread_events (
    id              BIGSERIAL PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    counterparty_id INT REFERENCES customers(id) ON DELETE CASCADE,
      -- nullable: some events (notes / AI suggestions) live on a single side
    type            VARCHAR(32) NOT NULL,
      -- 'task' | 'task_done' | 'order' | 'payment' | 'document' | 'shipment'
      -- | 'sample' | 'catalog' | 'email' | 'wechat' | 'whatsapp' | 'phone'
      -- | 'ai_suggestion' | 'note' | 'price_change' | 'invite_sent' | 'joined'
    title           VARCHAR(512) NOT NULL,
    detail          TEXT DEFAULT '',
    related_order_no VARCHAR(64) DEFAULT '',         -- jump-pill target
    actor_user_id   INT DEFAULT NULL,                -- who did it
    actor_label     VARCHAR(128) DEFAULT '',         -- "Sanlyn AI" / "system" / display name
    channel         VARCHAR(16) DEFAULT '',          -- 'email' / 'wechat' / 'in_app' ...
    metadata        JSONB DEFAULT '{}'::jsonb,       -- flexible per event type

    -- AI推进 specific
    ai_priority     INT DEFAULT 0,                   -- 0 = normal, 100 = blocking
    ai_actions      JSONB DEFAULT '[]'::jsonb,       -- inline action button definitions

    -- Visibility (blueprint v2 decision 3)
    visibility      VARCHAR(16) DEFAULT 'both',
      -- 'both'      = visible to both company_id and counterparty_id
      -- 'self_only' = only company_id sees this (private notes)
      -- 'system'    = system-only, audit log

    occurred_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_evt_company    ON thread_events(company_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evt_counter    ON thread_events(counterparty_id, occurred_at DESC) WHERE counterparty_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_evt_type       ON thread_events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_evt_ai         ON thread_events(company_id, ai_priority DESC) WHERE type = 'ai_suggestion'`,
  `CREATE INDEX IF NOT EXISTS idx_evt_order      ON thread_events(related_order_no) WHERE related_order_no <> ''`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    var pool = getPool();
    var log = [];
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 90).replace(/\s+/g, " ") + "...");
    }
    res.status(200).json({
      ok: true,
      tables_created: ["relationships", "company_capabilities", "network_invites", "thread_events"],
      statements_run: STATEMENTS.length,
      log,
    });
  } catch (err) {
    console.error("[migrate-v2-network] failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
