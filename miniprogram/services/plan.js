/**
 * 规划编排：目的地解析 → POI 检索 → 天气 → 多方案打分分组 → 路径优化 → 实时路况校正 → 说明与风险
 */
const config = require('../config/index')
const decision = require('../utils/decision')
const geo = require('../utils/geo')
const dateUtil = require('../utils/date')
const format = require('../utils/format')
const storage = require('./storage')
const mapService = require('./map')
const weatherService = require('./weather')
const guideService = require('./guide')
const hotelService = require('./hotel')

const FINAL_WEIGHTS = {
  balanced: { quality: 0.34, time: 0.2, budget: 0.16, weather: 0.14, coverage: 0.16 },
  time: { quality: 0.3, time: 0.3, budget: 0.1, weather: 0.14, coverage: 0.16 },
  budget: { quality: 0.3, time: 0.14, budget: 0.32, weather: 0.1, coverage: 0.14 }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 经纬度必须同时落在合法范围内，避免越界坐标进入 POI / 路线请求 */
function isCoordPair(lng, lat) {
  const x = Number(lng)
  const y = Number(lat)
  return Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90
}

function mean(list) {
  if (!list.length) return 0
  return list.reduce((sum, item) => sum + item, 0) / list.length
}

function normalizeClock(value, fallback) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''))
  return m ? `${m[1]}:${m[2]}` : fallback
}

/** 预算范围由用户手动设置：取区间中值作为人均日预算，餐饮按比例折算 */
function resolveBudget(raw) {
  const range = config.budgetRange
  const clamp = (value, fallback) => {
    const num = Math.round(Number(value))
    if (!Number.isFinite(num) || num <= 0) return fallback
    return Math.min(range.max, Math.max(range.min, num))
  }
  let min = clamp(raw.budgetMin, range.defaultMin)
  let max = clamp(raw.budgetMax, range.defaultMax)
  if (min >= max) {
    // 只要求「最低 < 最高」：留出一个步长的间距，避免两端锁成同一个数
    if (min + range.step <= range.max) max = min + range.step
    else min = max - range.step
  }
  const perDay = Math.round((min + max) / 2)
  return {
    key: 'custom',
    label: `${min}–${max} 元/人/天`,
    min,
    max,
    perDay,
    mealLunch: Math.round((perDay * 0.12) / 5) * 5,
    mealDinner: Math.round((perDay * 0.19) / 5) * 5
  }
}

/** 住宿预算：每晚每间，独立于人均日预算，避免「按人」与「按间」口径混用 */
function resolveStayBudget(raw) {
  const range = config.stayBudgetRange
  const clamp = (value, fallback) => {
    const num = Math.round(Number(value))
    if (!Number.isFinite(num) || num <= 0) return fallback
    return Math.min(range.max, Math.max(range.min, num))
  }
  let min = clamp(raw.stayMin, range.defaultMin)
  let max = clamp(raw.stayMax, range.defaultMax)
  if (min >= max) {
    if (min + range.step <= range.max) max = min + range.step
    else min = max - range.step
  }
  const type = ['any', 'hotel', 'homestay', 'hostel'].indexOf(raw.stayType) >= 0 ? raw.stayType : 'any'
  return {
    stayMin: min,
    stayMax: max,
    stayType: type,
    stayBudgetLabel: `每晚 ${min}–${max} 元 · ${hotelService.typeLabel(type)}`
  }
}

function cleanNames(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, max || 20)
}

/** 规划页带入的景点池：只保留规划与页面展示需要的字段 */
function cleanSpots(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object' && item.name)
    .map((item) => ({
      id: String(item.id || item.name),
      name: String(item.name),
      category: String(item.category || '综合'),
      rating: Number(item.rating) > 0 ? Number(item.rating) : null,
      lng: Number(item.lng),
      lat: Number(item.lat),
      address: String(item.address || ''),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : []
    }))
    .filter((item) => item.name)
    .slice(0, 20)
}

function normalizeRequest(raw) {
  const budget = resolveBudget(raw)
  const stay = resolveStayBudget(raw)
  const party = Math.min(10, Math.max(1, Number(raw.party) || 2))
  const maxDays = config.limits.maxDays

  const startDate = dateUtil.isValidDate(raw.startDate)
    ? raw.startDate
    : dateUtil.addDays(dateUtil.todayStr(), 1)

  // 优先按用户设置的结束日期推导天数，缺失时回退旧字段 days
  let days = Math.min(maxDays, Math.max(1, Number(raw.days) || 2))
  let endDate = dateUtil.isValidDate(raw.endDate) ? raw.endDate : dateUtil.addDays(startDate, days - 1)
  const span = dateUtil.daysBetween(startDate, endDate)
  if (span > maxDays) {
    days = maxDays
    endDate = dateUtil.addDays(startDate, days - 1)
  } else if (span > 0) {
    days = span
  } else if (dateUtil.isValidDate(raw.endDate)) {
    // 结束早于开始时按单日行程处理
    days = 1
    endDate = startDate
  } else {
    endDate = dateUtil.addDays(startDate, days - 1)
  }

  // 每日活动时段：默认 09:00-21:00，至少保留 1 小时
  const dayStart = normalizeClock(raw.dayStart, '09:00')
  let dayEnd = normalizeClock(raw.dayEnd, '21:00')
  const startMinutes = dateUtil.clockToMinutes(dayStart)
  if (dateUtil.clockToMinutes(dayEnd) < startMinutes + 60) {
    dayEnd = dateUtil.minutesToClock(Math.min(24 * 60 - 1, startMinutes + 120))
  }

  const originValid = !!raw.origin && isCoordPair(raw.origin.lng, raw.origin.lat)
  return {
    origin: originValid ? raw.origin : { ...config.defaultCity },
    originProvided: originValid,
    destName: String(raw.destName || '').trim() || config.defaultCity.name,
    dest: raw.dest && isCoordPair(raw.dest.lng, raw.dest.lat)
      ? {
          name: String(raw.dest.name || raw.destName || '').trim(),
          lng: Number(raw.dest.lng),
          lat: Number(raw.dest.lat),
          adcode: String(raw.dest.adcode || ''),
          address: String(raw.dest.address || '')
        }
      : null,
    hotSpots: cleanSpots(raw.hotSpots),
    preferredSpots: cleanNames(raw.preferredSpots, 20),
    excludedSpots: cleanNames(raw.excludedSpots, 20),
    startDate,
    endDate,
    days,
    dayStart,
    dayEnd,
    prefs: Array.isArray(raw.prefs) ? raw.prefs : [],
    pace: raw.pace || 'normal',
    budgetKey: budget.key,
    budgetLabel: budget.label,
    budgetMin: budget.min,
    budgetMax: budget.max,
    budget,
    transport: raw.transport || 'mixed',
    party,
    stayMin: stay.stayMin,
    stayMax: stay.stayMax,
    stayType: stay.stayType,
    stayBudgetLabel: stay.stayBudgetLabel,
    hasElder: !!raw.hasElder,
    hasChild: !!raw.hasChild,
    hotelName: raw.hotelName || '',
    remark: raw.remark || '',
    // 页面「刷新实时数据」会显式要求绕过客户端与云端缓存
    force: !!raw.force
  }
}

async function resolveDestination(req) {
  // 地图选点已带坐标：坐标直接采用，仍补一次地理编码以获得城市与 adcode
  if (req.dest) {
    if (req.dest.adcode) {
      return {
        ...req.dest,
        level: '市',
        intro: '目的地城市已接入实时数据源',
        source: 'map-pick'
      }
    }
    // 地图选点常给的是景区/街区名，用地址反查城市更稳；反查失败不影响已持有的坐标
    let geoResult = null
    try {
      geoResult = await mapService.geocode(req.dest.address || req.dest.name || req.destName)
    } catch (err) {
      console.warn('[plan] 地图选点反查城市失败，改用选点名称', err && err.message)
    }
    return {
      name: (geoResult && geoResult.city) || req.dest.name || req.destName,
      adcode: (geoResult && geoResult.adcode) || '',
      lng: Number(req.dest.lng),
      lat: Number(req.dest.lat),
      level: (geoResult && geoResult.level) || '市',
      intro: '目的地城市已接入实时数据源',
      source: 'map-pick'
    }
  }
  const geoResult = await mapService.geocode(req.destName, req.destName)
  return {
    name: geoResult.city || req.destName,
    adcode: geoResult.adcode || '',
    lng: geoResult.lng,
    lat: geoResult.lat,
    level: geoResult.level || '市',
    intro: '目的地城市已接入实时数据源',
    source: geoResult.source
  }
}

/** 名称归一化：仅用于用户勾选/排除的同名匹配 */
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

function isExcluded(name, excludedNames) {
  const key = normalizeName(name)
  if (!key) return false
  return (excludedNames || []).some((item) => normalizeName(item) === key)
}

function hotelPoint(req) {
  const origin = req.origin
  const useOrigin =
    origin &&
    Number(origin.lng) &&
    Number(origin.lat) &&
    geo.haversine(origin, req.dest) <= 80000
  const point = useOrigin
    ? { lng: Number(origin.lng), lat: Number(origin.lat) }
    : { lng: req.dest.lng, lat: req.dest.lat }
  return {
    id: 'hotel',
    name: useOrigin ? `${origin.name || '出发地'}（出发地）` : req.hotelName || '城市中心参考点',
    ...point
  }
}

/** 用户填写出发点且距目的地超过 80 公里时，需补一段「出发地 → 目的地城市」的车程 */
function intercityTrip(req) {
  const origin = req.origin
  if (!req.originProvided || !origin || !Number(origin.lng) || !Number(origin.lat)) return null
  if (geo.haversine(origin, req.dest) <= 80000) return null
  return {
    from: {
      id: 'origin',
      name: origin.name || '出发地',
      lng: Number(origin.lng),
      lat: Number(origin.lat)
    },
    to: hotelPoint(req),
    distance: geo.haversine(origin, req.dest)
  }
}

/** 交通方式分流参数，必须与 decision.chooseMode 保持一致 */
function legOptions(req) {
  return { transportPref: req.transport, party: req.party, hasElder: req.hasElder }
}

function matrixMode(from, to, req) {
  return decision.chooseMode(geo.haversine(from, to), legOptions(req))
}

/** 真实路线优先：公交有实际票价时按票价，其余按里程/计价规则 */
function fareOf(leg, mode, req) {
  if (mode === 'transit' && Number(leg.costEstimate) > 0) {
    return Math.round(Number(leg.costEstimate) * Math.max(1, req.party))
  }
  return decision.legCost(mode, leg.distance, req.party)
}

/**
 * 构建每日通勤矩阵
 * 单元：{ minutes, cost, mode, estimated }
 * - 有真实路线缓存时用真实耗时/距离；缺失才回退直线估算，并标记 estimated
 * - mode 由 chooseMode 决定，保证矩阵目标与时间轴一致
 */
function buildMatrix(points, req, legCache) {
  const cache = legCache || {}
  return points.map((a) =>
    points.map((b) => {
      if (a === b) return { minutes: 0, cost: 0, mode: 'walk', estimated: true }
      const mode = matrixMode(a, b, req)
      const hit = cache[legKey(a, b, mode)]
      const leg = hit || geo.estimateLeg(a, b, mode)
      return {
        minutes: Math.max(0, Number(leg.minutes) || 0),
        cost: fareOf(leg, mode, req),
        mode,
        estimated: !hit || !!hit.estimated
      }
    })
  )
}

/** 目标函数：省钱方案用交通费用，其余（省时 / 自驾）用真实耗时 */
function matrixKind(variantKey, req) {
  if (req.transport === 'drive') return 'time'
  return variantKey === 'budget' ? 'money' : 'time'
}

function tourCost(ordered, points, matrix, kind) {
  const indexes = ordered.map((point) => points.indexOf(point))
  let sum = 0
  for (let i = 0; i < indexes.length - 1; i++) {
    const cell = matrix[indexes[i]][indexes[i + 1]]
    sum += kind === 'money' ? cell.cost : cell.minutes
  }
  return sum
}

/** 用同一份矩阵重排一天的点位（多起点最近邻 + 带开放时间窗的 2-opt） */
function orderDay(points, req, legCache, variantKey) {
  const matrix = buildMatrix(points, req, legCache)
  const ordered = decision.optimizeOrder(points, matrix, {
    kind: matrixKind(variantKey, req),
    startMinutes: dateUtil.clockToMinutes(req.dayStart),
    deadline: dateUtil.clockToMinutes(req.dayEnd)
  })
  return {
    matrix,
    ordered,
    naiveMinutes: tourCost(points, points, matrix, 'time'),
    optimizedMinutes: tourCost(ordered, points, matrix, 'time')
  }
}

function legKey(from, to, mode) {
  return `${from.id || from.name}|${to.id || to.name}|${mode}`
}

function buildDraft(variantKey, pois, req, weatherList) {
  const variant = decision.VARIANTS[variantKey]
  const pace = decision.PACES[req.pace] || decision.PACES.normal
  const avgRain = weatherList.length ? mean(weatherList.map((item) => item.rainProb)) : 30
  const weatherByDate = {}
  weatherList.forEach((item) => {
    weatherByDate[item.date] = { rainProb: item.rainProb }
  })

  const scored = pois.map((poi) =>
    decision.scorePoi(poi, {
      prefKeys: req.prefs,
      focusNames: req.preferredSpots,
      weights: variant.weights,
      budgetPerDay: req.budget.perDay,
      rainProb: avgRain,
      pace: req.pace,
      center: { lng: req.dest.lng, lat: req.dest.lat },
      party: req.party,
      hasElder: req.hasElder
    })
  )
  scored.sort((a, b) => b.score - a.score)

  const capacity = Math.max(2, pace.capacity + (variantKey === 'time' ? -1 : 0))
  const days = dateUtil.dateList(req.startDate, req.days)
  const states = decision.assignDays(scored, {
    days: days.map((date) => ({ date })),
    center: { lng: req.dest.lng, lat: req.dest.lat },
    variantKey,
    capacity,
    weatherByDate
  })

  const scoreById = {}
  scored.forEach((item) => {
    scoreById[item.poi.id] = item
  })

  const hotel = hotelPoint(req)
  let naiveMinutes = 0
  let optimizedMinutes = 0

  const dayPlans = states.map((state) => {
    const points = [hotel].concat(state.items.map((item) => item.poi))
    const result = orderDay(points, req, null, variantKey)
    naiveMinutes += result.naiveMinutes
    optimizedMinutes += result.optimizedMinutes
    return {
      date: state.date,
      rainProb: state.rainProb,
      ordered: result.ordered.slice(1)
    }
  })

  return {
    variantKey,
    name: variant.name,
    tagline: variant.tagline,
    days: dayPlans,
    scoreById,
    candidateCount: pois.length,
    savedMinutes: Math.max(0, Math.round(naiveMinutes - optimizedMinutes))
  }
}

function formatItem(item) {
  const base = { ...item }
  if (item.type === 'transit') {
    base.mode = item.modeText
    base.modeLabel = format.modeText(item.modeText)
    base.badge = format.modeBadge(item.modeText)
    base.modeText = base.modeLabel
    base.distanceText = format.distance(item.distance)
    base.durationText = format.duration(item.minutes)
    base.costText = item.cost ? format.money(item.cost) : ''
    base.subtitle = `${base.modeLabel} · ${base.distanceText} · 约 ${base.durationText}${item.cost ? ` · ${base.costText}` : ''}`
  }
  if (item.type === 'poi') {
    const costKnown = item.unitCost !== null && item.unitCost !== undefined
    const hasRating = Number(item.rating) > 0
    base.costText = !costKnown ? '票价未公开' : item.unitCost ? `${format.money(item.unitCost)}/人` : '免费'
    base.ratingText = hasRating ? Number(item.rating).toFixed(1) : '暂无评分'
    base.metaText = hasRating ? `${base.ratingText} · ${base.costText}` : base.costText
    base.unitCost = costKnown ? item.unitCost : null
  }
  if (item.type === 'meal') {
    base.costText = format.money(item.cost)
  }
  return base
}

function composePlan(draft, req, weatherList, legCache, options) {
  const hotel = hotelPoint(req)
  const isRefined = !!(options && options.refined)
  let refinedLegs = 0
  let estimatedLegs = 0
  const trip = intercityTrip(req)
  const departAt = dateUtil.clockToMinutes(req.dayStart)
  let intercity = null

  const dayPlans = draft.days.map((day, index) => {
    const weather = weatherList.find((item) => item.date === day.date)
    const safeWeather = weather || {
      date: day.date,
      weekday: dateUtil.weekdayCN(day.date),
      dayWeather: '暂无预报',
      nightWeather: '',
      dayTemp: null,
      nightTemp: null,
      rainProb: null,
      source: 'none',
      outOfRange: true
    }

    const clothing = weatherService.clothingAdvice(safeWeather)
    const activity = weatherService.activityAdvice(safeWeather)

    const resolveLeg = (from, to, mode) => {
      const cache = legCache || {}
      const hit = cache[legKey(from, to, mode)]
      if (hit) {
        if (hit.estimated) estimatedLegs++
        else refinedLegs++
        return hit
      }
      estimatedLegs++
      return geo.estimateLeg(from, to, mode)
    }

    // 第 1 天先补「出发地 → 目的地城市」的车程，日程从抵达时刻开始
    const interLeg = trip && index === 0 ? resolveLeg(trip.from, trip.to, 'drive') : null
    const tripItem = interLeg
      ? {
          type: 'transit',
          fromName: trip.from.name,
          toName: trip.to.name,
          modeText: 'drive',
          timeText: dateUtil.minutesToClock(departAt),
          endText: dateUtil.minutesToClock(departAt + interLeg.minutes),
          minutes: interLeg.minutes,
          distance: interLeg.distance,
          cost: Math.round(Number(interLeg.costEstimate) || 0),
          points: interLeg.points || null,
          estimated: !!interLeg.estimated,
          title: `${trip.from.name} → ${trip.to.name}`,
          icon: '车'
        }
      : null
    if (index === 0 && interLeg) {
      intercity = {
        fromName: trip.from.name,
        toName: trip.to.name,
        minutes: interLeg.minutes,
        distance: interLeg.distance,
        cost: Math.round(Number(interLeg.costEstimate) || 0),
        estimated: !!interLeg.estimated
      }
    }
    const startClock = interLeg ? dateUtil.minutesToClock(departAt + interLeg.minutes) : req.dayStart

    const scheduled = decision.scheduleDay({
      ordered: day.ordered,
      hotel,
      rainProb: safeWeather.rainProb,
      weatherText: safeWeather.dayWeather,
      party: req.party,
      lunchPrice: req.budget.mealLunch,
      dinnerPrice: req.budget.mealDinner,
      startClock,
      endClock: req.dayEnd,
      transport: {
        transportPref: req.transport,
        party: req.party,
        hasElder: req.hasElder
      },
      resolveLeg
    })

    const rawItems = tripItem ? [tripItem].concat(scheduled.items) : scheduled.items
    const items = rawItems.map(formatItem)
    const stats = decision.summarizeItems(rawItems, req.party)

    return {
      index,
      date: day.date,
      weekday: dateUtil.weekdayCN(day.date),
      dateLabel: `${dateUtil.parseDate(day.date).getMonth() + 1}月${dateUtil.parseDate(day.date).getDate()}日`,
      weather: safeWeather,
      weatherText: safeWeather.dayWeather,
      tempText:
        Number.isFinite(Number(safeWeather.dayTemp)) && Number.isFinite(Number(safeWeather.nightTemp))
          ? `${safeWeather.nightTemp}~${safeWeather.dayTemp}℃`
          : '温度暂无',
      rainText: Number.isFinite(Number(safeWeather.rainProb))
        ? `降水 ${Math.round(safeWeather.rainProb)}%`
        : '降水概率暂无',
      rainProb: safeWeather.rainProb,
      clothing,
      activity,
      items,
      stats,
      statsText: {
        travel: format.duration(stats.travelMinutes),
        distance: format.distance(stats.travelDistance),
        cost: format.money(stats.cost)
      },
      dropped: scheduled.dropped,
      endText: scheduled.endText
    }
  })

  const totals = dayPlans.reduce(
    (acc, day) => {
      acc.travelMinutes += day.stats.travelMinutes
      acc.travelDistance += day.stats.travelDistance
      acc.transportCost += day.stats.transportCost
      acc.ticketCost += day.stats.ticketCost
      acc.mealCost += day.stats.mealCost
      acc.poiCount += day.stats.poiCount
      acc.unknownTicketCount += day.stats.unknownTicketCount || 0
      return acc
    },
    { travelMinutes: 0, travelDistance: 0, transportCost: 0, ticketCost: 0, mealCost: 0, poiCount: 0, unknownTicketCount: 0 }
  )
  const totalCost = totals.transportCost + totals.ticketCost + totals.mealCost
  const perPersonCost = Math.round(totalCost / Math.max(1, req.party))

  const selected = []
  dayPlans.forEach((day) => {
    day.items.forEach((item) => {
      if (item.type === 'poi' && draft.scoreById[item.poiId]) {
        selected.push({ item, scoreItem: draft.scoreById[item.poiId], dayIndex: day.index })
      }
    })
  })

  const avgPoiScore = selected.length ? mean(selected.map((s) => s.scoreItem.score)) : 0
  const matchedLabels = {}
  selected.forEach((s) => {
    s.scoreItem.matchedPrefs.forEach((label) => {
      matchedLabels[label] = 1
    })
  })
  const coverage = req.prefs.length
    ? Math.min(1, Object.keys(matchedLabels).length / req.prefs.length)
    : 0.55
  const timeEff = decision.clamp(1 - totals.travelMinutes / (req.days * 320), 0, 1)
  const budgetTarget = req.budget.perDay * req.days
  const budgetFit = perPersonCost <= budgetTarget
    ? 1
    : decision.clamp(1 - (perPersonCost - budgetTarget) / (budgetTarget * 0.9), 0, 1)

  let rainyOutdoor = 0
  dayPlans.forEach((day) => {
    if (day.rainProb >= 55) {
      day.items.forEach((item) => {
        if (item.type === 'poi' && item.outdoor) rainyOutdoor++
      })
    }
  })
  const weatherFit = selected.length
    ? decision.clamp(1 - rainyOutdoor / selected.length, 0.2, 1)
    : 0.6

  const finalWeights = FINAL_WEIGHTS[draft.variantKey] || FINAL_WEIGHTS.balanced
  const score = Math.round(
    100 *
      decision.clamp(
        avgPoiScore * finalWeights.quality +
          timeEff * finalWeights.time +
          budgetFit * finalWeights.budget +
          weatherFit * finalWeights.weather +
          coverage * finalWeights.coverage,
        0,
        1
      )
  )
  const grade = format.grade(score)

  const prefLabels = req.prefs
    .map((key) => (decision.PREF_TAGS[key] ? decision.PREF_TAGS[key].label : ''))
    .filter(Boolean)

  const transportLabel = {
    mixed: '省时优先',
    transit: '公交优先',
    taxi: '打车优先',
    drive: '自驾'
  }[req.transport] || '省时优先'

  const weatherSource = weatherList[0] ? weatherList[0].source : 'unknown'
  const weatherFetchedAt = weatherList[0] ? weatherList[0].fetchedAt : 0
  const poiFetchedAt = selected[0] ? selected[0].scoreItem.poi.fetchedAt : 0

  const decisions = [
    intercity
      ? {
          level: 'info',
          title: '含出发地到城市的车程',
          text: `第 1 天按 ${req.dayStart} 从${intercity.fromName}出发，单程约 ${format.duration(intercity.minutes)}、${format.distance(
            intercity.distance
          )}${intercity.estimated ? '（估算）' : ''}，抵达后开始游览；返程未计入本方案。`
        }
      : null,
    {
      title: '选点：兴趣 × 口碑 × 预算',
      text: `从 ${draft.candidateCount} 个候选点位中选出 ${selected.length} 个：偏好「${prefLabels.join('、') || '热门景点'}」，并按评分、热度、门票与游玩时长加权排序。`
    },
    req.preferredSpots.length
      ? {
          title: '优先安排已选景点',
          text: `已把你在规划页勾选的 ${req.preferredSpots.length} 个景点（${req.preferredSpots.slice(0, 4).join('、')}${req.preferredSpots.length > 4 ? ' 等' : ''}）加入优先候选，并在打分中加权；若天气或时间冲突仍可能调整日期。`
        }
      : null,
    req.excludedSpots.length
      ? {
          title: '已按你的选择排除景点',
          text: `本次不安排：${req.excludedSpots.slice(0, 6).join('、')}${req.excludedSpots.length > 6 ? ' 等' : ''}。取消勾选可随时重新规划。`
        }
      : null,
    {
      title: '动线：就近成团 + 2-opt 优化',
      text: `按地理位置分到 ${req.days} 天，逐日优化访问顺序，预计比初始顺序减少约 ${draft.savedMinutes} 分钟通勤。已按「${transportLabel}」选择步行/公交/打车。`
    },
    {
      title: '天气：逐日适配',
      text: rainyOutdoor > 0
        ? `有 ${rainyOutdoor} 个户外点位落在降雨概率较高的日期，已尽量把室内点位前置；出行前请复核实时预报。`
        : '行程期内降水概率较低，户外与室内点位搭配合理。'
    },
    {
      title: '预算：按你的预算范围估算',
      text: `人均约 ${format.money(perPersonCost)}（预算 ${req.budgetLabel}，取区间中值折算），其中门票 ${format.money(totals.ticketCost)}、交通 ${format.money(totals.transportCost)}、餐饮 ${format.money(totals.mealCost)}。${
        totals.unknownTicketCount
          ? `另有 ${totals.unknownTicketCount} 个点位接口未返回票价，未计入门票，请以景区公告为准。`
          : '门票均来自地图服务返回的真实票价字段。'
      }`
    },
    {
      title: '时效：数据分层缓存',
      text: `POI 缓存 ${dateUtil.relativeTime(poiFetchedAt)}，天气 ${dateUtil.relativeTime(weatherFetchedAt)}，路线按实时路况校正 ${refinedLegs} 段、估算 ${estimatedLegs} 段。`
    }
  ].filter(Boolean)

  const risks = []
  const needBooking = selected.filter(
    (s) => /博物馆|故宫|遗址|乐园|迪士尼/.test(`${s.item.name}${(s.item.tags || []).join('')}`)
  )
  if (needBooking.length) {
    risks.push({
      level: 'high',
      title: '需提前预约/限流',
      text: `${needBooking.map((s) => s.item.name).slice(0, 4).join('、')} 等点位通常需实名预约或限流，请以官方渠道为准。`
    })
  }
  const mondayMuseums = selected.filter(
    (s) => /博物馆|美术馆|纪念馆/.test(s.item.name) && dateUtil.weekdayCN(dayPlans[s.dayIndex].date) === '周一'
  )
  if (mondayMuseums.length) {
    risks.push({
      level: 'high',
      title: '周一闭馆风险',
      text: `${mondayMuseums.map((s) => s.item.name).join('、')} 常设展周一闭馆，建议调整到其他日期。`
    })
  }
  const rainDays = dayPlans.filter((day) => day.rainProb >= 55)
  if (rainDays.length) {
    risks.push({
      level: 'medium',
      title: '降雨提醒',
      text: `${rainDays.map((day) => day.dateLabel).join('、')} 降水概率较高，户外点位请备雨具并预留弹性时间。`
    })
  }
  dayPlans.forEach((day) => {
    if (day.dropped && day.dropped.length) {
      risks.push({
        level: 'medium',
        title: `${day.dateLabel} 有 ${day.dropped.length} 个点位未排入`,
        text: `因时间不足未安排：${day.dropped.join('、')}，可减少点位或拆分到其他日期。`
      })
    }
  })
  if (options && options.hasOutOfRange) {
    risks.push({
      level: 'low',
      title: '部分日期无实时预报',
      text: '超出预报能力的日期标注为「暂无预报」，未做任何气候代填与穿衣推测，请出行前复核最新天气。'
    })
  }
  if (intercity && departAt + intercity.minutes > dateUtil.clockToMinutes(req.dayEnd)) {
    risks.push({
      level: 'medium',
      title: '首日抵达时间偏晚',
      text: `出发地到城市约需 ${format.duration(intercity.minutes)}，抵达后已接近当天结束时间，建议提前出发或把首日改为交通日。`
    })
  }
  risks.push({
    level: 'low',
    title: '以官方公告为准',
    text: '开放时间、门票与预约政策可能随季节/节假日调整；本方案基于公开数据与缓存推算，请出行前复核。'
  })

  const hotelSelectedNames = selected.map((s) => s.item.name)
  const guideRefs = guideService.forPlan(req.dest.name || req.destName, hotelSelectedNames, 4)

  const pois = selected.map((s) => ({
    ...s.scoreItem.poi,
    score: Math.round(s.scoreItem.score * 100),
    scoreParts: s.scoreItem.parts,
    reasons: s.scoreItem.reasons,
    dayIndex: s.dayIndex,
    dayDate: dayPlans[s.dayIndex].date
  }))

  return {
    id: `plan_${draft.variantKey}_${Date.now()}`,
    variant: draft.variantKey,
    name: draft.name,
    tagline: draft.tagline,
    score,
    scoreGrade: grade.text,
    scoreCls: grade.cls,
    hotel,
    dest: {
      name: req.dest.name || req.destName,
      adcode: req.dest.adcode || '',
      lng: req.dest.lng,
      lat: req.dest.lat
    },
    days: dayPlans,
    pois,
    guides: guideRefs,
    decisions,
    risks,
    metrics: {
      days: req.days,
      poiCount: totals.poiCount,
      travelMinutes: totals.travelMinutes,
      travelText: format.duration(totals.travelMinutes),
      distanceText: format.distance(totals.travelDistance),
      ticketCost: totals.ticketCost,
      transportCost: totals.transportCost,
      mealCost: totals.mealCost,
      totalCost,
      totalCostText: format.money(totalCost),
      perPersonCost,
      perPersonText: format.money(perPersonCost),
      totalBudgetText: format.money(req.budget.perDay * req.days * req.party),
      refinedLegs,
      estimatedLegs,
      savedMinutes: draft.savedMinutes,
      coverageText: `${Math.round(coverage * 100)}%`
    },
    meta: {
      refined: isRefined,
      source: storage.getSettings().dataSource,
      weatherSource,
      weatherFetchedAt,
      poiFetchedAt,
      routeFetchedAt: Date.now(),
      hasOutOfRange: !!(options && options.hasOutOfRange),
      dataNote: weatherServiceNote(weatherSource)
    }
  }
}

function weatherServiceNote(source) {
  if (source === 'none') return '暂无实时预报'
  if (source === 'qweather') return '和风天气 · 7 天预报'
  if (source === 'baidu') return '百度天气'
  return '高德天气 · 4 天预报'
}

/**
 * 批量拉取真实通勤数据，生成每日通勤矩阵
 * 顺序：出发地→城市 → 当前顺序相邻段 → 其余候选点对（近的优先）
 * 受云函数限流（每个 action 20 次/分钟）约束，单 action 最多 18 次，失败自动回退估算
 */
async function buildRouteMatrix(draft, req, onProgress) {
  const legCache = {}
  const tasks = []
  const seen = {}
  const actionCount = {}
  const MAX_PER_ACTION = 18
  const hotel = hotelPoint(req)

  const pushTask = (from, to) => {
    const mode = matrixMode(from, to, req)
    const key = legKey(from, to, mode)
    if (seen[key]) return
    const action = mode === 'walk' ? 'routeWalking' : mode === 'transit' ? 'routeTransit' : 'routeDriving'
    if ((actionCount[action] || 0) >= MAX_PER_ACTION) return
    actionCount[action] = (actionCount[action] || 0) + 1
    seen[key] = true
    tasks.push({
      key,
      run: () =>
        mapService.routePlan({
          from,
          to,
          mode,
          city: req.dest.name,
          cityd: req.dest.adcode,
          force: req.force
        })
    })
  }

  // 长途出发地：优先把首日车程也按实时路线校正
  const trip = intercityTrip(req)
  if (trip) {
    const key = legKey(trip.from, trip.to, 'drive')
    seen[key] = true
    actionCount.routeDriving = (actionCount.routeDriving || 0) + 1
    tasks.push({
      key,
      run: () =>
        mapService.routePlan({
          from: trip.from,
          to: trip.to,
          mode: 'drive',
          city: req.dest.name,
          cityd: req.dest.adcode,
          force: req.force
        })
    })
  }

  // 当前顺序的相邻段优先，保证时间轴展示的每一段都是真实路线
  draft.days.forEach((day) => {
    const points = [hotel].concat(day.ordered)
    for (let i = 0; i < points.length - 1; i++) pushTask(points[i], points[i + 1])
  })

  // 其余点对用于 2-opt 换序评估，按直线距离从近到远补足
  const pairs = []
  draft.days.forEach((day) => {
    const points = [hotel].concat(day.ordered)
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        pairs.push({ from: points[i], to: points[j], km: geo.haversine(points[i], points[j]) / 1000 })
      }
    }
  })
  pairs.sort((a, b) => a.km - b.km)
  pairs.forEach((pair) => pushTask(pair.from, pair.to))

  const limited = tasks.slice(0, config.limits.maxRefineLegs)
  const results = await require('./api').runParallel(
    limited.map((task) => task.run),
    4
  )

  results.forEach((result, index) => {
    if (result.ok && result.value) legCache[limited[index].key] = result.value
  })

  if (onProgress) onProgress({ text: `已获取 ${Object.keys(legCache).length} 段真实通勤数据` })
  return legCache
}

/** 真实矩阵到手后按用户偏好重排顺序，并更新节省的分钟数 */
function reoptimizeDraft(draft, req, legCache) {
  const hotel = hotelPoint(req)
  let naiveMinutes = 0
  let optimizedMinutes = 0

  draft.days.forEach((day) => {
    const points = [hotel].concat(day.ordered)
    const result = orderDay(points, req, legCache, draft.variantKey)
    naiveMinutes += result.naiveMinutes
    optimizedMinutes += result.optimizedMinutes
    day.ordered = result.ordered.slice(1)
  })

  draft.savedMinutes = Math.max(0, Math.round(naiveMinutes - optimizedMinutes))
}

/** 从最佳方案的已排入点位中提取锚点输入（按游玩时长加权） */
function stayPoints(plan) {
  const seen = {}
  const points = []
  ;(plan && plan.days ? plan.days : []).forEach((day) => {
    ;(day.items || []).forEach((item) => {
      if (item.type !== 'poi') return
      const lng = Number(item.lng)
      const lat = Number(item.lat)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
      const key = item.poiId || item.name
      if (seen[key]) return
      seen[key] = true
      points.push({ lng, lat, duration: Number(item.minutes) || 120 })
    })
  })
  return points
}

async function generate(rawRequest, onProgress) {
  const report = (payload) => {
    if (typeof onProgress === 'function') onProgress(payload)
  }
  const req = normalizeRequest(rawRequest)

  report({ step: 0, percent: 8, text: '解析目的地与坐标' })
  const destResult = await resolveDestination(req)
  req.dest = destResult
  const center = { lng: destResult.lng, lat: destResult.lat }

  report({ step: 1, percent: 24, text: '检索目的地景点与热度数据' })
  const allPois = await mapService.searchPoi({
    cityName: destResult.name || req.destName,
    adcode: destResult.adcode,
    center,
    prefs: req.prefs,
    focusKeywords: req.preferredSpots,
    limit: config.limits.maxPoiCandidates,
    force: req.force
  })
  // 候选池保留被排除的景点，便于方案页取消排除后重新加回
  const hotSpots = cleanSpots(allPois).slice(0, 16)
  const pois = allPois.filter((poi) => !isExcluded(poi.name, req.excludedSpots))
  if (!pois.length) {
    throw new Error('你排除的景点过多，已没有可安排的候选点位，请至少保留一个后重试')
  }

  report({ step: 2, percent: 42, text: '获取逐日天气与穿衣建议' })
  const forecast = await weatherService.getForecast({
    cityName: destResult.name || req.destName,
    adcode: destResult.adcode,
    lat: destResult.lat,
    lng: destResult.lng,
    startDate: req.startDate,
    days: req.days,
    force: req.force
  })

  report({ step: 3, percent: 56, text: '多因子打分 · 按天聚类分组' })
  const variants = ['balanced', 'time', 'budget']
  const drafts = variants.map((key) => buildDraft(key, pois, req, forecast.list))
  await sleep(40)

  report({ step: 4, percent: 72, text: '多起点最近邻 + 2-opt 动线优化' })
  const prelimPlans = drafts.map((draft) =>
    composePlan(draft, req, forecast.list, {}, {
      refined: false,
      hasOutOfRange: forecast.meta.outOfRangeCount > 0
    })
  )
  let bestIndex = 0
  prelimPlans.forEach((plan, index) => {
    if (plan.score > prelimPlans[bestIndex].score) bestIndex = index
  })

  report({ step: 5, percent: 80, text: '批量拉取真实通勤耗时，重建通勤矩阵' })
  const legCache = await buildRouteMatrix(drafts[bestIndex], req, (payload) =>
    report({ step: 5, percent: 84, text: payload.text })
  )
  reoptimizeDraft(drafts[bestIndex], req, legCache)

  const plans = drafts.map((draft, index) =>
    composePlan(draft, req, forecast.list, index === bestIndex ? legCache : {}, {
      refined: index === bestIndex,
      hasOutOfRange: forecast.meta.outOfRangeCount > 0
    })
  )
  plans.sort((a, b) => b.score - a.score)
  plans.forEach((plan, index) => {
    plan.rank = index + 1
  })

  report({ step: 6, percent: 90, text: '检索住宿并求解通勤锚点' })
  const bestPlan = plans[0]
  const stayPois = stayPoints(bestPlan)
  try {
    const stayResult = await hotelService.recommend({
      cityName: destResult.name || req.destName,
      adcode: destResult.adcode,
      center,
      pois: stayPois,
      budgetMin: req.stayMin,
      budgetMax: req.stayMax,
      type: req.stayType,
      transport: req.transport,
      party: req.party,
      hasElder: req.hasElder,
      limit: 3,
      force: req.force
    })
    if (stayResult.stays.length) {
      // 三套方案共用同一批住宿，切方案时不跳变；锚点来自 score 最高的方案
      plans.forEach((plan) => {
        plan.stays = stayResult.stays
        plan.stayAnchor = stayResult.anchor
        plan.stayAnchorText = stayResult.anchorText
        plan.stayBudgetText = req.stayBudgetLabel
        plan.decisions.push({
          title: '住宿：以通勤锚点择址',
          text: `基于综合评分最高方案的 ${stayPois.length} 个点位按游玩时长加权，求得使总通勤最小的几何中位数锚点；三套方案共用同一批住宿，在「${hotelService.typeLabel(
            req.stayType
          )}」偏好、每晚 ${req.stayMin}–${req.stayMax} 元预算内推荐 ${stayResult.stays.length} 处。价格取自地图平台参考价，房型与实时房价以预订平台为准。`
        })
        plan.risks.push({
          level: 'low',
          title: '住宿参考价与可预订性',
          text: '住宿点位与参考价来自地图服务，可能包含已停业或房态紧张的门店；旺季民宿/青旅价格浮动较大，请以预订平台实时价格与房源资质为准。'
        })
        plan.meta.stayFetchedAt = stayResult.meta.fetchedAt
        plan.meta.stayProvider = stayResult.meta.provider
        plan.meta.stayCandidateCount = stayResult.meta.candidateCount
      })
    }
  } catch (err) {
    // 住宿只是增强信息，检索失败不阻断主行程
    console.warn('[plan] 住宿推荐失败', err && err.message)
  }

  report({ step: 7, percent: 94, text: '整理决策依据与风险提示' })
  await sleep(30)

  const groupId = `trip_${Date.now()}`
  const poiIndex = {}
  pois.forEach((poi) => {
    poiIndex[poi.id] = poi
  })
  plans.forEach((plan) => {
    plan.groupId = groupId
    plan.request = {
      destName: req.destName,
      startDate: req.startDate,
      endDate: req.endDate,
      days: req.days,
      dayStart: req.dayStart,
      dayEnd: req.dayEnd,
      party: req.party,
      prefs: req.prefs,
      pace: req.pace,
      budgetLabel: req.budgetLabel,
      budgetMin: req.budgetMin,
      budgetMax: req.budgetMax,
      transport: req.transport
    }
  })

  storage.setPoiIndex(poiIndex)

  // 方案页模板需要 rank 与 request（合计人数等），统一补齐
  plans.forEach((plan, index) => {
    plan.rank = index + 1
    plan.request = req
    plan.party = req.party
  })

  const bundle = {
    groupId,
    createdAt: Date.now(),
    request: req,
    dest: destResult,
    forecastMeta: forecast.meta,
    hotSpots,
    plans,
    activeIndex: 0
  }
  storage.saveBundle(bundle)

  const best = plans[0]
  storage.addHistory({
    id: groupId,
    createdAt: Date.now(),
    destName: destResult.name || req.destName,
    startDate: req.startDate,
    endDate: req.endDate,
    days: req.days,
    party: req.party,
    score: best.score,
    scoreText: `${best.name} · ${best.score} 分`,
    totalCostText: best.metrics.totalCostText,
    plan: slimPlan(best)
  })

  return bundle
}

function slimPlan(plan) {
  const copy = JSON.parse(JSON.stringify(plan))
  copy.days.forEach((day) => {
    day.items.forEach((item) => {
      if (item.points) delete item.points
    })
  })
  return copy
}

module.exports = {
  generate,
  normalizeRequest,
  slimPlan,
  hotelPoint
}
