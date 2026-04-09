// /api/db/seed-oss-local-charges.js
// One-time migration: import local_charges.json from OSS into local_charges table
// GET this endpoint once to seed / re-sync all records
import { getPool, setCors } from "../db.js";

// ─── Data from sanlyn-files/data/local_charges.json ───
const OSS_RECORDS = [
  {
    carrier:"ESL", pol:"Xiamen", pod:"Port Klang Westport",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:1649, sell_total:1649,
    free_time:{text:"14天混"}, remarks:"",
    raw:{_id:"6954de080ff79ad5fab8a2f3",code:"GZ00001",blType:"SWB",enabled:"是",updatedAt:"2026-01-14"},
    fees:[
      {feeName:"电放费",direction:"应付",unitPrice:300,qty:0,unit:"票",currency:"CNY",amount:0},
      {feeName:"文件费",direction:"应付",unitPrice:400,qty:1,unit:"票",currency:"CNY",amount:400},
      {feeName:"信息费",direction:"应付",unitPrice:5,qty:1,unit:"票",currency:"CNY",amount:5},
      {feeName:"单证操作费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"THC",direction:"应付",unitPrice:979,qty:1,unit:"40HQ",currency:"CNY",amount:979},
      {feeName:"封签费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"设备交接单",direction:"应付",unitPrice:35,qty:1,unit:"40HQ",currency:"CNY",amount:35},
      {feeName:"操作费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
    ],
  },
  {
    carrier:"MSC", pol:"Ningbo-Zhoushan", pod:"Port Klang Westport",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:5067, sell_total:5602,
    free_time:{text:"14天混"}, remarks:"",
    raw:{_id:"695b8fdf1cbe05683b096d54",code:"GZ00003",blType:"电放",enabled:"是",updatedAt:"2026-01-14"},
    fees:[
      {feeName:"海铁费",direction:"应付",unitPrice:2800,qty:1,unit:"40HQ",currency:"CNY",amount:2800},
      {feeName:"订舱费",direction:"应付",unitPrice:350,qty:1,unit:"40HQ",currency:"CNY",amount:350},
      {feeName:"THC",direction:"应付",unitPrice:1012,qty:1,unit:"40HQ",currency:"CNY",amount:1012},
      {feeName:"文件费",direction:"应付",unitPrice:450,qty:1,unit:"票",currency:"CNY",amount:450},
      {feeName:"箱单费",direction:"应付",unitPrice:35,qty:1,unit:"40HQ",currency:"CNY",amount:35},
      {feeName:"EDI",direction:"应付",unitPrice:10,qty:1,unit:"票",currency:"CNY",amount:10},
      {feeName:"电子箱单",direction:"应付",unitPrice:10,qty:1,unit:"40HQ",currency:"CNY",amount:10},
      {feeName:"电放费",direction:"应付",unitPrice:300,qty:1,unit:"票",currency:"CNY",amount:300},
      {feeName:"操作费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
    ],
  },
  {
    carrier:"COSCO", pol:"Qingdao", pod:"Port Klang Westport",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:2713, sell_total:2713,
    free_time:{text:"14天混"}, remarks:"",
    raw:{_id:"6966fdd14e1634dce9ee80a0",code:"GZ00004",blType:"SWB",enabled:"是",updatedAt:"2026-02-18"},
    fees:[
      {feeName:"THC",direction:"应付",unitPrice:1034,qty:1,unit:"40HQ",currency:"CNY",amount:1034},
      {feeName:"提箱费",direction:"应付",unitPrice:276,qty:1,unit:"40HQ",currency:"CNY",amount:276},
      {feeName:"场站费",direction:"应付",unitPrice:400,qty:1,unit:"40HQ",currency:"CNY",amount:400},
      {feeName:"港口包干费",direction:"应付",unitPrice:43,qty:1,unit:"40HQ",currency:"CNY",amount:43},
      {feeName:"设备交接单费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"港杂费",direction:"应付",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"封志费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"文件费",direction:"应付",unitPrice:450,qty:1,unit:"票",currency:"CNY",amount:450},
      {feeName:"VGM",direction:"应付",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"出口服务费",direction:"应付",unitPrice:50,qty:1,unit:"票",currency:"CNY",amount:50},
      {feeName:"订舱费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"操作费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"舱单费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
    ],
  },
  {
    carrier:"COSCO", pol:"Wuhan Tianhe", pod:"Johor (Pasir Gudang)",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:4561, sell_total:4561,
    free_time:{text:"14天混"},
    remarks:"装柜地址：湖北省黄冈市武穴市北川路39号 武汉海铁，厦门出",
    raw:{_id:"69677bffcfac6aaaab769411",code:"GZ00005",blType:"电放",enabled:"是",updatedAt:"2026-01-14"},
    fees:[
      {feeName:"文件费",direction:"应付",unitPrice:500,qty:1,unit:"票",currency:"CNY",amount:500},
      {feeName:"报关费",direction:"应付",unitPrice:200,qty:1,unit:"票",currency:"CNY",amount:200},
      {feeName:"订舱费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"信息费",direction:"应付",unitPrice:5,qty:1,unit:"票",currency:"CNY",amount:5},
      {feeName:"出口服务费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"电放费",direction:"应付",unitPrice:300,qty:1,unit:"票",currency:"CNY",amount:300},
      {feeName:"THC",direction:"应付",unitPrice:1096,qty:1,unit:"40HQ",currency:"CNY",amount:1096},
      {feeName:"封志费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"设备交接单费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"操作费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"拖车费",direction:"应收",unitPrice:2100,qty:1,unit:"40HQ",currency:"CNY",amount:2100},
    ],
  },
  {
    carrier:"COSCO", pol:"Wuhan Tianhe", pod:"Johor (Pasir Gudang)",
    company_name:"万汇恒通(厦门)国际物流有限公司",
    container_type:"40hq", cost_total:2775, sell_total:2775,
    free_time:{text:"14天混"},
    remarks:"黄冈-武汉-厦门-巴西古单 (拖车+铁路+驳船) ETD WUHAN 1.23",
    raw:{_id:"69677cd30ef472040929b360",code:"GZ00006",blType:"电放",enabled:"是",updatedAt:"2026-01-14"},
    fees:[
      {feeName:"电放费",direction:"应付",unitPrice:300,qty:1,unit:"票",currency:"CNY",amount:300},
      {feeName:"报关费",direction:"应付",unitPrice:150,qty:1,unit:"票",currency:"CNY",amount:150},
      {feeName:"舱单费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"VGM",direction:"应付",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"拖车费",direction:"应付",unitPrice:2175,qty:1,unit:"40HQ",currency:"CNY",amount:2175},
    ],
  },
  {
    carrier:"MSC", pol:"Xiamen", pod:"Port Klang Westport",
    company_name:"万汇恒通(厦门)国际物流有限公司",
    container_type:"40hq", cost_total:1772, sell_total:1872,
    free_time:{text:""},
    remarks:"",
    raw:{_id:"69709614e2cefc10b26dc20b",code:"GZ00007",blType:"SWB",enabled:"是",updatedAt:"2026-03-02"},
    fees:[
      {feeName:"THC",direction:"应收",unitPrice:1012,qty:1,unit:"40HQ",currency:"",amount:1012},
      {feeName:"文件费",direction:"应收",unitPrice:450,qty:1,unit:"票",currency:"",amount:450},
      {feeName:"订舱费",direction:"应收",unitPrice:105,qty:1,unit:"票",currency:"",amount:105},
      {feeName:"封志费",direction:"应收",unitPrice:30,qty:1,unit:"40HQ",currency:"",amount:30},
      {feeName:"设备交接单费",direction:"应收",unitPrice:25,qty:1,unit:"40HQ",currency:"",amount:25},
      {feeName:"VGM",direction:"应收",unitPrice:50,qty:1,unit:"40HQ",currency:"",amount:50},
      {feeName:"舱单费",direction:"应收",unitPrice:100,qty:1,unit:"票",currency:"",amount:100},
    ],
  },
  {
    carrier:"COSCO", pol:"Xiamen", pod:"Port Klang Westport",
    company_name:"福建全力供应链管理有限公司",
    container_type:"40hq", cost_total:1924, sell_total:1924,
    free_time:{text:"14天混"},
    remarks:"",
    raw:{_id:"6971f56f276040627f4b0596",code:"GZ00008",blType:"SWB",enabled:"是",updatedAt:"2026-01-22"},
    fees:[
      {feeName:"THC",direction:"应付",unitPrice:1112,qty:1,unit:"40HQ",currency:"CNY",amount:1112},
      {feeName:"文件费",direction:"应付",unitPrice:500,qty:1,unit:"票",currency:"CNY",amount:500},
      {feeName:"信息费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"订舱费",direction:"应付",unitPrice:102,qty:1,unit:"票",currency:"CNY",amount:102},
      {feeName:"封志费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"操作费",direction:"应收",unitPrice:150,qty:1,unit:"票",currency:"CNY",amount:150},
    ],
  },
  {
    carrier:"COSCO", pol:"Tianjin", pod:"Port Klang Westport",
    company_name:"天津同顺源达国际货运代理有限公司",
    container_type:"20gp", cost_total:2792, sell_total:2792,
    free_time:{text:"14天混"},
    remarks:"",
    raw:{_id:"69735b74ff27dd1ea4835927",code:"GZ00009",blType:"电放",enabled:"是",updatedAt:"2026-01-23"},
    fees:[
      {feeName:"THC",direction:"应付",unitPrice:680,qty:1,unit:"20PG",currency:"CNY",amount:680},
      {feeName:"港杂费",direction:"应付",unitPrice:202,qty:1,unit:"20PG",currency:"CNY",amount:202},
      {feeName:"舱单费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"文件费",direction:"应付",unitPrice:500,qty:1,unit:"票",currency:"CNY",amount:500},
      {feeName:"CHC",direction:"应付",unitPrice:25,qty:1,unit:"20PG",currency:"CNY",amount:25},
      {feeName:"安保费",direction:"应付",unitPrice:15,qty:1,unit:"20PG",currency:"CNY",amount:15},
      {feeName:"VGM",direction:"应付",unitPrice:20,qty:1,unit:"20PG",currency:"CNY",amount:20},
      {feeName:"封志费",direction:"应付",unitPrice:50,qty:1,unit:"20PG",currency:"CNY",amount:50},
      {feeName:"场装费",direction:"应付",unitPrice:750,qty:1,unit:"20PG",currency:"CNY",amount:750},
      {feeName:"电放费",direction:"应付",unitPrice:450,qty:1,unit:"20PG",currency:"CNY",amount:450},
    ],
  },
  {
    carrier:"MSK", pol:"Tianjin", pod:"Kota Kinabalu",
    company_name:"天津惠禾国际货运代理有限责任公司",
    container_type:"40hq", cost_total:2114, sell_total:2114,
    free_time:{text:"14天混"},
    remarks:"电放450",
    raw:{_id:"6981d098bdb5c32e916f2534",code:"GZ00010",blType:"SWB",enabled:"是",updatedAt:"2026-02-03"},
    fees:[
      {feeName:"港杂费",direction:"应付",unitPrice:432,qty:1,unit:"40HQ",currency:"CNY",amount:432},
      {feeName:"THC",direction:"应付",unitPrice:950,qty:1,unit:"40HQ",currency:"CNY",amount:950},
      {feeName:"安保费",direction:"应付",unitPrice:12,qty:1,unit:"40HQ",currency:"CNY",amount:12},
      {feeName:"CHC",direction:"应付",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"设备管理费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"VGM",direction:"应付",unitPrice:20,qty:1,unit:"40HQ",currency:"CNY",amount:20},
      {feeName:"舱单费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"文件费",direction:"应付",unitPrice:450,qty:1,unit:"票",currency:"CNY",amount:450},
    ],
  },
  {
    carrier:"COSCO", pol:"Qingdao", pod:"Port Klang Westport",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:2713, sell_total:2713,
    free_time:{text:"7+14"},
    remarks:"",
    raw:{_id:"69afa6095302bdc7b50229ea",code:"GZ00012",blType:"SWB",enabled:"是",voyageNo:"TIAN CHANG HE 113S",updatedAt:"2026-03-11"},
    fees:[
      {feeName:"舱单费",direction:"应收",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"出口服务费",direction:"应收",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"场站费",direction:"应收",unitPrice:400,qty:1,unit:"40HQ",currency:"CNY",amount:400},
      {feeName:"订舱费",direction:"应收",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"文件费",direction:"应收",unitPrice:450,qty:1,unit:"40HQ",currency:"CNY",amount:450},
      {feeName:"港口作业费",direction:"应收",unitPrice:24,qty:1,unit:"40HQ",currency:"CNY",amount:24},
      {feeName:"港杂费",direction:"应收",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"铅封费",direction:"应收",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"设备交接单",direction:"应收",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"THC",direction:"应收",unitPrice:1034,qty:1,unit:"40HQ",currency:"CNY",amount:1034},
      {feeName:"提箱费",direction:"应收",unitPrice:276,qty:1,unit:"40HQ",currency:"CNY",amount:276},
      {feeName:"VGM",direction:"应收",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"综合服务费",direction:"应收",unitPrice:19,qty:1,unit:"40HQ",currency:"CNY",amount:19},
      {feeName:"操作费",direction:"应收",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
    ],
  },
  // ── 青岛 OOCL (code:11) ──
  {
    carrier:"OOCL", pol:"Qingdao", pod:"Port Kelang West",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:2621, sell_total:2621,
    free_time:{text:"目的港14天混"},
    remarks:"",
    raw:{_id:"694ceec15fcc0a9ee17fd3c6",code:"11",blType:"SWB",enabled:"是",updatedAt:"2026-01-22"},
    fees:[
      {feeName:"THC",direction:"应付",unitPrice:1070,qty:1,unit:"40HQ",currency:"CNY",amount:1070},
      {feeName:"提箱费",direction:"应付",unitPrice:296,qty:1,unit:"40HQ",currency:"CNY",amount:296},
      {feeName:"场站费",direction:"应付",unitPrice:400,qty:1,unit:"40HQ",currency:"CNY",amount:400},
      {feeName:"设备交接单费",direction:"应付",unitPrice:30,qty:1,unit:"40HQ",currency:"CNY",amount:30},
      {feeName:"VGM",direction:"应付",unitPrice:80,qty:1,unit:"40HQ",currency:"CNY",amount:80},
      {feeName:"封志费",direction:"应付",unitPrice:45,qty:1,unit:"40HQ",currency:"CNY",amount:45},
      {feeName:"港杂费",direction:"应付",unitPrice:50,qty:1,unit:"40HQ",currency:"CNY",amount:50},
      {feeName:"操作费",direction:"应付",unitPrice:100,qty:1,unit:"40HQ",currency:"CNY",amount:100},
      {feeName:"文件费",direction:"应付",unitPrice:450,qty:1,unit:"票",currency:"CNY",amount:450},
      {feeName:"舱单费",direction:"应付",unitPrice:100,qty:1,unit:"票",currency:"CNY",amount:100},
      {feeName:"电放费",direction:"应付",unitPrice:300,qty:0,unit:"票",currency:"CNY",amount:0},
    ],
  },
  // ── 锦州 COSCO (code:GZ00011) ──
  {
    carrier:"COSCO", pol:"Jinzhou", pod:"Port Klang Westport",
    company_name:"宁波中远海运物流有限公司江西分公司",
    container_type:"40hq", cost_total:84577, sell_total:84577,
    free_time:{text:""},
    remarks:"FENGXINDA27 076S",
    raw:{_id:"69a704034efd188f83d2f3c3",code:"GZ00011",blType:"SWB",enabled:"是",voyageNo:"FENGXINDA27 076S",updatedAt:"2026-03-03"},
    fees:[
      {feeName:"其他",direction:"应收",unitPrice:0,qty:1,unit:"",currency:"",amount:84577},
    ],
  },
];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS local_charges (
      id SERIAL PRIMARY KEY,
      carrier VARCHAR(50),
      pol VARCHAR(100),
      pod VARCHAR(100),
      company_name VARCHAR(200),
      container_type VARCHAR(20) DEFAULT '20GP',
      fees JSONB DEFAULT '[]',
      cost_total NUMERIC(10,2) DEFAULT 0,
      sell_total NUMERIC(10,2) DEFAULT 0,
      free_time JSONB DEFAULT '{}',
      remarks TEXT,
      raw JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const results = [];

  for (const rec of OSS_RECORDS) {
    // Check by OSS _id stored in raw
    const existing = await pool.query(
      "SELECT id FROM local_charges WHERE raw->>'_id' = $1 LIMIT 1",
      [rec.raw._id]
    );

    if (existing.rowCount > 0) {
      await pool.query(
        `UPDATE local_charges
         SET carrier=$1, pol=$2, pod=$3, company_name=$4, container_type=$5,
             fees=$6, cost_total=$7, sell_total=$8, free_time=$9,
             remarks=$10, raw=$11, updated_at=NOW()
         WHERE id=$12`,
        [
          rec.carrier, rec.pol, rec.pod, rec.company_name, rec.container_type,
          JSON.stringify(rec.fees), rec.cost_total, rec.sell_total,
          JSON.stringify(rec.free_time), rec.remarks, JSON.stringify(rec.raw),
          existing.rows[0].id,
        ]
      );
      results.push({ id: existing.rows[0].id, action: "updated", code: rec.raw.code });
    } else {
      const r = await pool.query(
        `INSERT INTO local_charges
           (carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, free_time, remarks, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          rec.carrier, rec.pol, rec.pod, rec.company_name, rec.container_type,
          JSON.stringify(rec.fees), rec.cost_total, rec.sell_total,
          JSON.stringify(rec.free_time), rec.remarks, JSON.stringify(rec.raw),
        ]
      );
      results.push({ id: r.rows[0].id, action: "inserted", code: rec.raw.code });
    }
  }

  const total = await pool.query("SELECT COUNT(*) FROM local_charges");
  return res.status(200).json({
    success: true,
    migrated: results.length,
    operations: results,
    total_in_table: parseInt(total.rows[0].count),
  });
}
