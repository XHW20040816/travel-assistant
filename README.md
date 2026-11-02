# 行程规划师（Travel Assistant）

微信小程序 + 微信云开发的旅行规划工具。按「**介绍 → 攻略 → 规划 → 我的**」的路径使用：先在攻略页定目的地、看 AI 攻略速览，再带着目的地到规划页按兴趣偏好挑景点，最后生成三套可对比的行程，并查看路线、天气与点位导航。

地图、天气、POI 数据由云函数 `travelApi` 代理高德 / 百度 / 和风天气；攻略速览由云函数 `guideProxy` 调用 DeepSeek 生成，**不抓取小红书、抖音等平台的站内内容**，只提供对应平台的真实搜索链接。

---

## 功能概览

| 模块 | 页面 | 主要能力 |
|---|---|---|
| 介绍 | `pages/guideHelp/guideHelp` | 三步使用说明、模块介绍、常见问题、快速入口 |
| 攻略 | `pages/guide/guide` | 按平台生成 AI 攻略速览（总结 + 亮点 + 避坑 + 最佳时间），一键复制平台搜索链接 |
| 规划 | `pages/index/index` | 目的地 / 地图选点、出发地定位、日期、兴趣偏好、节奏、预算、住宿、交通、人数；按偏好筛选热门景点，也可输入名称 + 地图选点添加自定义景点 |
| 方案 | `pages/plan/plan` | 生成三套方案并对比总花费、赶路时间、每日安排；可增删景点后重新规划 |
| 路线 | `pages/map/map` | 每日动线、分段耗时、路径展示 |
| 天气 | `pages/weather/weather` | 逐日预报、穿衣与行程调整建议 |
| 点位 | `pages/poi/poi` | 景点详情、评分、票价提示、调起微信地图导航 |
| 我的 | `pages/mine/mine` | 绑定自己的大模型 / 导航 / 天气 Key，历史行程、本地缓存管理、服务状态检查 |

### 攻略平台

预置：小红书、抖音、知乎、马蜂窝、B站；另有「其他」，可输入携程、去哪儿等平台名。

- 大模型按所选平台的内容口径提炼要点，但内容来自通用旅行知识，**不是平台原文**；
- 每个条目附带该平台的搜索深链，复制后到浏览器或对应 App 查看真实笔记 / 视频；
- 同一目的地 + 平台 + 模型的结果在云端缓存 24 小时，可手动「重新生成」；
- 平台选择只影响生成口径与搜索入口，不改变数据来源的合规边界。

### 自定义景点

规划页支持在热门景点之外补充自己的点位：输入名称后点「地图选点」，选点坐标会与名称一起进入本次规划的候选池。

- 坐标必须是合法经纬度：空值、超出范围以及 `(0,0)` 都会被拒绝并提示「选点坐标无效」；
- 最多添加 8 个自定义景点，超出会提示上限；
- 距目的地超过 50 km 时弹窗提示一次，确认后仍可添加；
- 去重按「名称 + 坐标（保留 5 位小数）」：同名不同位置可以共存，自定义点不会顶掉地图检索到的真实 POI；
- 勾选状态通过 `preferredKeys` / `excludedKeys` 传入规划，同名不同位置的点位可以独立勾选或排除；
- 自定义景点会置顶显示，切换目的地后自动清空。

---

## 目录结构

```
Travel assistant/
├─ miniprogram/                 # 小程序前端（打包范围）
│  ├─ app.js / app.json / app.wxss
│  ├─ config/index.js           # 云环境、平台列表、缓存 TTL、预算范围等全局配置
│  ├─ pages/
│  │  ├─ guideHelp/             # 介绍（tab）
│  │  ├─ guide/                 # 攻略（tab）
│  │  ├─ index/                 # 规划（tab）
│  │  ├─ plan/                  # 方案结果
│  │  ├─ map/                   # 路线
│  │  ├─ weather/               # 天气
│  │  ├─ poi/                   # 点位详情
│  │  └─ mine/                  # 我的（tab）
│  ├─ services/
│  │  ├─ api.js                 # 统一上游网关（云函数调用 + 本地缓存）
│  │  ├─ map.js / weather.js    # 地图 POI、地理编码、路线、天气
│  │  ├─ plan.js                # 行程编排、打分、住宿与风险说明
│  │  ├─ guide.js               # 攻略速览调用与平台校验
│  │  ├─ storage.js             # 本地存储、历史行程、缓存 TTL、Key 加密读写
│  │  └─ hotel.js
│  ├─ utils/                    # date / geo / format / decision / cipher
│  └─ data/cities.js
├─ cloudfunctions/
│  ├─ travelApi/                # 高德 / 百度 / 和风代理，含 upstream.js
│  ├─ guideProxy/               # DeepSeek 攻略速览 + 平台搜索入口
│  └─ scheduledRefresh/         # 定时清理缓存 + 可选城市预热
├─ tests/                       # 本地单元测试（不参与小程序打包）
├─ project.config.json
└─ README.md
```

---

## 快速开始

### 1. 导入项目

用微信开发者工具导入本目录，`miniprogramRoot` 为 `miniprogram/`，`cloudfunctionRoot` 为 `cloudfunctions/`。AppID 已在 `project.config.json` 中配置。

### 2. 开通云开发

开通云开发并创建环境，记下环境 ID。当前内置环境写在 [config/index.js](miniprogram/config/index.js) 的 `cloudEnv` 中，换环境时改这里即可（前端不暴露、也不允许本地覆盖）。

### 3. 部署云函数

在开发者工具的资源管理器里，分别右键以下目录 → **「创建并部署：云端安装依赖（不上传 node_modules）」**：

| 云函数 | 作用 | 建议配置 |
|---|---|---|
| `travelApi` | 地图 / 天气 / 路线代理，带缓存与限流 | 超时 20–60 秒，内存 256MB |
| `guideProxy` | DeepSeek 攻略速览 + 平台搜索链接 | **超时 60 秒**（生成通常 10–20 秒） |
| `scheduledRefresh` | 每天 02:00 清理过期缓存，可选预热城市 | 与 `travelApi` 一致的 `INTERNAL_TOKEN` |

> 不要选「所有文件」上传：本地没有 `node_modules`，必须让云端安装依赖。

### 4. 环境变量（仅内部调用使用，可选）

所有用户请求的 Key 都来自小程序「我的」页，云函数**不会**回落到运营者的环境变量。下面的变量只对携带 `INTERNAL_TOKEN` 的云函数间调用（如 `scheduledRefresh`）生效。

**travelApi**

| 变量 | 说明 |
|---|---|
| `INTERNAL_TOKEN` | 云函数间调用令牌，定时任务鉴权用 |
| `AMAP_KEY` / `BAIDU_AK` / `BAIDU_SK` | 仅内部调用时使用的高德 / 百度 Key（可选） |
| `QWEATHER_KEY` / `QWEATHER_HOST` | 仅内部调用时的和风天气 Key 与 API Host（可选） |
| `MAP_PROVIDER` | 请求未指定 provider 时的默认地图商：`amap` 或 `baidu` |

**guideProxy**

| 变量 | 说明 |
|---|---|
| `INTERNAL_TOKEN` | 必须与 `travelApi` 一致 |
| `DEEPSEEK_API_KEY` | 仅内部调用时使用；用户请求必须携带自己的 Key |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 用户未填模型名时的默认值 `deepseek-chat` |

**scheduledRefresh**

| 变量 | 说明 |
|---|---|
| `INTERNAL_TOKEN` | 必须与 `travelApi` 一致 |
| `REFRESH_CITIES` | 需预热的城市，逗号分隔，如 `北京,上海,成都`；留空只清理缓存 |

### 5. 创建数据库集合

云开发数据库创建集合 `travel_cache`（云函数缓存、限流计数、定时清理都用它）。集合为空时首次调用会自动写入。

### 6. 在「我的」绑定自己的 Key

服务 Key 全部由终端用户在小程序「我的」页自行填写，小程序不预置、也不使用运营者的 Key：

- **大模型**：填写 API Key 与模型名称（默认 `deepseek-chat`），攻略速览必填；
- **导航**：选择高德或百度，填写对应的 Key；百度开启 SN 校验时再填 SK；
- **天气**：填写和风天气 Key（可选，用于 7 天预报）。

Key 在本机用 AES-128-CTR 加密后保存，每次请求随 `keys` / `llm` 传给云函数，云函数只在本次上游调用中使用，不落库、不写日志；请求结束后不留存。

填完后可在「我的 - 检查服务状态」确认地图与天气可用；到攻略页输入城市 →「生成速览」，看到「AI 参考总结」卡片即正常。

---

## 工作方式

```
页面
  └─ services/*
       ├─ api.call() ── wx.cloud.callFunction ──> travelApi ──> 高德 / 百度 / 和风
       │                 └ 本地缓存 TA_CACHE_V1_*（TTL 按类型）
       └─ guide.load() ─ wx.cloud.callFunction ──> guideProxy ──> DeepSeek API
                          └ 云端缓存 travel_cache（24 小时）
```

用户自己的 Key 由「我的」页加密保存在本机，调用时以 `keys` / `llm` 附带在请求中，云函数只用于当次上游请求。

- **规划**：先地理编码目的地和出发地，按兴趣偏好检索热门 POI，结合天气、评分、距离、预算、节奏做多因子打分与分组，再优化每日动线；自定义景点会校验坐标后并入候选池，景点可增删后重新规划。
- **缓存**：地图 / POI / 天气 / 路线在本地按 TTL 缓存；攻略在云端按 `城市|平台|自定义平台|模型` 缓存 24 小时。
- **限流**：`travelApi` 按 OPENID + action 做 60 秒滑动窗口限流（默认 20 次/分钟）；`guideProxy` 每 OPENID 每分钟最多 6 次。
- **错误处理**：云函数对外只返回脱敏错误码（如 `NO_KEY`、`RATE_LIMITED`、`UPSTREAM_FAIL`），页面按错误码给出可执行提示。

---

## 本地测试

测试脚本位于 `tests/`，不参与小程序打包，直接用 Node 运行：

```powershell
node tests/format.test.js
node tests/decision.test.js
node tests/geo.test.js
node tests/guide-platform.test.js
```

- `format.test.js`：攻略文本清洗、URL 白名单、平台检索词与提示词约束（12 项）
- `decision.test.js`：方案打分、预算与强度决策（12 项）
- `geo.test.js`：坐标校验、距离与坐标系转换（17 项）
- `guide-platform.test.js`：平台识别、自定义平台容错、前端平台归一化（18 项）

合计 59 项，全部应通过。

语法自检：

```powershell
node --check miniprogram/pages/index/index.js
node --check miniprogram/pages/plan/plan.js
node --check miniprogram/services/plan.js
node --check cloudfunctions/travelApi/index.js
node --check cloudfunctions/guideProxy/index.js
```

---

## 上线检查清单

- [ ] `travelApi`、`guideProxy`、`scheduledRefresh` 均已用「云端安装依赖」部署
- [ ] `guideProxy` 超时已改为 60 秒
- [ ] `INTERNAL_TOKEN` 在 `travelApi`、`guideProxy` 与 `scheduledRefresh` 中一致
- [ ] 数据库集合 `travel_cache` 已创建
- [ ] 「我的」页可填写并加密保存大模型 / 导航 / 天气 Key；「检查服务状态」正常
- [ ] 确认运营者 Key 仅用于内部调用，用户请求不会回落到环境变量
- [ ] 小程序后台已配置隐私协议与定位权限说明（`getLocation` / `chooseLocation`）
- [ ] 攻略页、规划页、方案页各走通一次；自定义景点添加、同名点位勾选与排除正常
- [ ] 清理开发期本地缓存与历史行程
- [ ] 云开发控制台开启调用日志与用量配额告警

---

## 合规与边界

1. 小红书 / 抖音 / 知乎等平台没有面向小程序的内容接口，小程序**不抓取站内内容**；攻略模块只输出 AI 通用参考速览，并提供平台搜索深链，实际内容请到对应平台查看。
2. AI 速览不是平台原文，不编造帖子、作者、点赞数或原帖链接；价格、营业时间、预约规则以景区官方公告为准。
3. 地图与天气数据来自高德 / 百度 / 和风天气，使用时需遵守对应开放平台的服务条款与配额限制。
4. 行程结果为决策参考，不替代官方售票、预约与安全提示。
