function send(res, status, body){
  res.status(status).json(body);
}

async function hasDemoRows(pool, demoSetId){
  try {
    const { rows } = await pool.query(
      "SELECT 1 FROM demo.forwarder_shipping_plans WHERE demo_set_id = $1 LIMIT 1",
      [demoSetId]
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

function emptyDemoBody(token){
  return {
    ok:true,
    demo:true,
    forwarder_co:token.forwarder_co || "",
    company_id:token.company_id || null,
    preferred_carriers:[],
    lanes:[],
    carrier_catalog:[],
  };
}

export async function handleDemoGet(pool, token, res){
  if (!token.demo_set_id) {
    return send(res, 200, emptyDemoBody(token));
  }

  var hasRows = await hasDemoRows(pool, token.demo_set_id);
  if (!hasRows) return send(res, 200, emptyDemoBody(token));

  return send(res, 200, emptyDemoBody(token));
}
