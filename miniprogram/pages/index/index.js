const config = require('../../config/index')
const decision = require('../../utils/decision')
const dateUtil = require('../../utils/date')
const storage = require('../../services/storage')
const mapService = require('../../services/map')
const guideService = require('../../services/guide')

const PREF_OPTIONS = Object.keys(decision.PREF_TAGS).map((key) => ({
  key,
  label: decision.PREF_TAGS[key].label
}))

const PACE_OPTIONS = Object.keys(decision.PACES).map((key) => ({
  key,
  label: decision.PACES[key].label
}))

const TRANSPORT_OPTIONS = [
  { key: 'mixed', label: '省时优先' },
  { key: 'transit', label: '公交优先' },
  { key: 'taxi', label: '打车优先' },
  { key: 'drive', label: '自驾' }
]

const STAY_TYPE_OPTIONS = [
  { key: 'any', label: '不限' },
  { key: 'hotel', label: '酒店' },
  { key: 'homestay', label: '民宿' },
  { key: 'hostel', label: '青旅' }
]

Page({
  data: {
    cityOptions: [],
    destName: '',
    guideDraft: null,
    guideDest: null,
    spots: [],
    spotsLoading: false,
    spotError: '',
    spotHint: '',
    selectedSpotCount: 0,
    origin: null,
    originLabel: '未设置 · 默认以目的地市中心为起点',
    startDate: '',
    startWeekday: '',
    endDate: '',
    endWeekday: '',
    endMaxDate: '',
    dayCount: 2,
    maxDays: config.limits.maxDays,
    dayStart: '09:00',
    dayEnd: '21:00',
    minDate: '',
    maxDate: '',
    prefOptions: PREF_OPTIONS,
    prefMap: {},
    paceOptions: PACE_OPTIONS,
    pace: 'normal',
    budgetRange: config.budgetRange,
    budgetMin: config.budgetRange.defaultMin,
    budgetMax: config.budgetRange.defaultMax,
    transportOptions: TRANSPORT_OPTIONS,
    transport: 'mixed',
    stayTypeOptions: STAY_TYPE_OPTIONS,
    stayType: 'any',
    stayBudgetRange: config.stayBudgetRange,
    stayMin: config.stayBudgetRange.defaultMin,
    stayMax: config.stayBudgetRange.defaultMax,
    party: 2,
    hasElder: false,
    hasChild: false,
    sourceText: '云开发实时数据',
    history: []
  },

  onLoad() {
    const today = dateUtil.todayStr()
    const startDate = dateUtil.addDays(today, 1)
    const endDate = dateUtil.addDays(startDate, 1)
    this.setData({
      startDate,
      startWeekday: dateUtil.weekdayCN(startDate),
      endDate,
      endWeekday: dateUtil.weekdayCN(endDate),
      endMaxDate: dateUtil.addDays(startDate, config.limits.maxDays - 1),
      dayCount: dateUtil.daysBetween(startDate, endDate),
      minDate: today,
      maxDate: dateUtil.addDays(today, 60)
    })
    this.refreshSettings()
  },

  onShow() {
    this.refreshSettings()
    this.applyGuideDraft()
    this.setData({ history: storage.listHistory().slice(0, 3) })
  },

  /** 读取攻略页带来的目的地与坐标；同一份草稿不重复覆盖用户当前输入 */
  applyGuideDraft() {
    const draft = storage.getGuideDraft()
    if (!draft || !draft.city) {
      if (!this.data.guideDraft) return
      this.setData({ guideDraft: null, guideDest: null }, () => this.resetSpots())
      return
    }
    if (this.data.guideDraft && this.data.guideDraft.createdAt === draft.createdAt) return
    this.setData(
      { destName: draft.city, guideDraft: draft, guideDest: draft.dest || null },
      () => this.loadSpots()
    )
  },

  /** 目的地被手动改写后，攻略页带来的坐标不再适用 */
  clearGuideSelection() {
    if (!this.data.guideDraft) return
    storage.clearGuideDraft()
    this.setData({ guideDraft: null, guideDest: null })
    this.resetSpots()
  },

  resetSpots() {
    // 让仍在进行的旧请求失效，避免切城市后回填上一座城市的景点
    this._spotToken = (this._spotToken || 0) + 1
    this._spotLoadingKey = ''
    this.setData({ spots: [], selectedSpotCount: 0, spotsLoading: false, spotError: '', spotHint: '' })
  },

  /** 热门景点推荐：按目的地与兴趣偏好检索地图真实 POI，默认全部保留 */
  loadSpots() {
    const city = String(this.data.destName || '')
      .trim()
      .replace(/\s+/g, ' ')
    const prefs = Object.keys(this.data.prefMap).filter((key) => this.data.prefMap[key])
    if (!city) {
      this.resetSpots()
      return
    }
    // 同一个目的地 + 同一组偏好正在请求时直接复用，避免回车/失焦同时触发重复调用
    const requestKey = `${city}|${prefs.join(',')}`
    if (this._spotLoadingKey === requestKey) return
    // 偏好变更后重新筛选时，保留用户已经取消的景点选择
    const deselected = {}
    ;(this.data.spots || []).forEach((spot) => {
      if (!spot.selected) deselected[String(spot.name || '').replace(/\s+/g, '')] = true
    })
    const token = (this._spotToken = (this._spotToken || 0) + 1)
    this._spotLoadingKey = requestKey
    this._spotCity = city
    this.setData({ spotsLoading: true, spotError: '', spotHint: '' })
    guideService
      .suggestSpots(city, { dest: this.data.guideDest, prefs, limit: 12 })
      .then((list) => {
        if (token !== this._spotToken) return
        let spots = list
        let spotHint = ''
        if (prefs.length) {
          const labels = prefs.map((key) => decision.PREF_TAGS[key] && decision.PREF_TAGS[key].label).filter(Boolean)
          const matched = list.filter((spot) => decision.matchPrefs(spot, prefs).length)
          if (matched.length) {
            spots = matched
            spotHint = `已按兴趣偏好筛选：${labels.join('、')}`
          } else {
            spotHint = '未找到与兴趣偏好匹配的景点，先展示地图热门景点'
          }
        }
        const formatted = spots.map((spot) => ({
          ...spot,
          selected: !deselected[String(spot.name || '').replace(/\s+/g, '')]
        }))
        this._spotLoadingKey = ''
        this.setData({
          spots: formatted,
          selectedSpotCount: formatted.filter((spot) => spot.selected).length,
          spotsLoading: false,
          spotHint
        })
      })
      .catch((err) => {
        if (token !== this._spotToken) return
        this._spotLoadingKey = ''
        console.warn('[index] 热门景点推荐失败', err && err.message)
        this.setData({
          spots: [],
          selectedSpotCount: 0,
          spotsLoading: false,
          spotError: (err && err.message) || '地图数据暂不可用'
        })
      })
  },

  refreshSpots() {
    if (this.data.spotsLoading) return
    if (!String(this.data.destName || '').trim()) {
      wx.showToast({ title: '请先填写目的地', icon: 'none' })
      return
    }
    this.loadSpots()
  },

  toggleSpot(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isFinite(index) || !this.data.spots[index]) return
    const spots = this.data.spots.map((spot, i) =>
      i === index ? { ...spot, selected: !spot.selected } : spot
    )
    this.setData({
      spots,
      selectedSpotCount: spots.filter((spot) => spot.selected).length
    })
  },

  refreshSettings() {
    const settings = storage.getSettings()
    const sourceMap = { cloud: '云开发实时数据', direct: '直连地图 API' }
    const origin = this.data.origin
    this.setData({
      sourceText: sourceMap[settings.dataSource] || '云开发实时数据',
      originLabel: origin
        ? `${origin.name} · ${Number(origin.lng).toFixed(2)}, ${Number(origin.lat).toFixed(2)}`
        : '未设置 · 默认以目的地市中心为起点'
    })
  },

  onDestInput(e) {
    const destName = e.detail.value
    const draft = this.data.guideDraft
    // 目的地与攻略页不一致时，清掉坐标与景点选择，避免把别的城市推荐带进来
    if (draft && String(destName || '').trim() !== draft.city) this.clearGuideSelection()
    const city = String(destName || '').trim()
    if (this._spotCity && city !== this._spotCity) this.resetSpots()
    this.setData({ destName })
  },

  onDestBlur() {
    const city = String(this.data.destName || '').trim()
    if (city && city !== this._spotCity) this.loadSpots()
  },

  pickCity(e) {
    const name = e.currentTarget.dataset.name
    if (this.data.guideDraft && name !== this.data.guideDraft.city) this.clearGuideSelection()
    this.setData({ destName: name }, () => this.loadSpots())
  },

  onStartChange(e) {
    const startDate = e.detail.value
    const keepDays = Math.max(1, this.data.dayCount)
    const maxEnd = dateUtil.addDays(startDate, config.limits.maxDays - 1)
    let endDate = dateUtil.addDays(startDate, keepDays - 1)
    if (endDate < startDate) endDate = startDate
    if (endDate > maxEnd) endDate = maxEnd
    this.setData({
      startDate,
      startWeekday: dateUtil.weekdayCN(startDate),
      endDate,
      endWeekday: dateUtil.weekdayCN(endDate),
      endMaxDate: maxEnd,
      dayCount: dateUtil.daysBetween(startDate, endDate)
    })
  },

  onEndChange(e) {
    const startDate = this.data.startDate
    let endDate = e.detail.value
    if (dateUtil.daysBetween(startDate, endDate) < 1) {
      endDate = startDate
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
    }
    const span = dateUtil.daysBetween(startDate, endDate)
    if (span > config.limits.maxDays) {
      endDate = dateUtil.addDays(startDate, config.limits.maxDays - 1)
      wx.showToast({ title: `最多可选 ${config.limits.maxDays} 天`, icon: 'none' })
    }
    this.setData({
      endDate,
      endWeekday: dateUtil.weekdayCN(endDate),
      dayCount: dateUtil.daysBetween(startDate, endDate)
    })
  },

  onDayStartChange(e) {
    this.setData({ dayStart: e.detail.value })
  },

  onDayEndChange(e) {
    this.setData({ dayEnd: e.detail.value })
  },

  togglePref(e) {
    const key = e.currentTarget.dataset.key
    const prefMap = { ...this.data.prefMap }
    prefMap[key] = !prefMap[key]
    this.setData({ prefMap }, () => {
      if (!String(this.data.destName || '').trim()) return
      // 连续点选时合并成一次检索，避免地图接口被频繁调用
      clearTimeout(this._prefTimer)
      this._prefTimer = setTimeout(() => this.loadSpots(), 350)
    })
  },

  setPace(e) {
    this.setData({ pace: e.currentTarget.dataset.key })
  },

  onBudgetMinInput(e) {
    this.setData({ budgetMin: e.detail.value })
  },

  onBudgetMinBlur() {
    const { min: lower, max: upper, step } = this.data.budgetRange
    let min = Math.round(Number(this.data.budgetMin))
    let max = Number(this.data.budgetMax)
    if (!Number.isFinite(min)) min = lower
    min = Math.max(lower, Math.min(upper, min))
    // 只保证「最低 < 最高」，不把两端锁成同一个数
    if (min >= max) {
      max = Math.min(upper, min + step)
      if (max === min) min = Math.max(lower, max - step)
    }
    this.setData({ budgetMin: min, budgetMax: max })
  },

  onBudgetMaxInput(e) {
    this.setData({ budgetMax: e.detail.value })
  },

  onBudgetMaxBlur() {
    const { min: lower, max: upper, step } = this.data.budgetRange
    let max = Math.round(Number(this.data.budgetMax))
    let min = Number(this.data.budgetMin)
    if (!Number.isFinite(max)) max = upper
    max = Math.max(lower, Math.min(upper, max))
    if (max <= min) {
      min = Math.max(lower, max - step)
      if (min === max) max = Math.min(upper, min + step)
    }
    this.setData({ budgetMin: min, budgetMax: max })
  },

  setTransport(e) {
    this.setData({ transport: e.currentTarget.dataset.key })
  },

  setStayType(e) {
    this.setData({ stayType: e.currentTarget.dataset.key })
  },

  onStayMinInput(e) {
    this.setData({ stayMin: e.detail.value })
  },

  onStayMinBlur() {
    const { min: lower, max: upper, step } = this.data.stayBudgetRange
    let min = Math.round(Number(this.data.stayMin))
    let max = Number(this.data.stayMax)
    if (!Number.isFinite(min)) min = lower
    min = Math.max(lower, Math.min(upper, min))
    if (min >= max) {
      max = Math.min(upper, min + step)
      if (max === min) min = Math.max(lower, max - step)
    }
    this.setData({ stayMin: min, stayMax: max })
  },

  onStayMaxInput(e) {
    this.setData({ stayMax: e.detail.value })
  },

  onStayMaxBlur() {
    const { min: lower, max: upper, step } = this.data.stayBudgetRange
    let max = Math.round(Number(this.data.stayMax))
    let min = Number(this.data.stayMin)
    if (!Number.isFinite(max)) max = upper
    max = Math.max(lower, Math.min(upper, max))
    if (max <= min) {
      min = Math.max(lower, max - step)
      if (min === max) max = Math.min(upper, min + step)
    }
    this.setData({ stayMin: min, stayMax: max })
  },

  changeParty(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const party = Math.min(10, Math.max(1, this.data.party + delta))
    this.setData({ party })
  },

  toggleElder() {
    this.setData({ hasElder: !this.data.hasElder })
  },

  toggleChild() {
    this.setData({ hasChild: !this.data.hasChild })
  },

  useLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        const origin = {
          name: '当前位置',
          lng: res.longitude,
          lat: res.latitude
        }
        this.setData({ origin })
        this.refreshSettings()
      },
      fail: () => {
        wx.showToast({ title: '未获得定位权限', icon: 'none' })
      }
    })
  },

  chooseOrigin() {
    wx.chooseLocation({
      success: (res) => {
        const origin = {
          name: res.name || res.address || '地图选点',
          lng: res.longitude,
          lat: res.latitude
        }
        this.setData({ origin })
        this.refreshSettings()
      },
      fail: () => {
        wx.showToast({ title: '已取消选点', icon: 'none' })
      }
    })
  },

  clearOrigin() {
    this.setData({ origin: null })
    this.refreshSettings()
  },

  async suggestByKeyword() {
    const keyword = this.data.destName
    if (!keyword) return
    try {
      const result = await mapService.geocode(keyword, keyword)
      if (result) {
        wx.showToast({ title: `已匹配：${result.city || keyword}`, icon: 'none' })
      }
    } catch (err) {
      console.warn('[index] geocode failed', err.message)
    }
    this.loadSpots()
  },

  startPlanning() {
    const destName = String(this.data.destName || '').trim()
    if (!destName) {
      wx.showToast({ title: '请先填写目的地', icon: 'none' })
      return
    }
    const days = dateUtil.daysBetween(this.data.startDate, this.data.endDate)
    if (days < 1) {
      wx.showToast({ title: '请检查出行开始/结束日期', icon: 'none' })
      return
    }
    if (dateUtil.clockToMinutes(this.data.dayEnd) < dateUtil.clockToMinutes(this.data.dayStart) + 60) {
      wx.showToast({ title: '结束时间需比开始时间晚至少 1 小时', icon: 'none' })
      return
    }
    const prefs = Object.keys(this.data.prefMap).filter((key) => this.data.prefMap[key])
    const spots = this.data.spots || []
    if (spots.length && !spots.some((spot) => spot.selected)) {
      wx.showToast({ title: '请至少保留一个景点', icon: 'none' })
      return
    }

    const request = {
      origin: this.data.origin,
      destName,
      dest: this.data.guideDest,
      hotSpots: spots.map((spot) => {
        const { selected: _selected, ...rest } = spot
        return rest
      }),
      preferredSpots: spots.filter((spot) => spot.selected).map((spot) => spot.name),
      excludedSpots: spots.filter((spot) => !spot.selected).map((spot) => spot.name),
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      days,
      dayStart: this.data.dayStart,
      dayEnd: this.data.dayEnd,
      prefs,
      pace: this.data.pace,
      budgetMin: this.data.budgetMin,
      budgetMax: this.data.budgetMax,
      transport: this.data.transport,
      stayType: this.data.stayType,
      stayMin: this.data.stayMin,
      stayMax: this.data.stayMax,
      party: this.data.party,
      hasElder: this.data.hasElder,
      hasChild: this.data.hasChild
    }

    storage.setPendingRequest(request)
    wx.navigateTo({ url: '/pages/plan/plan' })
  },

  openHistory(e) {
    const id = e.currentTarget.dataset.id
    const entry = storage.listHistory().find((item) => item.id === id)
    if (!entry) return
    const saved = entry.plan && entry.plan.dest
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
  }
})
