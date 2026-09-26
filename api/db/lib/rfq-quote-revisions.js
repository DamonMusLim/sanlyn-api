export async function insertRfqQuoteRevision(client, rfqId, quote) {
  await client.query("SELECT id FROM rfq WHERE id=$1 FOR UPDATE", [rfqId]);
  const current = (await client.query(
    `SELECT id, revision_no
       FROM rfq_quotes
      WHERE rfq_id=$1
        AND supplier_company_code=$2
        AND is_current IS TRUE
      ORDER BY revision_no DESC NULLS LAST, id DESC
      FOR UPDATE`,
    [rfqId, quote.supplier_company_code]
  )).rows;
  const maxRev = (await client.query(
    `SELECT COALESCE(MAX(revision_no), 0) AS max_revision_no
       FROM rfq_quotes
      WHERE rfq_id=$1
        AND supplier_company_code=$2`,
    [rfqId, quote.supplier_company_code]
  )).rows[0]?.max_revision_no;
  const revisionNo = Number(maxRev || 0) + 1;
  const supersedesQuoteId = current[0]?.id || null;

  await client.query(
    `UPDATE rfq_quotes
        SET is_current=false, updated_at=NOW()
      WHERE rfq_id=$1
        AND supplier_company_code=$2
        AND is_current IS TRUE`,
    [rfqId, quote.supplier_company_code]
  );

  return (await client.query(
    `INSERT INTO rfq_quotes
      (rfq_id, supplier_company_code, supplier_item_code, supplier_spec_text,
       quote_date, valid_until, price_incl_tax, price_ex_tax, tax_pct,
       is_freight_included, moq, lead_time_days, currency, status, note,
       signed_by_name, signature_data, signed_at, signed_ip, signed_user_agent,
       revision_no, is_current, supersedes_quote_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,NOW(),$18,$19,$20,true,$21)
     RETURNING *`,
    [rfqId, quote.supplier_company_code, quote.supplier_item_code, quote.supplier_spec_text,
     quote.quote_date, quote.valid_until, quote.price_incl_tax, quote.price_ex_tax, quote.tax_pct,
     quote.is_freight_included, quote.moq, quote.lead_time_days, quote.currency, quote.status, quote.note,
     quote.signed_by_name, quote.signature_data, quote.signed_ip, quote.signed_user_agent,
     revisionNo, supersedesQuoteId]
  )).rows[0];
}
