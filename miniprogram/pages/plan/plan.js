const storage = require('../../services/storage')
const planService = require('../../services/plan')
const dateUtil = require('../../utils/date')
const format = require('../../utils/format')

const STEPS = [
  '解析目的地与坐标',
  '检索景点与热度',
  '获取逐日天气',
  '多因子打分分组',
  '动线路径优化',
  '实时路况校正',
  '筛选住宿与通勤锚点',
  '生成说明与风险'
]

Page({
  data: {
    loading: true,
    error: '',
    percent: 0,
    progressText: '正在准备规划…',
    steps: STEPS.map((label) => ({ label, state: 'pending' })),
    plansMeta: [],
    activeIndex: 0,
    plan: null,
    dayCards: [],
    stayCards: [],
    stayActive: 0,
    spotChips: [],
    spotActiveCount: 0,
    metaText: '',
    destLine: ''
  },

  onLoad(options) {
    try {
      const bundle = storage.getBundle()
      if (options && options.id === 'history' && bundle && Array.isArray(bundle.plans) && bundle.plans.length) {
        this.bundle = bundle
        this.render(bundle, 0)
        return
      }
      const request = storage.getPendingRequest()
      if (!request) {
        this.setData({ loading: false, error: '未找到规划参数，请返回首页重新填写' })
        return
      }
      this.generate(request)
    } catch (err) {
      console.error('[plan] 页面初始化失败', err)
      this.setData({ loading: false, error: (err && err.message) || '行程数据读取失败，请返回首页重新规划' })
    }
  },

  async generate(request) {
    this.setData({
      loading: true,
      error: '',
      percent: 4,
      progressText: '正在准备规划…',
      stayCards: [],
      stayActive: 0,
      spotChips: [],
      spotActiveCount: 0,
      steps: STEPS.map((label) => ({ label, state: 'pending' }))
    })

    const keepVariant =
      this.bundle && this.bundle.plans && this.bundle.plans[this.data.activeIndex]
        ? this.bundle.plans[this.data.activeIndex].variant
        : null

    try {
      const bundle = await planService.generate(request, (payload) => {
        const step = Number(payload.step) || 0
        const steps = STEPS.map((label, index) => ({
          label,
          state: index < step ? 'done' : index === step ? 'active' : 'pending'
        }))
        this.setData({
          percent: Math.min(96, Number(payload.percent) || 4),
          progressText: payload.text || '',
          steps
        })
      })
      this.bundle = bundle
      const nextIndex = keepVariant
        ? Math.max(0, bundle.plans.findIndex((item) => item.variant === keepVariant))
        : 0
      this.render(bundle, nextIndex)
      this.setData({ percent: 100 })
    } catch (err) {
      console.warn('[plan] generate failed', err)
      this.setData({
        loading: false,
        error: (err && err.message) || '规划失败，请检查数据源配置',
        steps: STEPS.map((label) => ({ label, state: 'pending' }))
      })
    }
  },

  render(bundle, index) {
    try {
      const plans = bundle && Array.isArray(bundle.plans) ? bundle.plans : []
      const plan = plans[index] || plans[0]
      if (!plan) {
        this.setData({ loading: false, error: '行程数据为空，请返回首页重新规划' })
        return
      }
      const req = bundle.request || plan.request || {}
      // 兼容旧历史方案：补齐模板需要的字段
      plan.rank = plan.rank || 1
      plan.request = plan.request || req
      plan.party = plan.party || req.party || ''
      plan.metrics = plan.metrics || {}
      const planMeta = plans.map((item, i) => ({
        name: item.name,
        tagline: item.tagline,
        score: item.score,
        scoreCls: item.scoreCls,
        active: i === index
      }))

      const dayCards = (Array.isArray(plan.days) ? plan.days : []).map((day, dayIndex) => ({
        date: day.date,
        dateLabel: day.dateLabel,
        weekday: day.weekday,
        weatherText: day.weatherText,
        tempText: day.tempText,
        rainText: day.rainText,
        clothing: day.clothing,
        activity: day.activity,
        statsText: day.statsText,
        endText: day.endText,
        dropped: day.dropped,
        open: dayIndex === 0,
        items: (Array.isArray(day.items) ? day.items : []).map((item) => {
          const { points, ...rest } = item
          return rest
        })
      }))

      const meta = plan.meta || {}
      const metaText = `POI 数据 ${meta.poiFetchedAt ? dateUtil.relativeTime(meta.poiFetchedAt) : '未知'} · 天气 ${
        meta.weatherFetchedAt ? dateUtil.relativeTime(meta.weatherFetchedAt) : '未知'
      }${meta.dataNote ? ` · ${meta.dataNote}` : ''}`
      const destLine = `${req.destName || ''} · ${req.startDate}${req.endDate ? ` → ${req.endDate}` : ''} · ${req.days} 天 · ${req.party} 人${req.dayStart && req.dayEnd ? ` · 每日 ${req.dayStart}-${req.dayEnd}` : ''} · ${req.budgetLabel || ''}`

      // 三套方案共用同一批住宿：切换方案时保留当前选中项，避免列表跳变
      const stayList = Array.isArray(plan.stays) ? plan.stays : []
      const stayActive = stayList.length ? Math.min(this.data.stayActive, stayList.length - 1) : 0
      const stayCards = stayList.map((item, i) => ({ ...item, active: i === stayActive }))
      plan.stayBudgetText = plan.stayBudgetText || ''
      plan.stayAnchorText = plan.stayAnchorText || ''

      // 推荐景点池来自本次检索的候选，取消勾选后重新规划即可排除
      const pool = Array.isArray(bundle.hotSpots) && bundle.hotSpots.length
        ? bundle.hotSpots
        : Array.isArray(req.hotSpots)
          ? req.hotSpots
          : []
      const excluded = Array.isArray(req.excludedSpots) ? req.excludedSpots : []
      const spotChips = pool.map((spot) => ({
        ...spot,
        ratingText: Number(spot.rating) > 0 ? Number(spot.rating).toFixed(1) : '暂无评分',
        active: excluded.indexOf(spot.name) < 0
      }))

      this.setData({
        loading: false,
        error: '',
        plan,
        plansMeta: planMeta,
        activeIndex: index,
        dayCards,
        stayCards,
        stayActive,
        spotChips,
        spotActiveCount: spotChips.filter((spot) => spot.active).length,
        metaText,
        destLine
      })

      if (req.destName) {
        wx.setNavigationBarTitle({ title: `${req.destName} ${req.days} 天行程` })
      }
    } catch (err) {
      console.error('[plan] 渲染失败', err)
      this.setData({ loading: false, error: `行程渲染失败：${(err && err.message) || '数据格式异常'}` })
    }
  },

  switchPlan(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!this.bundle || index === this.data.activeIndex) return
    this.render(this.bundle, index)
  },

  switchStay(e) {
    const index = Number(e.currentTarget.dataset.index)
    const stayCards = this.data.stayCards.map((item, i) => ({ ...item, active: i === index }))
    this.setData({ stayActive: index, stayCards })
  },

  toggleSpotChip(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isFinite(index) || !this.data.spotChips[index]) return
    const spotChips = this.data.spotChips.map((spot, i) =>
      i === index ? { ...spot, active: !spot.active } : spot
    )
    this.setData({
      spotChips,
      spotActiveCount: spotChips.filter((spot) => spot.active).length
    })
  },

  /** 按当前勾选重新规划：取消的景点进入排除名单，保留的景点优先安排 */
  applySpots() {
    if (this.data.loading || !this.bundle) return
    const chips = this.data.spotChips
    if (chips.length && !chips.some((spot) => spot.active)) {
      wx.showToast({ title: '请至少保留一个景点', icon: 'none' })
      return
    }
    const base = { ...(this.bundle.request || {}) }
    // 重新规划沿用缓存，除非用户再次点「刷新实时数据」
    base.force = false
    if (!base.dest && this.bundle.dest) {
      base.dest = {
        name: this.bundle.dest.name,
        lng: this.bundle.dest.lng,
        lat: this.bundle.dest.lat,
        adcode: this.bundle.dest.adcode || '',
        address: this.bundle.dest.address || ''
      }
    }
    base.hotSpots = chips.map((spot) => {
      const { active: _active, ratingText: _ratingText, ...rest } = spot
      return rest
    })
    base.preferredSpots = chips.filter((spot) => spot.active).map((spot) => spot.name)
    base.excludedSpots = chips.filter((spot) => !spot.active).map((spot) => spot.name)
    wx.showToast({ title: '正在按新的选择重新规划', icon: 'none' })
    this.generate(base)
  },

  openStayMap(e) {
    const index = Number(e.currentTarget.dataset.index)
    const stay = this.data.stayCards[index]
    if (!stay) return
    wx.openLocation({
      latitude: Number(stay.lat),
      longitude: Number(stay.lng),
      name: stay.name,
      address: stay.address || '',
      scale: 16
    })
  },

  toggleDay(e) {
    const index = Number(e.currentTarget.dataset.index)
    const dayCards = this.data.dayCards.map((day, i) =>
      i === index ? { ...day, open: !day.open } : day
    )
    this.setData({ dayCards })
  },

  openPoi(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/poi/poi?id=${encodeURIComponent(id)}` })
  },

  navigatePoi(e) {
    const id = e.currentTarget.dataset.id
    const plan = this.data.plan
    const poi = plan && plan.pois ? plan.pois.find((item) => item.id === id) : null
    if (!poi) {
      wx.showToast({ title: '缺少坐标，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: Number(poi.lat),
      longitude: Number(poi.lng),
      name: poi.name,
      address: poi.address || '',
      scale: 16
    })
  },

  goMap() {
    if (!this.bundle) return
    this.bundle.activeIndex = this.data.activeIndex
    storage.saveBundle(this.bundle)
    wx.navigateTo({ url: '/pages/map/map' })
  },

  goWeather() {
    wx.navigateTo({ url: '/pages/weather/weather' })
  },

  goGuide() {
    wx.switchTab({ url: '/pages/guide/guide' })
  },

  copyPlan() {
    const plan = this.data.plan
    if (!plan) return
    const req = (this.bundle && this.bundle.request) || {}
    const lines = [
      `${req.destName || ''} ${req.days || ''} 天行程 · ${plan.name}（${plan.score} 分）`,
      `${req.startDate || ''} 出发 · ${req.party || ''} 人 · 人均约 ${plan.metrics.perPersonText} · 总计 ${plan.metrics.totalCostText}`
    ]
    plan.days.forEach((day, index) => {
      lines.push('')
      lines.push(`D${index + 1} ${day.dateLabel} ${day.weekday} ${day.weatherText} ${day.tempText} · ${day.clothing.level}`)
      day.items.forEach((item) => {
        if (item.type === 'poi') {
          const costText =
            item.unitCost === null || item.unitCost === undefined
              ? '（票价未公开）'
              : item.unitCost
                ? `（${item.costText}）`
                : '（免费）'
          lines.push(`${item.timeText}-${item.endText} ${item.name}${costText}`)
        } else if (item.type === 'transit') {
          lines.push(`${item.timeText} ${item.fromName} → ${item.toName}：${item.modeLabel}约 ${item.durationText}`)
        } else if (item.type === 'meal') {
          lines.push(`${item.timeText} ${item.title}`)
        }
      })
    })
    lines.push('')
    lines.push('提示：开放时间、门票与预约政策请以官方公告为准；攻略内容请注意更新时间。')

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '行程已复制', icon: 'success' })
    })
  },

  refreshData() {
    wx.showModal({
      title: '刷新实时数据',
      content: '将清空本地缓存并重新请求路线、天气与景点数据，可能产生少量接口调用。',
      confirmText: '刷新',
      success: (res) => {
        if (!res.confirm) return
        storage.cacheClear()
        const req = this.bundle && this.bundle.request
        if (!req) return
        const raw = {
          ...req,
          startDate: req.startDate,
          days: req.days,
          force: true
        }
        this.generate(raw)
      }
    })
  },

  retry() {
    const request = storage.getPendingRequest() || (this.bundle && this.bundle.request)
    if (request) this.generate(request)
  },

  backToEdit() {
    wx.navigateBack()
  }
})
