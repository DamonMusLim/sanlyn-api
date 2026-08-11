// 录单执行器·写入层: 单事务 upsert(只填空不覆盖) + intake_jobs/task_events 同事务留痕
import { getPool } from "../db.js";

export async function writeIntake(payload, verify, actor) {
  const pool = getPool();
  const client = await pool.connect();
  const doc = payload.doc, items = payload.items;
  const out = { fer: null, declaration: null, items: 0, existed: [], job_id: null };
  try {
    await client.query("BEGIN");

    // 1) 退税锚 finance_export_rebates (幂等: customs_no 唯一索引)
    const fer = await client.query(
      `INSERT INTO finance_export_rebates(customs_no, contract_no, export_date, fob_foreign, currency, exchange_rate, fob_cny, status, note, created_at, updated_at)
       VALUES($1,$2,$3,$4,'CNY',1,$4,$5,$6,now(),now())
       ON CONFLICT (customs_no) DO NOTHING
       RETURNING customs_no, fob_cny`,
      [verify.normalized.customs_no, doc.contract_no, doc.export_date, verify.normalized.total,
       verify.normalized.official ? "entered" : "draft",
       `[customs-intake] bl=${doc.bl_no} sha=${payload.file_sha256.slice(0, 12)} ${doc.note || ""}`.trim()]);
    if (fer.rowCount) out.fer = fer.rows[0]; else out.existed.push("finance_export_rebates");

    // 2) 报关单主记录 (幂等: declaration_no 唯一索引)
    const d = await client.query(
      `INSERT INTO customs_declarations(declaration_no, shipping_plan_id, owner_company_id, declaration_status, transaction_term, transport_mode, supervision_mode, duty_exemption, total_declaration_amount, total_declaration_currency, container_nos, declared_at, raw, created_at, updated_at)
       SELECT $1, sp._id, 37, $2, $3, '水路运输', '0110 一般贸易', '101 一般征税', $4, 'CNY',
              CASE WHEN $5::text <> '' THEN string_to_array($5::text, ',') END, $6::timestamp,
              $7::jsonb, now(), now()
         FROM shipping_plans sp
        WHERE BTRIM(sp.bl_no) = BTRIM($8) AND sp.deleted_at IS NULL
        ORDER BY sp.updated_at DESC NULLS LAST LIMIT 1
       ON CONFLICT (declaration_no) DO NOTHING
       RETURNING id, declaration_no`,
      [verify.normalized.customs_no, verify.normalized.official ? "cleared" : "draft",
       doc.transaction_term || "FOB", verify.normalized.total, doc.containers || "",
       doc.export_date, JSON.stringify({ source: payload.source || "customs-intake", file_sha256: payload.file_sha256, doc }),
       doc.bl_no]);
    let declId = d.rowCount ? d.rows[0].id : null;
    if (d.rowCount) out.declaration = d.rows[0].declaration_no;
    else {
      const ex = await client.query("SELECT id FROM customs_declarations WHERE declaration_no=$1", [verify.normalized.customs_no]);
      declId = ex.rows[0] && ex.rows[0].id; out.existed.push("customs_declarations");
    }

    // 3) 行项 (该单已有行项则跳过, 不覆盖)
    if (declId) {
      const has = await client.query("SELECT 1 FROM customs_declaration_items WHERE declaration_id=$1 LIMIT 1", [declId]);
      if (!has.rowCount) {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `INSERT INTO customs_declaration_items(declaration_id, owner_company_id, sort_order, hs_code, declaration_name_cn, declaration_elements, qty, unit, gross_weight_kg, net_weight_kg, declaration_amount, declaration_currency, unit_price, country_of_origin, destination_country, fob_usd, fob_usd_source, source_type, created_at, updated_at)
             VALUES($1,37,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,'中国(CHN)',$12,NULL,'pending_official_number','broker_manual',now(),now())`,
            [declId, i + 1, it.hs_code, it.name_cn, it.elements || null, it.qty, it.unit || "件",
             it.gross_kg || null, it.net_kg || null, it.amount, it.unit_price || null,
             doc.destination || "马来西亚(MYS)"]);
          out.items++;
        }
      } else out.existed.push("customs_declaration_items");
    }

    // 4) 可选: 合同号补进海运票数组(号系错位解), 只增不删
    if (Array.isArray(payload.plan_link_contracts) && payload.plan_link_contracts.length) {
      await client.query(
        `UPDATE shipping_plans SET contract_nos =
           (SELECT ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(contract_nos,'{}'::text[]) || $1::text[]) x))
         WHERE BTRIM(bl_no) = BTRIM($2) AND deleted_at IS NULL`,
        [payload.plan_link_contracts, doc.bl_no]);
    }

    // 5) 审计: intake_jobs(append-only) + task_events, 与写库同事务
    const job = await client.query(
      `INSERT INTO intake_jobs(file_sha256, doc_type, payload, verify_result, status, actor, model, created_at)
       VALUES($1,'customs_declaration',$2::jsonb,$3::jsonb,$4,$5,$6,now()) RETURNING id`,
      [payload.file_sha256, JSON.stringify(payload), JSON.stringify(verify),
       payload.override_reason ? "overridden" : "written", actor, payload.model || "manual"]);
    out.job_id = job.rows[0].id;
    await client.query(
      `INSERT INTO public.tasks(id, title, reason, status, source, created_at)
       VALUES('customs-intake','录单执行器·审计流','intake_jobs 审计事件挂靠(常驻)','open','customs-intake',now())
       ON CONFLICT (id) DO NOTHING`);
    await client.query(
      `INSERT INTO task_events(task_id, event_type, actor_type, actor_id, note, created_at)
       VALUES('customs-intake','intake_written','ai',$1,$2,now())`,
      [actor, `${verify.normalized.customs_no} ¥${verify.normalized.total} job#${out.job_id}${payload.override_reason ? " OVERRIDE:" + payload.override_reason : ""}`]);

    await client.query("COMMIT");
    // 回读(事务外): 端点响应即验收
    const rb = await pool.query(
      `SELECT d.declaration_no, d.total_declaration_amount, COUNT(i.id) AS items, COALESCE(SUM(i.declaration_amount),0) AS items_sum
         FROM customs_declarations d LEFT JOIN customs_declaration_items i ON i.declaration_id=d.id
        WHERE d.declaration_no=$1 GROUP BY 1,2`, [verify.normalized.customs_no]);
    out.readback = rb.rows[0] || null;
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
