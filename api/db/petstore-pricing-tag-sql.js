export const pricingTagBaseSelectSql = `
        sku.own_brand AS sku_own_brand,
        NULLIF(btrim(pm.brand), '') AS master_brand,
        gdc_raw.create_time AS gdc_create_time,
        pricing_labels.has_self_label, pricing_labels.has_traffic_label,`;

export const pricingTagBaseJoinSql = `
      LEFT JOIN LATERAL (
        SELECT ps.own_brand
        FROM petstore_skus ps
        WHERE ps.product_code = o.product_code
        ORDER BY ps.snapshot_date DESC NULLS LAST
        LIMIT 1
      ) sku ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(bool_or(label->>'labelName' = '自营'), false) AS has_self_label,
          COALESCE(bool_or(label->>'labelName' IN ('热销', '主推')), false) AS has_traffic_label
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(pm.label_list) = 'array' THEN pm.label_list ELSE '[]'::jsonb END
        ) label
      ) pricing_labels ON true
      LEFT JOIN LATERAL (
        SELECT NULLIF(r.raw_payload->>'createTime', '') AS create_time
        FROM gdc_product_profile_raw r
        WHERE r.store_code = '63350001'
          AND r.product_code = o.product_code
        ORDER BY r.fetched_at DESC, r.batch_id DESC
        LIMIT 1
      ) gdc_raw ON true`;

export const pricingTagSelectSql = `
      CASE
        WHEN master_brand IS NOT NULL AND COALESCE(sku_own_brand, 0) <> 1 THEN '品牌款(控价)'
        WHEN COALESCE(sku_own_brand, 0) = 1 OR COALESCE(has_self_label, false) THEN '自家品(高利润)'
        WHEN COALESCE(has_traffic_label, false) THEN '流量品'
        WHEN gdc_create_time ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND gdc_create_time::timestamp >= now() - interval '90 days' THEN '新品'
        ELSE '普通品'
      END AS pricing_tag,`;
