/**
 * 我的：绑定自己的服务 Key、历史行程、本地缓存与使用帮助
 */
const storage = require('../../services/storage')
const api = require('../../services/api')
const dateUtil = require('../../utils/date')
const config = require('../../config/index')

const PROVIDER_OPTIONS = [
  { key: 'amap', label: '高德地图', desc: 'POI / 路径 / 公交 / 天气，能力最全' },
  { key: 'baidu', label: '百度地图', desc: 'POI / 驾车步行 / 天气，坐标自动转换为 GCJ02' }
]

/** Key 只允许字母、数字、点、下划线和短横线，长度不超过 200 */
function isValidKey(text) {
  return /^[A-Za-z0-9._-]{1,200}$/.test(text)
}

Page({
  data: {
    history: [],
    cacheCount: 0,
    cacheSizeText: '—',
    storageLimitText: '—',
    checking: false,
    version: config.version,
    provider: 'amap',
    providerOptions: PROVIDER_OPTIONS,
    keys: { amap: '', baidu: '', baiduSk: '', qweather: '' },
    llm: { deepseek: '', model: 'deepseek-chat' },
    showKey: false,
    llmReady: false,
    navReady: false,
    weatherReady: false
  },

  onShow() {
    this.syncConfig()
    this.refreshCache()
    this.refreshHistory()
  },

  /** 从本机读取已绑定的 Key 与偏好 */
  syncConfig() {
    const settings = storage.getSettings()
    const keys = { amap: '', baidu: '', baiduSk: '', qweather: '', ...(settings.keys || {}) }
    const provider = settings.mapProvider === 'baidu' ? 'baidu' : 'amap'
    const llm = storage.getLlmConfig() || { ...storage.DEFAULT_LLM }
    this.setData({
      provider,
      keys,
      llm,
      llmReady: !!llm.deepseek,
      navReady: provider === 'baidu' ? !!keys.baidu : !!keys.amap,
      weatherReady: !!keys.qweather
    })
  },

  toggleShowKey() {
    this.setData({ showKey: !this.data.showKey })
  },

  pickProvider(e) {
    const provider = e.currentTarget.dataset.key
    if (provider === this.data.provider) return
    storage.saveSettings({ mapProvider: provider })
    const keys = this.data.keys
    this.setData({
      provider,
      navReady: provider === 'baidu' ? !!keys.baidu : !!keys.amap
    })
  },

  onKeyInput(e) {
    const field = e.currentTarget.dataset.key
    this.setData({ [`keys.${field}`]: e.detail.value })
  },

  onLlmInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`llm.${field}`]: e.detail.value })
  },

  saveNav() {
    const provider = this.data.provider
    const keys = this.data.keys
    const picked = { ...keys }
    if (provider === 'amap' && !keys.amap.trim()) {
      wx.showToast({ title: '请填写高德 Web 服务 Key', icon: 'none' })
      return
    }
    if (provider === 'baidu' && !keys.baidu.trim()) {
      wx.showToast({ title: '请填写百度地图 AK', icon: 'none' })
      return
    }
    if (provider === 'amap' && !isValidKey(keys.amap.trim())) {
      wx.showToast({ title: '高德 Key 格式不正确，请检查是否粘贴完整', icon: 'none' })
      return
    }
    if (provider === 'baidu') {
      if (!isValidKey(keys.baidu.trim())) {
        wx.showToast({ title: '百度 AK 格式不正确，请检查是否粘贴完整', icon: 'none' })
        return
      }
      if (keys.baiduSk.trim() && !isValidKey(keys.baiduSk.trim())) {
        wx.showToast({ title: '百度 SK 格式不正确，请检查是否粘贴完整', icon: 'none' })
        return
      }
    }
    storage.saveSettings({ mapProvider: provider, keys: picked })
    this.setData({
      keys: picked,
      navReady: provider === 'baidu' ? !!keys.baidu.trim() : !!keys.amap.trim()
    })
    wx.showToast({ title: '导航配置已保存', icon: 'success' })
  },

  saveWeather() {
    const keys = this.data.keys
    const qweather = keys.qweather.trim()
    if (qweather && !isValidKey(qweather)) {
      wx.showToast({ title: '天气 Key 格式不正确，请检查是否粘贴完整', icon: 'none' })
      return
    }
    storage.saveSettings({ keys })
    this.setData({ keys, weatherReady: !!qweather })
    wx.showToast({ title: qweather ? '天气 Key 已保存' : '已清除天气 Key', icon: qweather ? 'success' : 'none' })
  },

  saveLlm() {
    const deepseek = String(this.data.llm.deepseek || '').trim()
    const model = String(this.data.llm.model || '').trim() || 'deepseek-chat'
    if (!deepseek) {
      wx.showToast({ title: '请填写大模型 API Key', icon: 'none' })
      return
    }
    if (!isValidKey(deepseek)) {
      wx.showToast({ title: 'API Key 格式不正确，请检查是否粘贴完整', icon: 'none' })
      return
    }
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(model)) {
      wx.showToast({ title: '模型名只能包含字母、数字、点、下划线和短横线', icon: 'none' })
      return
    }
    const saved = storage.saveLlmConfig({ deepseek, model })
    if (!saved) {
      wx.showToast({ title: '加密保存失败，请重试', icon: 'none' })
      return
    }
    this.setData({ llm: saved, llmReady: true })
    wx.showToast({ title: '大模型配置已保存', icon: 'success' })
  },

  clearLlm() {
    if (!this.data.llmReady && !this.data.llm.deepseek) return
    wx.showModal({
      title: '解除大模型绑定',
      content: '将删除本机保存的 API Key，攻略页将无法再生成速览。',
      confirmText: '解除',
      success: (res) => {
        if (!res.confirm) return
        storage.clearLlmConfig()
        this.setData({ llm: { ...storage.DEFAULT_LLM }, llmReady: false })
        wx.showToast({ title: '已解除绑定', icon: 'none' })
      }
    })
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
      content: '将删除景点、天气与路线的本地缓存，下次规划会重新获取最新数据。历史行程不会受影响。',
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
    const saved = entry.plan.dest
    const bundle = {
      groupId: entry.id,
      createdAt: entry.createdAt,
      request: entry.plan.request || {},
      dest: saved ? { ...saved, name: entry.destName } : { name: entry.destName },
      plans: [entry.plan],
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

  /** 用户侧的服务自检：用已绑定的 Key 探测可用能力 */
  async testService() {
    if (this.data.checking) return
    this.setData({ checking: true })
    wx.showLoading({ title: '正在检查服务', mask: true })
    try {
      const caps = await api.getCapabilities({ force: true })
      wx.hideLoading()
      const names = []
      if (caps.amap) names.push('高德地图')
      if (caps.baidu) names.push('百度地图')
      if (caps.qweather) names.push('和风天气')
      const navReady = !!(caps.amap || caps.baidu)
      wx.showModal({
        title: navReady ? '服务可用' : '导航服务未就绪',
        content: navReady
          ? `已就绪：${names.join('、') || '导航服务'}。可以正常生成行程。`
          : '请先在「我的」绑定导航 API Key，并确认 Key 类型与服务商匹配。',
        showCancel: false
      })
    } catch (err) {
      wx.hideLoading()
      wx.showModal({
        title: '服务暂时不可用',
        content: '请检查网络后稍后重试。',
        showCancel: false
      })
    }
    this.setData({ checking: false })
  },

  goGuideHelp() {
    wx.switchTab({ url: '/pages/guideHelp/guideHelp' })
  },

  goPlan() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
