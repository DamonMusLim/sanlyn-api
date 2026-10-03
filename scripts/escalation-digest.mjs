// No transport of its own: use the cron's payload builder, sender and recorders.
export async function escalationDigest(candidates, {
  live, staged, pool, chainFor, shouldPushDamon, keyFor, payloadFor,
  pushNotify, reserveAttempt, markSentAndAdvance,
  threshold = Number(process.env.ESCALATION_DIGEST_THRESHOLD || 10),
  log = console.log, error = console.error,
}) {
  const result = { handled: new Set(), sent: 0, count: 0, failed: 0 };
  if (!staged) return result;
  const eligible = candidates.map((item) => ({ ...item, chainInfo: chainFor(item) }))
    .filter(({ stageInfo, chainInfo }) => !chainInfo.skipReason && shouldPushDamon(stageInfo, chainInfo))
    .map((item) => ({ ...item, key: keyFor(item) }));
  if (eligible.length <= threshold) return result;
  const { rows } = await pool.query(
    "SELECT idempotency_key FROM task_push_attempts WHERE idempotency_key = ANY($1::text[])",
    [eligible.map((item) => item.key)],
  );
  const seen = new Set(rows.map((row) => row.idempotency_key));
  const pending = eligible.filter((item) => !seen.has(item.key));
  if (pending.length <= threshold) return result;

  const first = pending[0];
  const oneLine = (value) => String(value || "").replace(/[\r\n]+/g, " ");
  const body = pending.slice(0, 15).map(({ task, chainInfo, stageInfo }) =>
    `${oneLine(task.title)} | ${oneLine(chainInfo.chain)} | ${oneLine(stageInfo.reason)}`);
  if (pending.length > 15) body.push(`另有 ${pending.length - 15} 条`);
  const payload = {
    ...payloadFor(first.task, first.stageInfo, first.chainInfo),
    title: `SLA 升级积压 ${pending.length} 条(已到你这一级)`,
    count: String(pending.length),
    recommended_action: body.join("\n"),
  };
  result.handled = new Set(pending.map(({ task }) => task.id));
  result.count = pending.length;
  if (!live) {
    log(`[DRY DIGEST] ${JSON.stringify(payload)}`);
    return result;
  }
  try {
    await pushNotify(first.task, first.stageInfo, first.chainInfo, payload);
  } catch (err) {
    error(`[DIGEST ERR] ${err.message || err}; retry next run`);
    result.failed = 1;
    return result;
  }

  // Persist the same keys and task advancement together, only after delivery.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { task, stageInfo, key } of pending) {
      const attemptId = await reserveAttempt(client, key, task, stageInfo);
      if (attemptId) await markSentAndAdvance(client, attemptId, task, stageInfo);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  result.sent = 1;
  for (const { task, key } of pending) log(`[DIGEST] task=${task.id} key=${key}`);
  return result;
}
