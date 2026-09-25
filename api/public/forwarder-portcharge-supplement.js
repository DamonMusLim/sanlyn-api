import { setCors } from "../db.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  setCors(req, res, "OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  return send(res, 410, {
    ok: false,
    error: "deprecated",
    message: "货代港杂不再写我方账单表，请使用 forwarder-port-charge-basis POST 写 local_charges。",
  });
}
