/**
 * 攻略页
 * 目的地由用户手动输入；按所选平台（小红书/抖音/知乎等）生成 AI 参考速览，
 * 并提供平台真实搜索链接，复制后到浏览器或 App 查看内容（Key 在「我的」页配置）
 */
const storage = require('../../services/storage')
const config = require('../../config/index')
const guideService = require('../../services/guide')
const format = require('../../utils/format')

const ERROR_HINTS = {
  NO_KEY: '在「我的」页填写 DeepSeek Key 后即可生成攻略速览',
  NOT_CLOUD: '把「数据源」切换为云开发模式，才能调用大模型速览',
  RATE_LIMITED: '生成过于频繁，请 1 分钟后重试',
  GUIDE_EMPTY: '该平台暂未生成速览，可切换平台或换个目的地',
  PLATFORM_MISMATCH: '云端返回的攻略与所选平台不一致，请重新部署 guideProxy 后重新生成',
  UPSTREAM_FAIL: '大模型服务暂时不可用，可稍后重试',
  CLOUD_FN_MISSING: '云函数 guideProxy 未部署，请右键上传并部署',
  CLOUD_TIMEOUT: '云函数调用超时，请把 guideProxy 超时时间调到 60 秒',
  CLOUD_FAIL: '云函数调用失败，请检查云开发环境与部署状态'
}

const NEED_SETUP = [
  'NO_KEY',
  'NOT_CLOUD',
  'CLOUD_FN_MISSING',
  'CLOUD_FAIL',
  'CLOUD_NOT_OPEN',
  'CLOUD_ENV_INVALID',
  'CLOUD_NOT_INIT'
]

function relativeTime(stamp) {
  const time = Number(stamp) || 0
  if (!time) return '刚刚'
  const diff = Math.max(0, Date.now() - time)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function buildLiveMeta(live) {
  if (!live || !live.items || !live.items.length) return ''
  const parts = []
  if (live.platformLabel) parts.push(live.platformLabel)
  if (live.mode === 'llm') parts.push('AI 参考，非平台原文')
  parts.push(live.cached ? `缓存于 ${relativeTime(live.generatedAt)}` : `整理于 ${relativeTime(live.generatedAt)}`)
  return parts.join(' · ')
}

/** 首次进入时把当前行程的目的地填进输入框，仍可手动修改 */
function suggestCity() {
  const bundle = storage.getBundle()
  if (bundle && bundle.dest && bundle.dest.name) return bundle.dest.name
  if (bundle && bundle.plans && bundle.plans[0] && bundle.plans[0].dest) return bundle.plans[0].dest.name
  return ''
}

Page({
  data: {
    inputCity: '',
    city: '',
    destPoint: null,
    platforms: config.guidePlatforms,
    platform: config.defaultGuidePlatform,
    platformLabel: '小红书',
    platformHint: '按小红书口径整理攻略速览',
    customPlatform: '',
    showCustomInput: false,
    customMaxLen: config.guidePlatformCustomMaxLen || 12,
    liveItems: [],
    liveMeta: '',
    loading: false,
    error: null,
    errorHint: '',
    needSetup: false,
    llmReady: false,
    dataSource: 'cloud',
    sourceBadge: '大模型攻略速览',
    openMap: {}
  },

  onLoad() {
    this.setData({ inputCity: suggestCity() })
    const settings = storage.getSettings()
    this._customSaved = String(settings.guidePlatformCustom || '').trim()
    this.setData({ customPlatform: this._customSaved })
    this.applyPlatform(settings.guidePlatform)
    this.syncBadge()
  },

  onShow() {
    const ready = storage.hasLlmConfig()
    const justReady = ready && !this.data.llmReady
    const settings = storage.getSettings()
    const savedPlatform = guideService.normalizePlatform(settings.guidePlatform)
    const savedCustom = String(settings.guidePlatformCustom || '').trim()
    if (savedPlatform !== this.data.platform || savedCustom !== this.data.customPlatform) {
      this._customSaved = savedCustom
      this.setData({ customPlatform: savedCustom })
      this.applyPlatform(savedPlatform)
    }
    this.syncBadge()
    // 刚从「我的」页配好 Key，若已输入目的地则自动补一次生成（自定义平台需先有平台名）
    if (
      justReady &&
      this.data.city &&
      !this.data.loading &&
      (this.data.platform !== 'other' || String(this.data.customPlatform || '').trim())
    ) {
      this.load(this.data.city, false)
    }
  },

  applyPlatform(key) {
    const platform = guideService.normalizePlatform(key)
    const custom = this.data.customPlatform
    const label =
      platform === 'other'
        ? custom
          ? custom
          : '其他'
        : guideService.platformLabel(platform)
    this.setData({
      platform,
      platformLabel: label,
      showCustomInput: platform === 'other',
      platformHint:
        platform === 'other'
          ? '输入想要查看的平台名（如 携程、去哪儿、美团），生成对应搜索入口'
          : `按「${guideService.platformLabel(platform)}」口径整理攻略速览`
    })
  },

  setPlatform(e) {
    const key = guideService.normalizePlatform(e.currentTarget.dataset.key)
    if (key === this.data.platform) return
    this.applyPlatform(key)
    let hasCustom = false
    if (key === 'other') {
      const saved = String(storage.getSettings().guidePlatformCustom || '').trim()
      this.setData({ customPlatform: saved })
      this.applyPlatform(key)
      hasCustom = !!saved
    }
    storage.saveSettings({ guidePlatform: key })
    this.setData({ liveItems: [], liveMeta: '', error: null, errorHint: '', needSetup: false })
    // 切平台立即重查：load 内部用 token 作废旧请求，避免旧平台结果套在新平台标签下
    if (this.data.city && (key !== 'other' || hasCustom)) {
      this.load(this.data.city, false)
      return
    }
    // 切到自定义平台但还没填平台名：作废在途请求并停掉 loading，等待用户输入
    this._loadToken = (this._loadToken || 0) + 1
    this.setData({ loading: false })
  },

  /** 输入自定义平台名（输入过程仅存值，失焦/确认时校验） */
  onCustomInput(e) {
    this.setData({ customPlatform: e.detail.value })
  },

  /** 自定义平台名校验：空 / 超长 / 非法字符返回错误文案 */
  validateCustom(name) {
    const maxLen = config.guidePlatformCustomMaxLen || 12
    if (!name) return '请输入平台名，如 携程'
    if (name.length > maxLen) return `平台名最多 ${maxLen} 个字`
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 ]+$/.test(name)) return '平台名仅支持中文、字母、数字与空格'
    return ''
  },

  /** 保存自定义平台并在平台变化时重新检索（名称未变则不重复请求） */
  applyCustomPlatform(name) {
    const changed = !(this.data.platform === 'other' && name === this._customSaved)
    this.setData({ customPlatform: name })
    this.applyPlatform('other')
    storage.saveSettings({ guidePlatform: 'other', guidePlatformCustom: name })
    this._customSaved = name
    if (!changed || !this.data.city) return
    this.setData({ liveItems: [], liveMeta: '', error: null, errorHint: '', needSetup: false })
    this.load(this.data.city, false)
  },

  /** 输入框失焦：仅保存合法且变化过的名称，避免误触重复检索与无意义提示 */
  onCustomBlur() {
    const name = String(this.data.customPlatform || '').trim()
    if (this.validateCustom(name)) return
    if (name === this._customSaved && this.data.platform === 'other') return
    this.applyCustomPlatform(name)
  },

  /** 确认自定义平台：校验后保存并触发检索 */
  confirmCustom() {
    const name = String(this.data.customPlatform || '').trim()
    const invalid = this.validateCustom(name)
    if (invalid) {
      wx.showToast({ title: invalid, icon: 'none' })
      return
    }
    this.applyCustomPlatform(name)
  },

  syncBadge() {
    const settings = storage.getSettings()
    const ready = storage.hasLlmConfig()
    const dataSource = settings.dataSource
    this.setData({
      llmReady: ready,
      dataSource,
      sourceBadge: dataSource !== 'cloud' ? '直连调试模式' : ready ? '大模型攻略速览' : '本机未配置大模型'
    })
  },

  onCityInput(e) {
    const inputCity = e.detail.value
    // 手动修改目的地后，之前地图选点的坐标不再对应
    const destPoint =
      this.data.destPoint && this.data.destPoint.name === inputCity ? this.data.destPoint : null
    this.setData({ inputCity, destPoint })
  },

  /** 地图选点：带坐标的目的地输入，后续规划直接复用该坐标 */
  chooseDest() {
    wx.chooseLocation({
      success: (res) => {
        const destPoint = {
          name: res.name || res.address || '地图选点',
          address: res.address || '',
          lng: res.longitude,
          lat: res.latitude
        }
        this.setData({ inputCity: destPoint.name, destPoint }, () => this.onSearch())
      },
      fail: () => {
        wx.showToast({ title: '已取消地图选点', icon: 'none' })
      }
    })
  },

  clearDest() {
    this.setData({ destPoint: null })
  },

  onSearch() {
    const city = String(this.data.inputCity || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!city) {
      wx.showToast({ title: '请先输入目的地', icon: 'none' })
      return
    }
    if (city.length > 20) {
      wx.showToast({ title: '目的地名称过长', icon: 'none' })
      return
    }
    if (this.data.loading) {
      wx.showToast({ title: '正在生成，请稍候', icon: 'none' })
      return
    }
    // 自定义平台未填名称时不检索，避免用通用检索词冒充该平台结果
    if (this.data.platform === 'other' && !String(this.data.customPlatform || '').trim()) {
      wx.showToast({ title: '请先输入平台名，如 携程', icon: 'none' })
      return
    }
    const picked = this.data.destPoint
    const destPoint = picked && picked.name === city ? picked : null
    this.setData({
      city,
      destPoint,
      openMap: {},
      liveItems: [],
      liveMeta: '',
      error: null,
      errorHint: '',
      needSetup: false
    })
    this.load(city, false)
  },

  /** 把目的地与坐标带到规划页，热门景点由规划页按兴趣偏好筛选 */
  planWithSpots() {
    // 优先用输入框里当前可见的目的地，避免用户改了输入但没检索时带到旧城市
    const city = String(this.data.inputCity || this.data.city || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!city) {
      wx.showToast({ title: '请先输入目的地', icon: 'none' })
      return
    }
    storage.setGuideDraft({
      createdAt: Date.now(),
      city,
      dest: this.data.destPoint || { name: city },
      platform: this.data.platform
    })
    wx.switchTab({ url: '/pages/index/index' })
  },

  load(city, force) {
    const token = (this._loadToken = (this._loadToken || 0) + 1)
    this.syncBadge()
    this.setData({ loading: true, error: null, errorHint: '', needSetup: false })
    guideService
      .load(city, {
        force: !!force,
        platform: this.data.platform,
        customPlatform: this.data.platform === 'other' ? this.data.customPlatform : ''
      })
      .then((res) => {
      if (token !== this._loadToken) return
      this._live = (res.live.items || []).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      this._loaded = true
      const error = res.live.error || null
      const hint = error
        ? error.code === 'GUIDE_EMPTY'
          ? `「${this.data.platformLabel}」暂未生成攻略速览，可切换平台或换个目的地`
          : error.message || ERROR_HINTS[error.code] || '可稍后重试'
        : ''
      this.setData({
        loading: false,
        liveItems: this._live.map((guide) => ({
          ...guide,
          kind: 'live',
          likesText: guide.likes ? format.popular(guide.likes) : ''
        })),
        liveMeta: buildLiveMeta(res.live),
        error,
        errorHint: hint,
        needSetup: !!(error && NEED_SETUP.indexOf(error.code) >= 0)
      })
    })
    .catch((err) => {
      if (token !== this._loadToken) return
      console.warn('[guide] 速览生成异常', (err && (err.errMsg || err.message)) || err)
      this.setData({
        loading: false,
        liveItems: [],
        liveMeta: '',
        error: { code: 'CLOUD_FAIL', message: '攻略速览生成异常，请稍后重试' },
        errorHint: '可检查云开发环境与 guideProxy 部署状态后重试',
        needSetup: false
      })
    })
  },

  refresh() {
    if (this.data.loading) return
    if (!this.data.city) {
      wx.showToast({ title: '请先输入目的地', icon: 'none' })
      return
    }
    if (this.data.platform === 'other' && !String(this.data.customPlatform || '').trim()) {
      wx.showToast({ title: '请先输入平台名，如 携程', icon: 'none' })
      return
    }
    this.load(this.data.city, true)
    wx.showToast({ title: '正在重新生成', icon: 'none' })
  },

  goPlan() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  toggleGuide(e) {
    const id = e.currentTarget.dataset.id
    const openMap = { ...this.data.openMap, [id]: !this.data.openMap[id] }
    this.setData({ openMap })
  },

  findGuide(id) {
    return (this._live || []).find((item) => item.id === id) || null
  },

  copyGuide(e) {
    const guide = this.findGuide(e.currentTarget.dataset.id)
    if (!guide) return
    const lines = [guide.title, guide.summary]
    ;(guide.points || []).forEach((point) => lines.push(`· ${point}`))
    if (guide.platformLabel) lines.push(`平台：${guide.platformLabel}`)
    if (guide.author) lines.push(`整理：${guide.author}`)
    if (guide.url) lines.push(`平台搜索：${guide.url}`)
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '攻略要点已复制', icon: 'none' })
    })
  },

  copySource(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '平台搜索链接已复制，可到浏览器或 App 打开', icon: 'none' })
    })
  },

  openRelatedPoi(e) {
    const name = e.currentTarget.dataset.name
    const bundle = storage.getBundle()
    const plan = bundle && bundle.plans ? bundle.plans[bundle.activeIndex || 0] : null
    const poi = plan && plan.pois ? plan.pois.find((item) => item.name === name) : null
    if (!poi) {
      wx.showToast({ title: '该点位未在当前行程中', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/poi/poi?id=${encodeURIComponent(poi.id)}` })
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  goHelp() {
    wx.switchTab({ url: '/pages/guideHelp/guideHelp' })
  }
})
