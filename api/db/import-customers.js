// /api/db/import-customers.js
// GET  ?secret=xxx          — 一次性导入内置的63家公司（seed）
// POST ?secret=xxx  body: [{company_code,name_cn,name_en,country,...}]
//                          — 批量 upsert 任意公司数组（可重复执行）
import { getPool, setCors } from "../db.js";

const SEED_SECRET = process.env.IMPORT_SECRET || "sanlyn2026import";

const SEED_COMPANIES = [
{
"company_code": "CN-00063",
"name_cn": "",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "trucking",
"role_types": [
"Trucking (拖车/车队)"
]
},
{
"company_code": "CN-00062",
"name_cn": "山东威邦和供应链有限公司烟台分公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "15954506786",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)",
"Warehouse (仓储服务)"
]
},
{
"company_code": "CN-00001",
"name_cn": "万汇恒通(厦门)围际物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "中国（福建）自由贸易试验区厦门片区屿南四路7号自贸金融中心A栋303室",
"contact_tel": "",
"contact_email": "",
"role_type": "customs",
"role_types": [
"Customs Broker (报关行)",
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)"
]
},
{
"company_code": "CN-00002",
"name_cn": "浙江领尚包装科技有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "浙江杭州市余杭区东湖街道兴国路530号9幢3楼南",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00003",
"name_cn": "天津惠禾国际货运代理有限责任公司",
"name_en": "天津惠禾国际货运代理有限责任公司",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)"
]
},
{
"company_code": "CN-00004",
"name_cn": "富城山凌集团有限公司",
"name_en": "FORTUNESANLYN GROUP LIMITED",
"country": "",
"destination_port": "",
"address": "FLAT 03，15/F CARNIVAL COMMERCIAL BUILDING 18 JAVAROAD NORTH POINT HK",
"contact_tel": "18609058888",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00005",
"name_cn": "宣城福新宠物食品有限公司（客户）",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00006",
"name_cn": "深圳市禧运国际物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "ddp_agent",
"role_types": [
"DDP Agent (双清专线代理)"
]
},
{
"company_code": "CN-00007",
"name_cn": "畅至国际物流",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "ddp_agent",
"role_types": [
"DDP Agent (双清专线代理)"
]
},
{
"company_code": "CN-00008",
"name_cn": "雨鹤国际物流（深圳）有限公司",
"name_en": "Yuhe International Logistics (Shenzhen) Co. , Ltd",
"country": "",
"destination_port": "",
"address": "Longhua District Yuanfen Science and Technology Park Building E 701",
"contact_tel": "13725591183",
"contact_email": "1034322847@qq.com",
"role_type": "ddp_agent",
"role_types": [
"DDP Agent (双清专线代理)"
]
},
{
"company_code": "CN-00009",
"name_cn": "",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "13246121666",
"contact_email": "3186693@qq.com",
"role_type": "ddp_agent",
"role_types": [
"DDP Agent (双清专线代理)"
]
},
{
"company_code": "CN-00010",
"name_cn": "海管家",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "insurance",
"role_types": [
"Insurance (保险公司)",
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00011",
"name_cn": "",
"name_en": "Giant Mei Global Co., Ltd",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "",
"role_types": []
},
{
"company_code": "CN-00012",
"name_cn": "河北悦佰兔箱包制造有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "河北省保定市白沟  东岳街9号。  悦佰兔院里",
"contact_tel": "15030262775",
"contact_email": "414609714@qq.com",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00013",
"name_cn": "广州润聪电子商务有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "18022578613",
"contact_email": "",
"role_type": "",
"role_types": []
},
{
"company_code": "CN-00014",
"name_cn": "长兴鸭嘴兽国际物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "trucking",
"role_types": [
"Trucking (拖车/车队)"
]
},
{
"company_code": "CN-00015",
"name_cn": "霸州市天缘塑料冲压制品厂",
"name_en": "",
"country": "",
"destination_port": "",
"address": "河北省霸州市开发区赵家务二村",
"contact_tel": "13785601113",
"contact_email": "hb573469369@126.com",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00016",
"name_cn": "上海洋宝宝国际物流有限公司",
"name_en": "Shanghai Ocean Baby International Logistics Co.,Ltd.",
"country": "",
"destination_port": "",
"address": "Room 303, No. 43 Guoqing Road, Jing'an District, Shanghai",
"contact_tel": "",
"contact_email": "",
"role_type": "internal",
"role_types": [
"Group（集团内部）",
"Co-loader (同行货代/订舱代理)",
"DDP Agent (双清专线代理)",
"Express (国际官方快递)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)",
"Insurance (保险公司)",
"Overseas Agent (目的港海外代理)",
"Warehouse (仓储服务)"
]
},
{
"company_code": "CN-00017",
"name_cn": "温州九福实业有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "浙江省温州市龙港市松阳路571-711号B区（温州康尔微晶玻璃有限公司内）四号楼三楼东边",
"contact_tel": "13336930192",
"contact_email": "电话:0577-68000080",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00018",
"name_cn": "青岛馨华和荣包装有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00019",
"name_cn": "福建利众诚食品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00020",
"name_cn": "潍坊华龙膨润土有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00021",
"name_cn": "揭阳市喜宠科技有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00022",
"name_cn": "天津同顺源达国际货运代理有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00023",
"name_cn": "厦门欣力通报关有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "customs",
"role_types": [
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00024",
"name_cn": "中国人民财产保险股份有限公司青岛市分公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "insurance",
"role_types": [
"Insurance (保险公司)"
]
},
{
"company_code": "CN-00025",
"name_cn": "锦州乐普物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "trucking",
"role_types": [
"Trucking (拖车/车队)"
]
},
{
"company_code": "CN-00026",
"name_cn": "厦门瀚龙国际物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "trucking",
"role_types": [
"Trucking (拖车/车队)"
]
},
{
"company_code": "CN-00027",
"name_cn": "青岛联畅源国际货运代理有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "customs",
"role_types": [
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00028",
"name_cn": "万汇恒通(厦门)国际物流有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "中国（福建）自由贸易试验区厦门片区（保税区）屿南四路7号自贸金融中心A栋3层03单元",
"contact_tel": "",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00029",
"name_cn": "福建全力供应链管理有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "trucking",
"role_types": [
"Trucking (拖车/车队)",
"Customs Broker (报关行)",
"Co-loader (同行货代/订舱代理)"
]
},
{
"company_code": "CN-00030",
"name_cn": "厦门寅丰泰供应链管理有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00031",
"name_cn": "",
"name_en": "AL BASHEK COMPANY",
"country": "",
"destination_port": "TRIPOLI",
"address": "SOAQALJOMA.PARK BE HAPPY.199,TRIPOLI,LIBYA",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00032",
"name_cn": "",
"name_en": "Magros Petcare SL",
"country": "SPAIN",
"destination_port": "",
"address": "Avenida la libertad numero 14, 5º planta, Camargo, Cantabria, Spain 39600",
"contact_tel": "34",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00033",
"name_cn": "宁波中远海运物流有限公司江西分公司",
"name_en": "COSCO SHIPPING LOGISTICS (NINGBO)CO., LTD JIANGXI BRANCH",
"country": "",
"destination_port": "",
"address": "R2112,NANCHANG IFC,NO.1619 HONGGU MIDDLE AVENUE,HONGGUTAN NEW DISTRICT,NANCHANG,CHINA",
"contact_tel": "",
"contact_email": "",
"role_type": "forwarder",
"role_types": [
"Co-loader (同行货代/订舱代理)",
"Trucking (拖车/车队)",
"Customs Broker (报关行)"
]
},
{
"company_code": "CN-00034",
"name_cn": "富城山凌集团有限公司",
"name_en": "FORTUNESANLYN GROUP LIMITED",
"country": "",
"destination_port": "",
"address": "FLAT 03，15/F CARNIVAL COMMERCIAL BUILDING 18 JAVAROAD NORTH POINT HK",
"contact_tel": "18609058888",
"contact_email": "",
"role_type": "seller",
"role_types": [
"Seller（销售公司）"
]
},
{
"company_code": "CN-00035",
"name_cn": "厦门巴匕进出口有限公司",
"name_en": "XIAMEN PET BABY IMPORT AND EXPORT CO.,LTD",
"country": "",
"destination_port": "",
"address": "4TH FLOOR,26-9#HUARONG ROAD,HULI,XIAMEN,CHINA",
"contact_tel": "18609058888",
"contact_email": "",
"role_type": "seller",
"role_types": [
"Seller（销售公司）"
]
},
{
"company_code": "CN-00036",
"name_cn": "",
"name_en": "Eversparkles Pte Ltd",
"country": "SINGAPORE",
"destination_port": "Singapore",
"address": "10 Anson Road, #10-11 International Plaza Singapore 079903",
"contact_tel": "6593830070",
"contact_email": "hello@eversparkles.com",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00037",
"name_cn": "",
"name_en": "PETSOME SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "LOT 1716,JALAN SG LONG,BATU 11,SG LONG,43000 KAJANG,SELANGOR",
"contact_tel": "603",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00038",
"name_cn": "",
"name_en": "PETSOME (EU) SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "LOT 1716,JALAN SG LONG,BATU 11,SG LONG,43000 KAJANG,SELANGOR",
"contact_tel": "603",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00039",
"name_cn": "",
"name_en": "DIBAQ (M) SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "LOT 1716,JALAN SG LONG,BATU 11,SG LONG,43000 KAJANG,SELANGOR",
"contact_tel": "603",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00040",
"name_cn": "",
"name_en": "ENRICH CHAMPION SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "NO.2 JALAN PERDANA 1A,TAMAN SEGAR PERDANA,43200 CHERAS,SELANGOR,MALAYSIA",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00041",
"name_cn": "",
"name_en": "BIRDS PALACE",
"country": "",
"destination_port": "Port Klang Westport",
"address": "12,DHAKA UNIVERSITY MARKET,KATABON,DHAKA 1000",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00042",
"name_cn": "",
"name_en": "JJ PET GROUP SDN BHD",
"country": "MALAYSIA",
"destination_port": "Kota Kinabalu",
"address": "Lot 1, Wei Hing Warehouse Jalan Bengkel Majlis Bandar Baru Penampang Jalan Bundusan 88300 Penampang Sabah, Malaysia",
"contact_tel": "6012",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00043",
"name_cn": "",
"name_en": "IMPORTADORA Y COMERCIALIZADORA CONSIGNA SPA",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00044",
"name_cn": "",
"name_en": "Giant Mei Global Co.,Ltd",
"country": "",
"destination_port": "",
"address": "ADD:14F.-9,NO.282,SHIZHENGN.2ND RD., XITUN DIST.,TAICHUNG CITY 407608, TAIWAN",
"contact_tel": "886",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00045",
"name_cn": "",
"name_en": "IMPORTADORA Y COMIMPORTADORA Y COMERCIALIZADORA ESENCIA SPA.",
"country": "",
"destination_port": "",
"address": "DR. BARROS BORGONO 246 PROVIDENCIA",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00046",
"name_cn": "",
"name_en": "PRO FEEDS PET PRODUCT SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "PT 14476.PERSIARAN BG PERDANA 2. TAMAN PERINDUSTRIAN BATU GAJAH PERDANA.31000 BATU GAJAH,PERAK,MALAYSIA",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00047",
"name_cn": "",
"name_en": "PET UNIVERSE NOURISH SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "30,JALAN SULAIMAN 1, TAMAN PUTRA SULAIMAN, 68000 AMPANG,SELANGOR",
"contact_tel": "12",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00048",
"name_cn": "",
"name_en": "HARMONIOUS HAPPY VENTURES SDN BHD",
"country": "MALAYSIA",
"destination_port": "Port Klang Westport",
"address": "Lot 6 Jalan CJ 1/5 Kawasan Perusahaan Cheras Jaya 43200 Cheras Selangor",
"contact_tel": "60",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00049",
"name_cn": "",
"name_en": "Global UnitedTech Pte Ltd",
"country": "SINGAPORE",
"destination_port": "",
"address": "10 Anson Road, #10-11, International Plaza, Singapore 079903",
"contact_tel": "65",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00050",
"name_cn": "",
"name_en": "PET UNIVERSE NOURISH (M) SDN BHD",
"country": "MALAYSIA",
"destination_port": "PORT KELANG WEST",
"address": "30, JALAN SULAIMAN 1, TAMAN PUTRA SULAIMAN 1,  68000 AMPANG, SELANGOR",
"contact_tel": "",
"contact_email": "",
"role_type": "customer",
"role_types": [
"Buyer（客户）"
]
},
{
"company_code": "CN-00051",
"name_cn": "烟台中宠食品股份有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00052",
"name_cn": "连云港中砂宠物用品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "江苏省连云港市灌云县图河镇董庄7组61号",
"contact_tel": "15366656048",
"contact_email": "867623700@qq.com",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00053",
"name_cn": "辽宁宠爱科技有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "辽宁省朝阳市建平县万寿街道朝阳建平经济开发区一期31号标房",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00054",
"name_cn": "邢台仕爵宠物食品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00055",
"name_cn": "福建泰迪宠物食品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "福建省漳州市华安县圣王大道39号",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00056",
"name_cn": "浙江欧悠可科技有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00057",
"name_cn": "山东爱舒乐卫生用品有限责任公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00058",
"name_cn": "宣城福新宠物食品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00059",
"name_cn": "福建真宠宠物食品有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "莆美镇树洞村377号",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00060",
"name_cn": "苏州春叶金属制品制造有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "新巷村1幢",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
},
{
"company_code": "CN-00061",
"name_cn": "恒安国际贸易有限公司",
"name_en": "",
"country": "",
"destination_port": "",
"address": "木浦路103号1201-01单元",
"contact_tel": "",
"contact_email": "",
"role_type": "factory",
"role_types": [
"Manufacturer（工厂）"
]
}
];

async function upsertCompanies(pool, companies) {
  let inserted = 0, updated = 0, errors = [];
  for (const c of companies) {
    try {
      const res = await pool.query(
        `INSERT INTO customers (_id,company_code,name_cn,name_en,country,destination_port,address,contact_tel,contact_email,role_type,role_types,is_active)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,true)
         ON CONFLICT (company_code) DO UPDATE SET
           name_cn=EXCLUDED.name_cn,
           name_en=EXCLUDED.name_en,
           country=CASE WHEN EXCLUDED.country!=\'\'  THEN EXCLUDED.country  ELSE customers.country  END,
           destination_port=CASE WHEN EXCLUDED.destination_port!=\'\'  THEN EXCLUDED.destination_port  ELSE customers.destination_port  END,
           address=CASE WHEN EXCLUDED.address!=\'\'  THEN EXCLUDED.address  ELSE customers.address  END,
           contact_tel=CASE WHEN EXCLUDED.contact_tel!=\'\'  THEN EXCLUDED.contact_tel  ELSE customers.contact_tel  END,
           contact_email=CASE WHEN EXCLUDED.contact_email!=\'\'  THEN EXCLUDED.contact_email  ELSE customers.contact_email  END,
           role_type=CASE WHEN EXCLUDED.role_type!=\'\'  THEN EXCLUDED.role_type  ELSE customers.role_type  END,
           role_types=EXCLUDED.role_types::jsonb,
           is_active=true, updated_at=NOW()
         RETURNING (xmax=0) AS inserted`,
        [c.company_code, c.name_cn||"", c.name_en||"", c.country||"",
         c.destination_port||"", c.address||"", c.contact_tel||"",
         c.contact_email||"", c.role_type||"",
         JSON.stringify(c.role_types||[])]
      );
      if (res.rows[0]?.inserted) inserted++; else updated++;
    } catch(e) {
      errors.push({ company_code: c.company_code, error: e.message });
    }
  }
  return { inserted, updated, errors };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = req.query.secret || req.headers["x-import-secret"];
  if (secret !== SEED_SECRET) {
    return res.status(401).json({ error: "Unauthorized. Pass ?secret=sanlyn2026import" });
  }

  const pool = await getPool();

  // GET — import built-in 63 seed companies
  if (req.method === "GET") {
    const result = await upsertCompanies(pool, SEED_COMPANIES);
    return res.json({
      ok: true,
      message: `导入完成: ${result.inserted} 新增, ${result.updated} 更新`,
      ...result
    });
  }

  // POST — import custom array from request body
  if (req.method === "POST") {
    const body = req.body;
    const companies = Array.isArray(body) ? body : body?.companies;
    if (!companies || !companies.length) {
      return res.status(400).json({ error: "Body must be a JSON array of company objects" });
    }
    const result = await upsertCompanies(pool, companies);
    return res.json({
      ok: true,
      message: `导入完成: ${result.inserted} 新增, ${result.updated} 更新`,
      total: companies.length,
      ...result
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
