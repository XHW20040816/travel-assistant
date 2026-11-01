const storage = require('../../services/storage')
const mapService = require('../../services/map')
const api = require('../../services/api')
const dateUtil = require('../../utils/date')
const config = require('../../config/index')

// 正式版不展示直连调试入口，避免 Key 进入客户端
const ALLOW_DIRECT = storage.isDirectAllowed()

const SOURCE_OPTIONS = [
  {
    key: 'cloud',
    label: '云开发',
    desc: '通过云函数 travelApi 代理高德/百度/和风，Key 在本机加密保存并随调用校验（推荐上线）'
  },
  {
    key: 'direct',
    label: '直连调试',
    desc: '小程序直接请求开放平台，仅用于本地调试，需在开发者工具关闭域名校验'
  }
]

const PROVIDER_OPTIONS = [
  { key: 'amap', label: '高德地图', desc: 'POI / 路径 / 天气 / 公交，能力最全' },
  { key: 'baidu', label: '百度地图', desc: 'POI / 驾车步行 / 天气，坐标自动转换为 GCJ02' }
]

const DEPLOY_STEPS = [
  '开发者工具中开通云开发，创建环境并记录环境 ID',
  '右键 cloudfunctions/travelApi 与 scheduledRefresh，选择「上传并部署」',
  '在「我的」页填写高德、百度、和风 Key（AES 加密存储在本机）；也可用云函数环境变量作为兜底，建议超时 20 秒、内存 256MB',
  '在 travelApi 与 scheduledRefresh 同时配置 INTERNAL_TOKEN，供定时任务鉴权调用',
  '百度控制台开启 SN 校验时，在 travelApi 环境变量配置 BAIDU_SK（SK 只存云端，前端不填）；百度一律由云函数签名调用',
  '攻略大模型：在「我的」页填写 DeepSeek Key（AES 加密存储在本机），无需云函数环境变量',
  '将 guideProxy 云函数超时时间调整为 60 秒，否则攻略速览生成会超时',
  '云开发控制台开启云函数调用日志与用量配额告警，便于排查异常调用',
  '云开发数据库创建集合 travel_cache（用于云端缓存，可留空自动创建）',
  'scheduledRefresh 自带 config.json 定时触发器，可按需在控制台调整',
  '将上方数据源切到「云开发」（云环境 ID 已内置，无需填写）'
]

const CONSOLE_LINKS = [
  { label: '高德开放平台', url: 'https://console.amap.com/dev/key/app' },
  { label: '百度地图开放平台', url: 'https://lbsyun.baidu.com/apiconsole/key' },
  { label: '和风天气控制台', url: 'https://dev.qweather.com/' }
]

Page({
  data: {
    source: 'cloud',
    sourceOptions: ALLOW_DIRECT ? SOURCE_OPTIONS : SOURCE_OPTIONS.filter((item) => item.key !== 'direct'),
    allowDirect: ALLOW_DIRECT,
    sourceLabel: '云开发',
    provider: 'amap',
    providerOptions: PROVIDER_OPTIONS,
    providerDesc: PROVIDER_OPTIONS[0].desc,
    keys: { amap: '', baidu: '', qweather: '' },
    llm: { deepseek: '', model: 'deepseek-chat' },
    llmReady: false,
    showKey: false,
    testing: false,
    cacheCount: 0,
    cacheSizeText: '—',
    storageLimitText: '—',
    history: [],
    deploySteps: DEPLOY_STEPS,
    consoleLinks: CONSOLE_LINKS,
    domains: [
      'https://restapi.amap.com',
      'https://api.map.baidu.com',
      'https://devapi.qweather.com'
    ],
    version: config.version
  },

  onLoad() {
    this.syncSettings()
    this.syncLlm()
    this.refreshCache()
    this.refreshHistory()
  },

  onShow() {
    this.syncSettings()
    this.syncLlm()
    this.refreshCache()
    this.refreshHistory()
  },

  syncLlm() {
    const saved = storage.getLlmConfig()
    const llm = saved || { ...storage.DEFAULT_LLM }
    this.setData({ llm, llmReady: !!llm.deepseek })
  },

  onLlmInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`llm.${field}`]: e.detail.value })
  },

  saveLlm() {
    const deepseek = String(this.data.llm.deepseek || '').trim()
    const model = String(this.data.llm.model || '').trim() || 'deepseek-chat'
    if (deepseek.length > 200) {
      wx.showToast({ title: 'Key 长度异常，请检查是否粘贴完整', icon: 'none' })
      return
    }
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(model)) {
      wx.showToast({ title: '模型名只能包含字母、数字、点、下划线和短横线', icon: 'none' })
      return
    }
    if (!deepseek) {
      wx.showToast({ title: '请填写 DeepSeek Key', icon: 'none' })
      return
    }
    const saved = storage.saveLlmConfig({ deepseek, model })
    if (!saved) {
      wx.showToast({ title: '加密保存失败，请重试', icon: 'none' })
      return
    }
    this.setData({ llm: saved, llmReady: true })
    wx.showToast({ title: '攻略配置已加密保存', icon: 'success' })
  },

  clearLlm() {
    if (!this.data.llmReady && !this.data.llm.deepseek) return
    wx.showModal({
      title: '清除攻略配置',
      content: '将删除本机保存的 DeepSeek Key，攻略页将无法生成速览，需要重新配置。',
      confirmText: '清除',
      success: (res) => {
        if (!res.confirm) return
        storage.clearLlmConfig()
        this.setData({ llm: { ...storage.DEFAULT_LLM }, llmReady: false })
        wx.showToast({ title: '已清除', icon: 'none' })
      }
    })
  },

  goGuideHelp() {
    wx.switchTab({ url: '/pages/guideHelp/guideHelp' })
  },

  syncSettings() {
    const settings = storage.getSettings()
    const matched = SOURCE_OPTIONS.find((item) => item.key === settings.dataSource)
    const provider = settings.mapProvider || 'amap'
    const providerOption = PROVIDER_OPTIONS.find((item) => item.key === provider) || PROVIDER_OPTIONS[0]
    this.setData({
      source: settings.dataSource || 'cloud',
      sourceLabel: matched ? matched.label : '云开发',
      provider,
      providerDesc: providerOption.desc,
      keys: { ...config.keys, ...(settings.keys || {}) }
    })
  },

  pickSource(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'direct' && !ALLOW_DIRECT) {
      wx.showToast({ title: '正式版不支持直连调试', icon: 'none' })
      return
    }
    if (key === this.data.source) return
    storage.saveSettings({ dataSource: key })
    const matched = SOURCE_OPTIONS.find((item) => item.key === key)
    this.setData({ source: key, sourceLabel: matched ? matched.label : key })

    const app = getApp()
    if (app) {
      app.globalData.settings = storage.getSettings()
      if (typeof app.initCloud === 'function') app.initCloud()
    }

    if (key === 'cloud') {
      wx.showToast({ title: '已切换云开发，请确认环境与云函数', icon: 'none' })
    } else if (key === 'direct') {
      wx.showToast({ title: '直连模式仅用于调试', icon: 'none' })
    }
  },

  pickProvider(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.provider) return
    storage.saveSettings({ mapProvider: key })
    const matched = PROVIDER_OPTIONS.find((item) => item.key === key) || PROVIDER_OPTIONS[0]
    this.setData({ provider: key, providerDesc: matched.desc })
    wx.showToast({ title: '地图服务已切换', icon: 'none' })
  },

  toggleShowKey() {
    this.setData({ showKey: !this.data.showKey })
  },

  onKeyInput(e) {
    const key = e.currentTarget.dataset.key
    const keys = { ...this.data.keys, [key]: e.detail.value }
    this.setData({ keys })
  },

  onKeyBlur(e) {
    const key = e.currentTarget.dataset.key
    const keys = { ...this.data.keys, [key]: (e.detail.value || '').trim() }
    this.setData({ keys })
    storage.saveSettings({ keys })
  },

  saveAll() {
    storage.saveSettings({ keys: this.data.keys })
    const app = getApp()
    if (app && this.data.source === 'cloud') {
      app.globalData.settings = storage.getSettings()
      if (typeof app.initCloud === 'function') app.initCloud()
    }
    wx.showToast({ title: '配置已保存', icon: 'success' })
  },

  async testConfig() {
    const settings = storage.getSettings()
    if (!this.data.testing) {
      this.setData({ testing: true })
    }
    wx.showLoading({ title: '正在校验配置', mask: true })

    let capsText = ''
    try {
      const caps = await api.getCapabilities({ force: true })
      const names = []
      if (caps.amap) names.push('高德')
      if (caps.baidu) names.push(caps.baiduSn ? '百度（SN 已启用）' : '百度')
      if (caps.qweather) names.push('和风 7 天')
      capsText = names.length ? `\n已配置：${names.join('、')}` : '\n未检测到可用 Key'
      if (caps.missing && caps.missing.length) {
        capsText += `\n缺少 Key：${caps.missing.join('、')}`
      }
    } catch (err) {
      capsText = ''
    }

    try {
      const cityName = (settings.defaultCity && settings.defaultCity.name) || '北京'
      const result = await mapService.geocode(cityName, cityName)
      wx.hideLoading()
      wx.showModal({
        title: '连接正常',
        content: `已解析 ${result.name}\n坐标 ${Number(result.lng).toFixed(4)}, ${Number(result.lat).toFixed(4)}\n数据源 ${settings.dataSource === 'cloud' ? '云函数' : '直连'} · ${result.source || settings.mapProvider}${capsText}`,
        showCancel: false
      })
    } catch (err) {
      wx.hideLoading()
      const raw = (err && err.message) || '未知错误'
      const cloudIssue = !!(err && err.code && String(err.code).indexOf('CLOUD_') === 0)
      wx.showModal({
        title: '连接失败',
        content: `${raw}${cloudIssue ? '' : capsText}`,
        showCancel: false
      })
    }
    this.setData({ testing: false })
  },

  refreshCache() {
    const info = storage.cacheSize()
    const toMb = (kb) => `${((Number(kb) || 0) / 1024).toFixed(1)} MB`
    this.setData({
      cacheCount: info.count || 0,
      cacheSizeText: toMb(info.currentSize),
      storageLimitText: toMb(info.limitSize)
    })
  },

  clearCache() {
    wx.showModal({
      title: '清理本地缓存',
      content: '将删除 POI、天气与路线的本地缓存，下次规划会重新请求上游接口。',
      confirmText: '清理',
      success: (res) => {
        if (!res.confirm) return
        storage.cacheClear()
        this.refreshCache()
        wx.showToast({ title: '缓存已清理', icon: 'success' })
      }
    })
  },

  refreshHistory() {
    const history = storage.listHistory().map((entry) => ({
      id: entry.id,
      destName: entry.destName || '未命名行程',
      dateText: `${entry.startDate || ''} · ${entry.days || 0} 天 · ${entry.party || 1} 人`,
      scoreText: entry.scoreText || '',
      costText: entry.totalCostText || '',
      timeText: dateUtil.relativeTime(entry.createdAt)
    }))
    this.setData({ history })
  },

  openHistory(e) {
    const id = e.currentTarget.dataset.id
    const entry = storage.listHistory().find((item) => item.id === id)
    if (!entry || !entry.plan) {
      wx.showToast({ title: '该记录缺少可展示的方案', icon: 'none' })
      return
    }
    const plan = entry.plan
    const bundle = {
      groupId: entry.id,
      createdAt: entry.createdAt,
      request: {
        ...(plan.request || {}),
        destName: entry.destName,
        startDate: entry.startDate,
        days: entry.days,
        party: entry.party
      },
      dest: plan.dest || null,
      plans: [plan],
      activeIndex: 0
    }
    storage.saveBundle(bundle)
    wx.navigateTo({ url: '/pages/plan/plan?id=history' })
  },

  removeHistory(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除记录',
      content: '删除后不可恢复，确定删除这条历史行程吗？',
      success: (res) => {
        if (!res.confirm) return
        storage.removeHistory(id)
        this.refreshHistory()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  clearHistory() {
    if (!this.data.history.length) return
    wx.showModal({
      title: '清空历史',
      content: '将删除全部历史行程记录，确定继续吗？',
      success: (res) => {
        if (!res.confirm) return
        storage.clearHistory()
        this.refreshHistory()
        wx.showToast({ title: '历史已清空', icon: 'none' })
      }
    })
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  goPlan() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
