const OPEN_STATUSES = ["proposed", "mgr_ok", "approved", "pending", "applying"];

function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value, fallback = null) {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function authorFrom(req) {
  const session = text(req.headers["x-clerk-session"]);
  return session ? `clerk:${session.slice(0, 40)}` : "pricing-card";
}

async function insertIntent(client, row, decision, channel, oldPrice, targetPrice, reason, author) {
  const { rows } = await client.query(`
    WITH inserted AS (
      INSERT INTO petstore_price_intents
        (product_code, product_name, channel, old_price, target_price, reason, author, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'approved')
      ON CONFLICT DO NOTHING
      RETURNING id, product_code, channel, old_price, target_price, status, result, created_at
    ),
    existing AS (
      SELECT id, product_code, channel, old_price, target_price, status, result, created_at
      FROM petstore_price_intents
      WHERE product_code=$1 AND channel=$3 AND status = ANY($8)
      ORDER BY created_at
      LIMIT 1
    )
    SELECT *, true AS inserted FROM inserted
    UNION ALL
    SELECT *, false AS inserted FROM existing
    LIMIT 1
  `, [
    row.product_code,
    row.product_name || decision.product_name || null,
    channel,
    oldPrice,
    targetPrice,
    reason,
    author,
    OPEN_STATUSES,
  ]);
  return rows[0] || null;
}

function onlineChannels(decision) {
  const explicit = text(decision.online_channel);
  if (explicit) return [explicit];
  return ["美团", "饿了么"];
}

export async function createCardPriceIntents(client, row, decision, req) {
  const target = money(decision.price ?? row.new_price);
  const onlineTarget = money(decision.online_price);
  const reason = text(decision.reason, "卡片审批通过");
  const author = authorFrom(req);
  const intents = [];

  if (["同意", "自定"].includes(decision.verdict) && target != null) {
    const intent = await insertIntent(client, row, decision, "门店", row.old_price, target, reason, author);
    if (intent) intents.push(intent);
  }

  if (onlineTarget != null) {
    for (const channel of onlineChannels(decision)) {
      const oldPrice = channel === "美团" ? row.mt_price : (channel === "饿了么" ? row.ele_price : null);
      const intent = await insertIntent(client, row, decision, channel, oldPrice, onlineTarget, reason, author);
      if (intent) intents.push({ ...intent, waiting_worker: channel !== "门店" });
    }
  }

  return { ...row, intents };
}
