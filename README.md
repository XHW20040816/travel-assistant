# 行程规划师（Travel Assistant）

微信小程序 + 微信云开发的旅行规划工具。按「**介绍 → 攻略 → 规划 → 我的**」的路径使用：先在攻略页定目的地、看 AI 攻略速览，再带着目的地到规划页按兴趣偏好挑景点，最后生成三套可对比的行程，并查看路线、天气与点位导航。

地图、天气、POI 数据由云函数 `travelApi` 代理高德 / 百度 / 和风天气；攻略速览由云函数 `guideProxy` 调用 DeepSeek 生成，**不抓取小红书、抖音等平台的站内内容**，只提供对应平台的真实搜索链接。

---

## 功能概览

| 模块 | 页面 | 主要能力 |
|---|---|---|
| 介绍 | `pages/guideHelp/guideHelp` | 三步使用说明、模块介绍、常见问题、配置状态 |
| 攻略 | `pages/guide/guide` | 按平台生成 AI 攻略速览（总结 + 亮点 + 避坑 + 最佳时间），一键复制平台搜索链接 |
| 规划 | `pages/index/index` | 目的地 / 地图选点、出发地定位、日期、兴趣偏好、节奏、预算、住宿、交通、人数；按偏好筛选热门景点 |
| 方案 | `pages/plan/plan` | 生成三套方案并对比总花费、赶路时间、每日安排；可增删景点后重新规划 |
| 路线 | `pages/map/map` | 每日动线、分段耗时、路径展示 |
| 天气 | `pages/weather/weather` | 逐日预报、穿衣与行程调整建议 |
| 点位 | `pages/poi/poi` | 景点详情、评分、票价提示、调起微信地图导航 |
| 我的 | `pages/mine/mine` | Key 配置（本机加密）、连接测试、缓存与历史行程管理、合规说明 |

### 攻略平台

预置：小红书、抖音、知乎、马蜂窝、B站；另有「其他」，可输入携程、去哪儿等平台名。

- 大模型按所选平台的内容口径提炼要点，但内容来自通用旅行知识，**不是平台原文**；
- 每个条目附带该平台的搜索深链，复制后到浏览器或对应 App 查看真实笔记 / 视频；
- 同一目的地 + 平台 + 模型的结果在云端缓存 24 小时，可手动「重新生成」；
- 平台选择只影响生成口径与搜索入口，不改变数据来源的合规边界。

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
│  │  ├─ storage.js             # 本地存储、加密 Key、缓存 TTL
│  │  └─ hotel.js
│  ├─ utils/                    # cipher / date / geo / format / decision
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

### 4. 环境变量（可选，但上线建议配置）

**travelApi**

| 变量 | 说明 |
|---|---|
| `AMAP_KEY` | 高德 Web 服务 Key |
| `BAIDU_AK` / `BAIDU_SK` | 百度服务端 AK / SK（开启 SN 校验时必填，SK 只存云端） |
| `QWEATHER_KEY` / `QWEATHER_HOST` | 和风天气 Key 与 API Host（可选，用于 7 天预报） |
| `MAP_PROVIDER` | 默认地图商：`amap` 或 `baidu` |
| `INTERNAL_TOKEN` | 云函数间调用令牌，定时任务鉴权用 |

**guideProxy**

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek Key（可选；不配则由用户在「我的」页填写） |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-chat` |
| `ALLOW_CLIENT_LLM_KEYS` | 设为 `0` 时只允许云端环境变量 Key，不接受前端传入 |

**scheduledRefresh**

| 变量 | 说明 |
|---|---|
| `INTERNAL_TOKEN` | 必须与 `travelApi` 一致 |
| `REFRESH_CITIES` | 需预热的城市，逗号分隔，如 `北京,上海,成都`；留空只清理缓存 |

### 5. 创建数据库集合

云开发数据库创建集合 `travel_cache`（云函数缓存、限流计数、定时清理都用它）。集合为空时首次调用会自动写入。

### 6. 配置 Key 并验证

- 地图 / 天气 Key：在「我的」页填写并保存，或使用上面的云函数环境变量兜底；
- 攻略 Key：在「我的 - 攻略大模型」填写 DeepSeek Key；
- 点「测试连接」确认地图服务可用；
- 到攻略页输入城市 →「生成速览」，看到「AI 参考总结」卡片即正常。

Key 以 AES-128-CTR 加密保存在本机，不会明文落盘；云开发模式下经 HTTPS 传给云函数，日志不记录 Key。

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

- **规划**：先地理编码目的地和出发地，按兴趣偏好检索热门 POI，结合天气、评分、距离、预算、节奏做多因子打分与分组，再优化每日动线；景点可增删后重新规划。
- **缓存**：地图 / POI / 天气 / 路线在本地按 TTL 缓存；攻略在云端按 `城市|平台|自定义平台|模型` 缓存 24 小时。
- **限流**：`travelApi` 按 OPENID + action 做 60 秒滑动窗口限流（默认 20 次/分钟）；`guideProxy` 每 OPENID 每分钟最多 6 次。
- **错误处理**：云函数对外只返回脱敏错误码（如 `NO_KEY`、`RATE_LIMITED`、`UPSTREAM_FAIL`），页面按错误码给出可执行提示。

---

## 本地测试

测试脚本位于 `tests/`，不参与小程序打包，直接用 Node 运行：

```powershell
node tests/format.test.js
node tests/guide-platform.test.js
```

- `format.test.js`：攻略文本清洗、URL 白名单、平台检索词与提示词约束（12 项）
- `guide-platform.test.js`：平台识别、自定义平台容错、前端平台归一化（18 项）

语法自检：

```powershell
node --check cloudfunctions/guideProxy/index.js
node --check cloudfunctions/guideProxy/format.js
node --check miniprogram/services/guide.js
```

---

## 上线检查清单

- [ ] `travelApi`、`guideProxy`、`scheduledRefresh` 均已用「云端安装依赖」部署
- [ ] `guideProxy` 超时已改为 60 秒
- [ ] 云函数环境变量已配置，且 `INTERNAL_TOKEN` 在 `travelApi` 与 `scheduledRefresh` 中一致
- [ ] 数据库集合 `travel_cache` 已创建
- [ ] 「我的」页地图 / 天气 / DeepSeek Key 已配置并通过「测试连接」
- [ ] 小程序后台已配置隐私协议与定位权限说明（`getLocation` / `chooseLocation`）
- [ ] 攻略页、规划页、方案页各走通一次；清理开发期本地缓存与历史行程
- [ ] 云开发控制台开启调用日志与用量配额告警

---

## 合规与边界

1. 小红书 / 抖音 / 知乎等平台没有面向小程序的内容接口，小程序**不抓取站内内容**；攻略模块只输出 AI 通用参考速览，并提供平台搜索深链，实际内容请到对应平台查看。
2. AI 速览不是平台原文，不编造帖子、作者、点赞数或原帖链接；价格、营业时间、预约规则以景区官方公告为准。
3. 地图与天气数据来自高德 / 百度 / 和风天气，使用时需遵守对应开放平台的服务条款与配额限制。
4. 行程结果为决策参考，不替代官方售票、预约与安全提示。

---

## 开发调试（可选）

`config/index.js` 的 `dataSource` 支持 `cloud`（默认）与 `direct`。`direct` 仅用于开发版 / 体验版本地调试，正式版会自动回落到 `cloud`；百度地图因 SN 签名依赖服务端 SK，始终走云函数。上线版本建议只使用云开发模式。
