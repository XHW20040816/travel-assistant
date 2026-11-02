const config = require('../../config/index')
const decision = require('../../utils/decision')
const dateUtil = require('../../utils/date')
const storage = require('../../services/storage')
const mapService = require('../../services/map')
const guideService = require('../../services/guide')
const geo = require('../../utils/geo')

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

/** 自定义景点数量上限，避免把地图推荐 POI 挤出候选池 */
const MAX_CUSTOM_SPOTS = 8
/** 自定义景点距目的地超过该距离时提示一次（米） */
const FAR_SPOT_WARN_METERS = 50000

/** 景点名称归一化：去空白 + 小写，用于自定义点位与地图检索结果去重 */
function normalizeSpotName(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

/** 解析选点坐标：拒绝空串 / null / 越界 / (0,0)，避免 Number('') === 0 被当成合法坐标 */
function parseLngLat(lng, lat) {
  const rawLng = String(lng == null ? '' : lng).trim()
  const rawLat = String(lat == null ? '' : lat).trim()
  if (!rawLng || !rawLat) return null
  const x = Number(rawLng)
  const y = Number(rawLat)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < -180 || x > 180 || y < -90 || y > 90) return null
  if (x === 0 && y === 0) return null
  return { lng: x, lat: y }
}

/** 去重键：名称 + 坐标保留 5 位小数，同名不同位置可以共存 */
function spotKey(name, lng, lat) {
  const x = Number(lng)
  const y = Number(lat)
  const coord = Number.isFinite(x) && Number.isFinite(y) ? `${x.toFixed(5)},${y.toFixed(5)}` : ''
  return `${normalizeSpotName(name)}|${coord}`
}

Page({
  data: {
    cityOptions: [],
    destName: '',
    guideDraft: null,
    guideDest: null,
    spots: [],
    customSpots: [],
    spotInput: '',
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
    this._baseSpots = []
    this._farSpotWarned = false
    this.setData({
      spots: [],
      customSpots: [],
      spotInput: '',
      selectedSpotCount: 0,
      spotsLoading: false,
      spotError: '',
      spotHint: ''
    })
  },

  /** 自定义点位排在最前，再拼接地图推荐；同名同坐标只保留一条，避免刷新后重复 */
  composeSpots(baseSpots, customSpots) {
    const seen = {}
    const merged = []
    ;(customSpots || []).forEach((spot) => {
      const key = spotKey(spot.name, spot.lng, spot.lat)
      if (!normalizeSpotName(spot.name) || seen[key]) return
      seen[key] = true
      merged.push(spot)
    })
    ;(baseSpots || []).forEach((spot) => {
      const key = spotKey(spot.name, spot.lng, spot.lat)
      if (!normalizeSpotName(spot.name) || seen[key]) return
      seen[key] = true
      merged.push(spot)
    })
    return merged
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
      if (!spot.selected) deselected[spotKey(spot.name, spot.lng, spot.lat)] = true
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
          selected: !deselected[spotKey(spot.name, spot.lng, spot.lat)]
        }))
        this._baseSpots = formatted
        const composed = this.composeSpots(formatted, this.data.customSpots)
        this._spotLoadingKey = ''
        this.setData({
          spots: composed,
          selectedSpotCount: composed.filter((spot) => spot.selected).length,
          spotsLoading: false,
          spotHint
        })
      })
      .catch((err) => {
        if (token !== this._spotToken) return
        this._spotLoadingKey = ''
        console.warn('[index] 热门景点推荐失败', err && err.message)
        this._baseSpots = []
        const composed = this.composeSpots([], this.data.customSpots)
        this.setData({
          spots: composed,
          selectedSpotCount: composed.filter((spot) => spot.selected).length,
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
    const spot = this.data.spots[index]
    if (!spot) return
    const selected = !spot.selected
    const key = spotKey(spot.name, spot.lng, spot.lat)
    let customSpots = this.data.customSpots
    let baseSpots = this._baseSpots || []
    if (spot.custom) {
      customSpots = customSpots.map((item) => (item.id === spot.id ? { ...item, selected } : item))
    } else {
      baseSpots = baseSpots.map((item) =>
        item.id === spot.id || spotKey(item.name, item.lng, item.lat) === key ? { ...item, selected } : item
      )
    }
    this._baseSpots = baseSpots
    const spots = this.composeSpots(baseSpots, customSpots)
    this.setData({
      spots,
      customSpots,
      selectedSpotCount: spots.filter((item) => item.selected).length
    })
  },

  onSpotInput(e) {
    this.setData({ spotInput: e.detail.value })
  },

  /** 自定义景点：地图选点拿到真实坐标后加入推荐列表，名称优先用用户输入 */
  openSpotPicker() {
    wx.chooseLocation({
      success: (res) => this.addCustomSpot(res),
      fail: (err) => {
        const cancelled = err && /cancel/i.test(err.errMsg || '')
        wx.showToast({ title: cancelled ? '已取消选点' : '未获得定位权限', icon: 'none' })
      }
    })
  },

  addCustomSpot(res) {
    const coords = parseLngLat(res && res.longitude, res && res.latitude)
    if (!coords) {
      wx.showToast({ title: '选点坐标无效，请重新选择', icon: 'none' })
      return
    }
    const typed = String(this.data.spotInput || '').trim()
    const name = typed || String((res && res.name) || (res && res.address) || '').trim() || '自定义点位'
    const address = String((res && res.address) || '').trim()
    if ((this.data.customSpots || []).length >= MAX_CUSTOM_SPOTS) {
      wx.showToast({ title: `自定义景点最多 ${MAX_CUSTOM_SPOTS} 个`, icon: 'none' })
      return
    }
    const key = spotKey(name, coords.lng, coords.lat)
    const duplicated = (this.data.customSpots || []).some(
      (item) => spotKey(item.name, item.lng, item.lat) === key
    )
    if (duplicated) {
      wx.showToast({ title: '该地点已在列表中', icon: 'none' })
      return
    }
    const anchor = this.destAnchor()
    if (anchor && !this._farSpotWarned) {
      const meters = geo.haversine(anchor, coords)
      if (meters > FAR_SPOT_WARN_METERS) {
        this._farSpotWarned = true
        wx.showModal({
          title: '景点距离较远',
          content: `该点距目的地约 ${Math.round(meters / 1000)} 公里，加入后可能拉长赶路时间。`,
          confirmText: '仍要添加',
          cancelText: '取消',
          success: (result) => {
            if (result.confirm) this.appendCustomSpot(name, address, coords)
          }
        })
        return
      }
    }
    this.appendCustomSpot(name, address, coords)
  },

  /** 目的地坐标：优先用攻略页带来的选点，否则用当前地图推荐点的中心 */
  destAnchor() {
    const fromDraft = parseLngLat(
      this.data.guideDest && this.data.guideDest.lng,
      this.data.guideDest && this.data.guideDest.lat
    )
    if (fromDraft) return fromDraft
    let lng = 0
    let lat = 0
    let count = 0
    ;(this._baseSpots || []).forEach((spot) => {
      const point = parseLngLat(spot.lng, spot.lat)
      if (!point) return
      lng += point.lng
      lat += point.lat
      count += 1
    })
    if (!count) return null
    return { lng: lng / count, lat: lat / count }
  },

  /** 校验通过后写入自定义点位，并刷新列表 */
  appendCustomSpot(name, address, coords) {
    this._customSeq = (this._customSeq || 0) + 1
    const spot = {
      id: `custom_${Date.now()}_${this._customSeq}`,
      name,
      category: '自定义',
      rating: 0,
      ratingText: '地图选点',
      lng: coords.lng,
      lat: coords.lat,
      address,
      tags: [],
      custom: true,
      selected: true
    }
    const customSpots = (this.data.customSpots || []).concat(spot)
    const spots = this.composeSpots(this._baseSpots || [], customSpots)
    this.setData({
      customSpots,
      spots,
      spotInput: '',
      selectedSpotCount: spots.filter((item) => item.selected).length
    })
    wx.showToast({ title: `已添加：${name}`, icon: 'none' })
  },

  removeSpot(e) {
    const index = Number(e.currentTarget.dataset.index)
    const spot = this.data.spots[index]
    if (!spot || !spot.custom) return
    const customSpots = (this.data.customSpots || []).filter((item) => item.id !== spot.id)
    const spots = this.composeSpots(this._baseSpots || [], customSpots)
    this.setData({
      customSpots,
      spots,
      selectedSpotCount: spots.filter((item) => item.selected).length
    })
  },

  refreshSettings() {
    const origin = this.data.origin
    this.setData({
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
    // 换城市后旧的自定义点位坐标不再适用，一并清掉
    if (String(this.data.destName || '').trim() !== name) this.resetSpots()
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
      wx.showToast({ title: (err && err.message) || '未找到该目的地，请检查名称', icon: 'none' })
    }
    this.loadSpots()
  },

  async startPlanning() {
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

    // 自由输入必须能落到真实行政区，避免“火星”被模糊匹配到其他省份后直接规划
    if (!this.data.guideDest) {
      try {
        await mapService.geocode(destName, destName)
      } catch (err) {
        wx.showToast({ title: (err && err.message) || '未找到该目的地，请检查名称', icon: 'none' })
        return
      }
    }

    const request = {
      origin: this.data.origin,
      destName,
      dest: this.data.guideDest,
      hotSpots: spots.map((spot) => {
        const rest = Object.assign({}, spot)
        delete rest.selected
        return rest
      }),
      preferredSpots: spots.filter((spot) => spot.selected).map((spot) => spot.name),
      excludedSpots: spots.filter((spot) => !spot.selected).map((spot) => spot.name),
      preferredKeys: spots.filter((spot) => spot.selected).map((spot) => spotKey(spot.name, spot.lng, spot.lat)),
      excludedKeys: spots.filter((spot) => !spot.selected).map((spot) => spotKey(spot.name, spot.lng, spot.lat)),
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
