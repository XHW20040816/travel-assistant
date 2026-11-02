/**
 * 全局配置
 * ------------------------------------------------------------------
 * 小程序固定使用云开发：所有上游请求由云函数 travelApi / guideProxy 代理。
 * 导航、天气、大模型 Key 由用户在小程序「我的」页自行绑定，
 * 本机加密保存，并在每次请求时随调用传给云函数，不写入云函数环境变量。
 *
 * cloudEnv / cloudFn 为内置配置，不在前端暴露，也不允许本地覆盖。
 *
 * 高德开放平台：https://console.amap.com/dev/key/app  （Web服务 Key）
 * 百度地图开放平台：https://lbsyun.baidu.com/apiconsole/key （服务端 AK）
 * 和风天气（可选，用于 7 天预报）：https://dev.qweather.com/
 */
const APP_CONFIG = {
  version: '1.0.0',
  cloudEnv: 'cloud1-d0ghx8o605fb9fef7',
  cloudFn: 'travelApi',
  guideFn: 'guideProxy',
  // 攻略平台：只检索所选平台的公开网页，由云函数按域名过滤；「其他」允许用户输入自定义平台名
  defaultGuidePlatform: 'xiaohongshu',
  guidePlatforms: [
    { key: 'xiaohongshu', label: '小红书' },
    { key: 'douyin', label: '抖音' },
    { key: 'zhihu', label: '知乎' },
    { key: 'mafengwo', label: '马蜂窝' },
    { key: 'bilibili', label: 'B站' },
    { key: 'other', label: '其他' }
  ],
  // 自定义平台名长度上限（字符）
  guidePlatformCustomMaxLen: 12,
  // 和风天气新版专属 API Host（控制台 - 设置中查看，形如 https://xxx.qweatherapi.com）
  qweatherHost: 'https://devapi.qweather.com',
  // 导航服务默认地图商；用户可在「我的」切换
  mapProvider: 'amap', // amap | baidu
  // 用户自己的 Key 默认留空，全部在「我的」页绑定
  keys: {
    amap: '',
    baidu: '',
    baiduSk: '',
    qweather: ''
  },
  // 缓存有效期（毫秒），越实时越短
  cacheTTL: {
    geocode: 30 * 24 * 3600 * 1000,
    poi: 7 * 24 * 3600 * 1000,
    weather: 30 * 60 * 1000,
    route: 10 * 60 * 1000,
    guide: 7 * 24 * 3600 * 1000
  },
  // 超过该时长视为“需要复核”的时效阈值（毫秒）
  freshnessWarn: {
    poi: 14 * 24 * 3600 * 1000,
    weather: 6 * 3600 * 1000,
    route: 60 * 60 * 1000,
    guide: 90 * 24 * 3600 * 1000
  },
  limits: {
    maxDays: 7,
    maxPoiPerDay: 5,
    maxPoiCandidates: 36,
    maxRefineLegs: 40
  },
  // 人均每日预算范围（用户自行设置，单位：元）
  budgetRange: { min: 100, max: 1000, step: 50, defaultMin: 300, defaultMax: 700 },
  // 住宿预算范围：每晚每间，独立于人均日预算
  stayBudgetRange: { min: 100, max: 1500, step: 50, defaultMin: 200, defaultMax: 600 },
  // 默认出发城市（未授权定位时使用）
  defaultCity: { name: '北京', lng: 116.4074, lat: 39.9042, adcode: '110000' }
}

module.exports = APP_CONFIG
