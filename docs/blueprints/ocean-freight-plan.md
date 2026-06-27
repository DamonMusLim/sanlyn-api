# 🚢 海运模块规划 + 代码拆分蓝图 v1.0
> 起草：2026-05-02
> 触发：CustomerLogistics.jsx 2970 行，严重超 600 行铁律
> UI 已完成（截图为证），重点是拆代码 + 打通数据流

---

## 第一部分：代码拆分计划

### 现状违规
- 单文件 2970 行 = 600 行铁律的 5 倍
- 主组件 `CustomerLogisticsTab` 占 1224 行，最严重
- 内嵌 14 个子组件 + 1 个 styles 注入 + 1 个数据 hook

### 目标结构（按 Atom/Molecule/Screen 三层）

```
app/components/src/screens/customer/logistics/
├── CustomerLogistics.jsx              ← 入口 + 路由（< 250 行）
│
├── data/
│   ├── ports.js                       ← 端口列表、status maps      ~30
│   ├── styles.js                      ← keyframes + 样式常量       ~150
│   └── useLogisticsData.js            ← 数据加载 hook              ~80
│
├── hub/                               ← Logistics Hub 主页（截图那张）
│   ├── HubHome.jsx                    ← 主布局，组合下面的卡       ~250
│   ├── ChooseRouteCard.jsx            ← Step 1 POL/POD 选路        ~150
│   ├── ShippableOrdersPanel.jsx       ← 右侧 Ready/Producing 列    ~120
│   ├── TargetPriceCard.jsx            ← Name Your Target Price     ~150
│   ├── VesselTrackingCard.jsx         ← Live Vessel Tracking       ~80
│   └── MarketRatesBoard.jsx           ← Market Rates LIVE          ~160
│
├── schedule/                          ← This Week's Sailings
│   ├── ScheduleCard.jsx               ~92
│   ├── ScheduleRateTable.jsx          ~80
│   └── BookConfirmModal.jsx           ~94
│
├── screens/                           ← 子页面
│   ├── DDPScreen.jsx                  ~130
│   ├── QuoteScreen.jsx                ~395 （边界，可再拆 form/list）
│   ├── FactoryPortalScreen.jsx        ~232
│   └── RateCard.jsx                   ~149
│
└── shared/                            ← 跨页复用
    ├── MiniPipeline.jsx               ~32
    ├── Services.jsx                   ~80
    ├── FactoryContactSection.jsx      ~90
    └── useFactoryList.js              ~37
```

### 拆分后所有文件 ≤ 400 行 ✅

### 拆分顺序（避免一次大改打断业务）

**Phase 1（半天，最低风险）**：抽 helpers + 静态组件
1. styles.js / ports.js（无依赖，复制走）
2. MiniPipeline / Services / FactoryContactSection / useFactoryList
3. 验证页面无变化

**Phase 2（半天）**：抽 schedule 三件套 + RateCard / DDPScreen
4. ScheduleCard / ScheduleRateTable / BookConfirmModal
5. RateCard / DDPScreen / FactoryPortalScreen
6. 验证 Inquiry/DDP 流程

**Phase 3（1天）**：抽 Hub 主页（截图那张）
7. ChooseRouteCard
8. ShippableOrdersPanel
9. TargetPriceCard
10. VesselTrackingCard
11. MarketRatesBoard
12. HubHome.jsx 组合
13. 主入口 CustomerLogistics.jsx 改成路由壳

**Phase 4（半天）**：抽 QuoteScreen
14. QuoteScreen → QuoteForm + QuoteList + useQuoteState

总计 **2-3 天**，每个 Phase 跑完都能正常上线。

---

## 第二部分：海运业务规划

### 现状诊断（截图所示）
| 模块 | 状态 | 数据问题 |
|------|------|---------|
| Choose Route | UI 完成 | freight_rates 不全 |
| Shippable Orders | UI 完成 | **0 READY**（actDelivery 没值） |
| This Week's Sailings | UI 完成 | OOCL 那条字段空 |
| Target Price (异步竞价) | UI 完成 | 没有供应商账号接收 |
| Vessel Tracking | UI 完成 | IDLE（无在途 BL） |
| Market Rates | UI 完成 | 6 lanes 数据 OK |

### 关键洞察
**代码 95% 已完成，瓶颈全在数据层**。

### 优先级路线图

#### P0 · 数据流打通（本周）
- **a. 工厂确认备货 → Ready**
  - 现有：工厂端 V3 Delivery Center 有"Ready"按钮
  - 待查：36 个 producing 订单工厂为啥不点
  - 行动：抽 5 单看流程，做用户教育或 UX 修
- **b. freight_rates 周更新**
  - AdminPanel 加录入页（或 Excel 导入）
  - 每周一更新本周航次
- **c. shipping_agency_bookings 表已有**（migrate-freight.js）
  - 福新的代运单可以直接落库

#### P1 · 体验提升（下周）
- **d. Sailings 时刻表完整化**：每条航线 ETD/船名/截关日
- **e. Async Bidding 后端**：货代账号 + 报价收件箱
- **f. 代运订单 Order Type**（蓝图已存）

#### P2 · 自动化（稳定后）
- **g. Vessel Tracking API**：船司接口自动更新 ETA
- **h. 报价单 PDF 自动出**

---

## 第三部分：行动建议

**现在最值得做的：先拆代码**

理由：
1. 600 行铁律已严重违反，再加功能会更乱
2. 数据层问题需要去找用户/工厂沟通，不是写代码
3. 拆完后增加 Freight Agency / 议价 / BOM 等功能都好接

**拆完之后再回头处理数据：**
- 36 个 producing 订单工厂为什么不确认 Ready
- freight_rates 谁来周更
- bidding 系统要不要做 supplier portal

---

## 备忘
- 拆分后每个文件加 header 注释：路径 + 用途 + 引用关系
- 用 git 单独 PR 提交每个 Phase
- 每 Phase 跑完做一次 `npm run build` + 浏览器冒烟测试
- dist/ 在 git 里，最后 push 触发 CI

