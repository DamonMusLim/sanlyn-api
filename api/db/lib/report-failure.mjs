import { getPool } from "../db.js";

function cleanError(error) {
  if (!error) return { name: "Error", message: "unknown error", stack: "" };
  if (typeof error === "string") return { name: "Error", message: error, stack: "" };
  return {
    name: String(error.name || "Error").slice(0, 120),
    message: String(error.message || error).slice(0, 1000),
    stack: String(error.stack || "").slice(0, 4000),
  };
}

function safeContext(context) {
  try {
    return JSON.stringify(context || {});
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export async function reportFailure(source, error, context = {}, options = {}) {
  const err = cleanError(error);
  try {
    const pool = options.pool || getPool();
    await pool.query(
      `INSERT INTO job_failures(source, impact, error_name, error_message, error_stack, context)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (source, error_message) WHERE status='open'
       DO UPDATE SET last_seen_at=now(),
                     seen_count=job_failures.seen_count+1,
                     impact=COALESCE(EXCLUDED.impact, job_failures.impact),
                     error_name=EXCLUDED.error_name,
                     error_stack=EXCLUDED.error_stack,
                     context=EXCLUDED.context`,
      [
        String(source || "unknown").slice(0, 160),
        context?.impact ? String(context.impact).slice(0, 500) : null,
        err.name,
        err.message,
        err.stack,
        safeContext(context),
      ]
    );
  } catch (writeErr) {
    console.warn("[reportFailure]", source, err.message, writeErr.message);
  }
}
