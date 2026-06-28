# sanlyn-api

Sanlyn OS 的 API 代理服务，部署在 Vercel。

## 部署步骤

### 1. 推送到 GitHub
```bash
cd sanlyn-api
git init
git add .
git commit -m "init: vessel-track API proxy"
# 在 GitHub 新建仓库 sanlyn-api，然后：
git remote add origin https://github.com/DamonMusLim/sanlyn-api.git
git push -u origin main
```

### 2. Vercel 导入项目
- 访问 vercel.com → Add New Project
- 导入 sanlyn-api 仓库
- 环境变量添加：
  - `PORTUN_APP_ID` = `SHYBB`
  - `PORTUN_SECRET` = `+I(yuq!AQOBrc9gB`
- 部署域名建议设为: `api.sanlynos.com`

### 3. 前端调用
```js
fetch('https://api.sanlynos.com/api/vessel-track?blNo=COAU7265736800')
```

## 接口

### GET /api/vessel-track?blNo=提单号

返回：
```json
{
  "blNo": "COAU7265736800",
  "vesselName": "MSC ANNA",
  "voyageNo": "025W",
  "pol": "Qingdao",
  "pod": "Port Klang",
  "etd": "2026-01-10",
  "eta": "2026-01-25",
  "currentPosition": { "lat": 5.3, "lng": 103.2 },
  "latestEvent": { "code": "DLPT", "label": "已离港", ... },
  "events": [...]
}
```
