/**
 * 行程决策引擎（纯函数，便于单测与复用到云函数侧思路）
 *
 * 决策链路：
 *   1) 兴趣/口碑/花费/天气/通勤多因子打分
 *   2) 按天做“插入式聚类”分组，控制每日容量与雨天室内偏好
 *   3) 每日内部用 最近邻 + 2-opt 求短行程顺序（点数 ≤ 6，精确度足够）
 *   4) 按节奏/用餐/闭园时间生成时间轴，超时点位自动剔除
 */
const { haversine, centroid, estimateLeg } = require('./geo')

const PACES = {
  relaxed: { key: 'relaxed', label: '悠闲', capacity: 3, idealDuration: 100, start: 9 * 60 + 30 },
  normal: { key: 'normal', label: '适中', capacity: 4, idealDuration: 140, start: 9 * 60 },
  packed: { key: 'packed', label: '紧凑', capacity: 5, idealDuration: 170, start: 8 * 60 + 30 }
}

const PREF_TAGS = {
  nature: { label: '自然风光', keys: ['自然', '户外', '公园', '山水', '海岛', '湿地', '风景', '湖', '山'] },
  culture: { label: '历史人文', keys: ['人文', '历史', '博物馆', '古建', '寺庙', '文化', '遗址', '艺术'] },
  food: { label: '美食探店', keys: ['美食', '小吃', '夜市', '餐厅', '市集'] },
  family: { label: '亲子友好', keys: ['亲子', '乐园', '动物', '科技', '海洋'] },
  shopping: { label: '购物逛街', keys: ['购物', '商圈', '百货', '市集'] },
  night: { label: '夜景夜生活', keys: ['夜生活', '夜景', '酒吧', '演出', '灯光'] },
  photo: { label: '拍照出片', keys: ['摄影', '出片', '观景', '日落', '打卡'] },
  show: { label: '演出体验', keys: ['演出', '非遗', '体验', '剧场'] }
}

const VARIANTS = {
  balanced: {
    key: 'balanced',
    name: '均衡精选',
    tagline: '体验、时间、花费三者平衡',
    weights: { interest: 0.3, quality: 0.2, popularity: 0.13, cost: 0.12, weather: 0.13, duration: 0.06, proximity: 0.16 }
  },
  time: {
    key: 'time',
    name: '省时高效',
    tagline: '压缩通勤，留给景点更多时间',
    weights: { interest: 0.24, quality: 0.16, popularity: 0.1, cost: 0.04, weather: 0.12, duration: 0.04, proximity: 0.34 }
  },
  budget: {
    key: 'budget',
    name: '省钱轻旅行',
    tagline: '优先免费/低价点位，公共交通为主',
    weights: { interest: 0.26, quality: 0.14, popularity: 0.1, cost: 0.32, weather: 0.1, duration: 0.04, proximity: 0.14 }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function haystack(poi) {
  return `${poi.name || ''} ${poi.category || ''} ${(poi.tags || []).join(' ')} ${poi.type || ''}`
}

/** 名称归一化：仅用于同名匹配，去掉空白并统一大小写 */
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

function matchFocus(poi, focusNames) {
  const key = normalizeName(poi && poi.name)
  if (!key || !focusNames || !focusNames.length) return false
  return focusNames.some((name) => normalizeName(name) === key)
}

function matchPrefs(poi, prefKeys) {
  const text = haystack(poi)
  const labels = []
  ;(prefKeys || []).forEach((key) => {
    const conf = PREF_TAGS[key]
    if (!conf) return
    if (conf.keys.some((k) => text.indexOf(k) >= 0)) labels.push(conf.label)
  })
  return labels
}

function popularityScore(reviews) {
  return clamp(Math.log10((Number(reviews) || 0) + 1) / 5.4, 0, 1)
}

function moneyText(value) {
  return `¥${Math.round(Number(value) || 0)}`
}

/**
 * 单个 POI 综合打分
 * @param {Object} poi 标准化 POI
 * @param {Object} ctx { prefKeys, weights, budgetPerDay, rainProb, pace, center, party, hasElder }
 */
function scorePoi(poi, ctx) {
  const weights = ctx.weights
  const pace = PACES[ctx.pace] || PACES.normal
  const matched = matchPrefs(poi, ctx.prefKeys)
  const prefCount = (ctx.prefKeys || []).length
  const focusMatch = matchFocus(poi, ctx.focusNames)

  let interest = prefCount
    ? matched.length
      ? clamp(0.55 + 0.45 * (matched.length / prefCount), 0, 1)
      : 0.1
    : 0.55
  // 规划页勾选的景点是用户的明确意愿：在兴趣分上加权，但不越过评分与预算
  if (focusMatch) interest = clamp(0.72 + 0.28 * interest, 0, 1)

  // 无评分时不臆造分数，按中性值参与排序
  const hasRating = Number.isFinite(Number(poi.rating)) && Number(poi.rating) > 0
  const quality = hasRating ? clamp((Number(poi.rating) - 3.7) / 1.3, 0, 1) : 0.5
  const popularity = popularityScore(poi.reviews)

  const cost = Number(poi.cost) || 0
  const costKnown = poi.cost !== null && poi.cost !== undefined && Number.isFinite(Number(poi.cost))
  const dayBudget = Math.max(120, Number(ctx.budgetPerDay) || 400)
  // 票价缺失时按中性值参与排序，避免「未知」被当成免费而占优
  let costFit = 0.6
  if (costKnown) {
    costFit = 1
    if (cost > 0) {
      costFit = cost <= dayBudget * 0.25 ? 1 : clamp(1 - (cost - dayBudget * 0.25) / (dayBudget * 0.95), 0, 1)
    }
  }

  const rainProb = Number(ctx.rainProb) || 0
  let weatherFit
  if (poi.outdoor) {
    weatherFit = rainProb >= 65 ? 0.32 : rainProb >= 40 ? 0.62 : rainProb >= 20 ? 0.82 : 0.96
  } else {
    weatherFit = rainProb >= 60 ? 0.94 : rainProb >= 30 ? 0.82 : 0.74
  }

  const duration = Number(poi.duration) || 120
  const durationFit = clamp(1 - Math.abs(duration - pace.idealDuration) / (pace.idealDuration * 1.35), 0, 1)

  const kmFromCenter = haversine(ctx.center, poi) / 1000
  const proximity = clamp(1 - kmFromCenter / 28, 0, 1)

  const score =
    interest * weights.interest +
    quality * weights.quality +
    popularity * weights.popularity +
    costFit * weights.cost +
    weatherFit * weights.weather +
    durationFit * weights.duration +
    proximity * weights.proximity

  const reasons = []
  if (focusMatch) reasons.push('已选景点，按你的选择优先')
  if (matched.length) reasons.push(`偏好命中：${matched.slice(0, 2).join('、')}`)
  if (hasRating && quality >= 0.78) reasons.push(`评分 ${Number(poi.rating).toFixed(1)}，口碑稳定`)
  if (popularity >= 0.78) reasons.push(`热度高，${Math.round((poi.reviews || 0) / 1000)}k+ 条评价`)
  if (!costKnown) reasons.push('票价未公开，以景区公告为准')
  else if (cost === 0) reasons.push('免费开放，预算友好')
  else if (weights.cost >= 0.2) reasons.push(`门票约 ${moneyText(cost)}，性价比优先`)
  if (poi.outdoor && rainProb >= 55) reasons.push('降雨概率偏高，户外体验下降')
  if (!poi.outdoor && rainProb >= 55) reasons.push('室内点位，不受降雨影响')
  if (durationFit >= 0.8) reasons.push(`建议游玩 ${duration} 分钟，契合${pace.label}节奏`)
  if (proximity >= 0.82) reasons.push('离市中心较近，通勤成本低')

  return {
    poi,
    score: Number(score.toFixed(4)),
    parts: { interest, quality, popularity, costFit, weatherFit, durationFit, proximity },
    matchedPrefs: matched,
    reasons
  }
}

/**
 * 加权几何中位数（Weiszfeld 迭代）：求使 Σ wᵢ·d(P, Qᵢ) 最小的点
 *
 * 与质心的区别：质心是“坐标平均”，会被偏远点位拉偏；几何中位数对离群点稳健，
 * 适合作为“到各景点总通勤最小”的住宿锚点。
 *
 * @param {Array} points [{ lng, lat, weight? }]
 * @param {Object} options { maxIter=80, toleranceMeters=2 }
 * @returns {{lng:Number, lat:Number, iterations:Number, converged:Boolean}|null}
 */
function geometricMedian(points, options) {
  const opts = options || {}
  const maxIter = Math.max(1, Number(opts.maxIter) || 80)
  const tolerance = Math.max(0.5, Number(opts.toleranceMeters) || 2)

  const valid = []
  ;(points || []).forEach((point) => {
    if (!point) return
    const lng = Number(point.lng)
    const lat = Number(point.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
    const weight = Number(point.weight)
    valid.push({ lng, lat, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 })
  })
  if (!valid.length) return null
  if (valid.length === 1) {
    return { lng: valid[0].lng, lat: valid[0].lat, iterations: 0, converged: true }
  }

  // 合并同一坐标点（权重累加），避免 Weiszfeld 分母出现 0
  const buckets = {}
  valid.forEach((point) => {
    const key = `${point.lng.toFixed(7)},${point.lat.toFixed(7)}`
    if (!buckets[key]) buckets[key] = { lng: point.lng, lat: point.lat, weight: 0 }
    buckets[key].weight += point.weight
  })
  const merged = Object.keys(buckets).map((key) => buckets[key])
  if (merged.length === 1) {
    return { lng: merged[0].lng, lat: merged[0].lat, iterations: 0, converged: true }
  }

  // 城市尺度下用局部平面投影（米）做迭代，避免经度方向被纬度压缩
  const meanLat = merged.reduce((sum, p) => sum + p.lat, 0) / merged.length
  const scaleX = Math.cos((meanLat * Math.PI) / 180) * 111320
  const scaleY = 110540
  const totalWeight = merged.reduce((sum, p) => sum + p.weight, 0)
  let x = merged.reduce((sum, p) => sum + p.lng * scaleX * p.weight, 0) / totalWeight
  let y = merged.reduce((sum, p) => sum + p.lat * scaleY * p.weight, 0) / totalWeight
  let converged = false
  let iterations = 0

  for (; iterations < maxIter; iterations++) {
    let numX = 0
    let numY = 0
    let den = 0
    let coincident = null

    for (let i = 0; i < merged.length; i++) {
      const p = merged[i]
      const px = p.lng * scaleX
      const py = p.lat * scaleY
      const distance = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py))
      // 迭代点已落在某个数据点上：该点即稳定解（权重再大也无法继续移动）
      if (distance < 0.5) {
        coincident = p
        break
      }
      const ratio = p.weight / distance
      numX += ratio * px
      numY += ratio * py
      den += ratio
    }

    if (coincident) {
      x = coincident.lng * scaleX
      y = coincident.lat * scaleY
      converged = true
      break
    }
    if (!den) break

    const nextX = numX / den
    const nextY = numY / den
    const moved = Math.sqrt((nextX - x) * (nextX - x) + (nextY - y) * (nextY - y))
    x = nextX
    y = nextY
    if (moved <= tolerance) {
      converged = true
      break
    }
  }

  return {
    lng: x / scaleX,
    lat: y / scaleY,
    iterations: Math.min(iterations, maxIter),
    converged
  }
}

/**
 * 住宿候选打分：通勤贴合 × 价格匹配 × 口碑 × 类型偏好
 * 价格缺失按中性分（沿用 scorePoi 的 costFit 逻辑，不把「未知」当「便宜」）
 *
 * @param {Object} stay 标准化住宿 POI
 * @param {Object} ctx { anchor, pois, budgetMin, budgetMax, type, transport, party, hasElder }
 */
function scoreStay(stay, ctx) {
  const anchor = ctx.anchor
  const pois = (ctx.pois || []).filter((p) => p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat)))
  const modeCtx = { transportPref: ctx.transport, party: ctx.party, hasElder: ctx.hasElder }

  const anchorKm = anchor ? haversine(anchor, stay) / 1000 : null
  const proximity = anchorKm === null ? 0.6 : clamp(1 - anchorKm / 8, 0, 1)

  let avgMinutes = 0
  if (pois.length) {
    const minutes = pois.map((poi) => {
      const distance = haversine(stay, poi)
      return estimateLeg(stay, poi, chooseMode(distance, modeCtx)).minutes
    })
    avgMinutes = minutes.reduce((sum, value) => sum + value, 0) / minutes.length
  } else {
    avgMinutes = anchorKm === null ? 20 : estimateLeg(stay, anchor, chooseMode(anchorKm * 1000, modeCtx)).minutes
  }
  const commuteFit = clamp(1 - avgMinutes / 50, 0, 1)
  // 锚点贴合与到各景点的平均通勤各占一半，避免只看单一距离
  const commute = anchorKm === null ? commuteFit : 0.45 * proximity + 0.55 * commuteFit

  const min = Math.max(0, Number(ctx.budgetMin) || 0)
  const max = Math.max(min + 1, Number(ctx.budgetMax) || 0)
  const priceKnown = !!(stay.priceKnown && Number.isFinite(Number(stay.price)))
  let priceFit = 0.6
  if (priceKnown) {
    const price = Number(stay.price)
    if (price >= min && price <= max) priceFit = 1
    else if (price < min) priceFit = 0.92
    else priceFit = clamp(1 - (price - max) / (max * 0.75), 0, 1)
  }

  const rating = Number(stay.rating)
  const hasRating = Number.isFinite(rating) && rating > 0
  const ratingFit = hasRating ? clamp((rating - 3.5) / 1.5, 0, 1) : 0.5

  const pref = ctx.type || 'any'
  const typeFit = pref === 'any' ? 1 : stay.stayType === pref ? 1 : 0.5

  const score = 0.38 * commute + 0.3 * priceFit + 0.17 * ratingFit + 0.15 * typeFit
  const reasons = []
  if (anchorKm !== null) reasons.push(`距通勤锚点 ${anchorKm.toFixed(1)} 公里`)
  reasons.push(`日均通勤约 ${Math.round(avgMinutes)} 分钟`)
  if (priceKnown) reasons.push(`参考价 ${moneyText(stay.price)}`)
  else reasons.push('参考价未公开，以平台为准')
  if (hasRating && ratingFit >= 0.75) reasons.push(`评分 ${rating.toFixed(1)}，口碑稳定`)
  if (pref !== 'any' && stay.stayType !== pref) reasons.push('类型与偏好不同，作为备选')

  return {
    stay,
    score: Number(score.toFixed(4)),
    parts: { commute, proximity, priceFit, ratingFit, typeFit },
    avgMinutes: Math.round(avgMinutes),
    anchorKm: anchorKm === null ? null : Number(anchorKm.toFixed(2)),
    reasons
  }
}

/**
 * 按天分组：按分数从高到低插入到“边际代价最小”的那一天
 */
function assignDays(scored, opts) {
  const { days, center, variantKey, capacity, weatherByDate } = opts
  const states = days.map((day) => ({
    date: day.date,
    rainProb: (weatherByDate && weatherByDate[day.date] && weatherByDate[day.date].rainProb) || 0,
    items: [],
    minutes: 0,
    centroid: { lng: center.lng, lat: center.lat },
    categories: {}
  }))

  const variant = VARIANTS[variantKey] || VARIANTS.balanced

  scored.forEach((item) => {
    const available = states.filter((s) => s.items.length < capacity)
    if (!available.length) return

    let bestState = null
    let bestCost = Infinity
    available.forEach((state) => {
      const km = haversine(state.centroid, item.poi) / 1000
      let penalty = km / 9 + state.minutes / 540
      if (variantKey === 'time') penalty += km / 8
      if (variantKey === 'budget') penalty += (Number(item.poi.cost) || 0) / 180
      if (state.rainProb >= 60 && item.poi.outdoor) penalty += 3.2
      if (state.rainProb >= 40 && item.poi.outdoor) penalty += 1.2
      if (state.categories[item.poi.category] >= 2) penalty += 0.8
      if (penalty < bestCost) {
        bestCost = penalty
        bestState = state
      }
    })

    if (!bestState) return
    bestState.items.push(item)
    bestState.minutes += (Number(item.poi.duration) || 120) + 25
    bestState.centroid = centroid(bestState.items.map((it) => it.poi))
    const cat = item.poi.category || 'other'
    bestState.categories[cat] = (bestState.categories[cat] || 0) + 1
  })

  // 保证每天至少有一条内容：从最拥挤的一天挪一条过去
  states.forEach((state, idx) => {
    if (state.items.length) return
    let source = null
    states.forEach((s) => {
      if (s.items.length > 1 && (!source || s.items.length > source.items.length)) source = s
    })
    if (source) {
      const moved = source.items.pop()
      state.items.push(moved)
      state.minutes = moved.poi.duration || 120
      state.rainProb = 0
      state.centroid = centroid(state.items.map((it) => it.poi))
      source.minutes = source.items.reduce((sum, it) => sum + (it.poi.duration || 120) + 25, 0)
      source.centroid = centroid(source.items.map((it) => it.poi)) || center
    }
  })

  return states
}

/**
 * 解析开放时间文本（如 09:00-17:00、08:30-18:00,19:00-22:00）
 * 无法解析时返回 null：按“未知”处理，不臆造开放约束
 */
function parseOpenWindows(text) {
  const raw = String(text || '')
  if (!raw) return null
  if (/全天|24\s*小时|24h/i.test(raw)) return [{ open: 0, close: 24 * 60 }]
  const re = /(\d{1,2}):(\d{2})\s*[-~—–至到]\s*(\d{1,2}):(\d{2})/g
  const list = []
  let match
  while ((match = re.exec(raw)) !== null) {
    const open = Number(match[1]) * 60 + Number(match[2])
    let close = Number(match[3]) * 60 + Number(match[4])
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue
    if (close <= open) close += 24 * 60
    list.push({ open, close })
  }
  if (!list.length) return null
  return list.sort((a, b) => a.open - b.open)
}

/**
 * 在开放时间窗内寻找可完成的时段：到达早了就等待，全部窗都放不下则不可行
 * windows 为 null 表示开放时间未知，不做硬约束
 */
function resolveOpenWindow(windows, arrival, duration) {
  if (!windows || !windows.length) return { ok: true, wait: 0, close: null }
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i]
    const start = Math.max(arrival, win.open)
    if (start + duration <= win.close) {
      return { ok: true, wait: Math.max(0, start - arrival), close: win.close }
    }
  }
  return { ok: false, wait: 0, close: null }
}

/** 矩阵单元取代价：time 取耗时，money 取交通费用 */
function matrixValue(cell, kind) {
  if (typeof cell === 'number') return cell
  if (!cell) return 0
  return kind === 'money' ? Number(cell.cost) || 0 : Number(cell.minutes) || 0
}

/**
 * 多起点最近邻构造 + 2-opt（酒店固定为行程起点）
 *
 * 1) 以酒店、以及每个候选景点作为构造起点各跑一次最近邻，避免单起点陷入差解
 * 2) 2-opt 用开放时间窗评估：等待、闭园超时都计入代价，超时点位会被排到末尾
 * 3) 取总代价最小的顺序返回
 *
 * matrix 单元为 { minutes, cost }，也兼容旧的纯数字矩阵
 * opts: { kind: 'time'|'money', startMinutes, deadline }
 */
function optimizeOrder(points, matrix, opts) {
  const n = points.length
  if (n <= 2) return points.slice()

  const options = opts || {}
  const kind = options.kind === 'money' ? 'money' : 'time'
  const startMinutes = Number(options.startMinutes) || 9 * 60
  const deadline = Number(options.deadline) || 21 * 60
  const windows = points.map((poi) => parseOpenWindows(poi && poi.openTime))
  const durations = points.map((poi) => Math.min(Number(poi && poi.duration) || 120, 300))
  const waitWeight = kind === 'money' ? 1.5 : 1
  const lateWeight = 240

  // 沿行程推进时钟，累计交通代价、等待时间与超时惩罚
  const walkTimeline = (tour) => {
    let cursor = startMinutes
    let travel = 0
    let wait = 0
    let late = 0
    for (let i = 1; i < tour.length; i++) {
      const cell = matrix[tour[i - 1]][tour[i]]
      const minutes = typeof cell === 'number' ? cell : Number(cell && cell.minutes) || 0
      cursor += minutes
      travel += matrixValue(cell, kind)
      const win = resolveOpenWindow(windows[tour[i]], cursor, durations[tour[i]])
      if (!win.ok) {
        late += durations[tour[i]]
        cursor += durations[tour[i]]
        continue
      }
      if (win.wait) {
        cursor += win.wait
        wait += win.wait
      }
      const visitEnd = cursor + durations[tour[i]]
      if (visitEnd > deadline) late += visitEnd - deadline
      cursor = visitEnd
    }
    return { cursor, travel, wait, late, score: travel + wait * waitWeight + late * lateWeight }
  }

  // 单一构造起点：0 = 酒店；其余起点表示“首站先去该景点”，酒店仍排在最前
  const construct = (start) => {
    const tour = start === 0 ? [0] : [0, start]
    const visited = new Array(n).fill(false)
    visited[0] = true
    visited[start] = true
    let state = walkTimeline(tour)

    while (tour.length < n) {
      const current = tour[tour.length - 1]
      let next = -1
      let bestScore = Infinity
      for (let j = 1; j < n; j++) {
        if (visited[j]) continue
        const cell = matrix[current][j]
        const minutes = typeof cell === 'number' ? cell : Number(cell && cell.minutes) || 0
        const arrival = state.cursor + minutes
        const win = resolveOpenWindow(windows[j], arrival, durations[j])
        let score = matrixValue(cell, kind)
        if (!win.ok) {
          score += durations[j] * lateWeight
        } else {
          score += win.wait * waitWeight
          const end = arrival + win.wait + durations[j]
          if (end > deadline) score += (end - deadline) * lateWeight
          // 闭园越早的点位越先安排，避免“先逛后门”
          if (win.close !== null) {
            score += Math.max(0, 60 - (win.close - end)) * 0.6
          }
        }
        if (score < bestScore) {
          bestScore = score
          next = j
        }
      }
      if (next === -1) break
      tour.push(next)
      visited[next] = true
      state = walkTimeline(tour)
    }
    return tour
  }

  const twoOpt = (initial) => {
    let bestTour = initial.slice()
    let bestScore = walkTimeline(bestTour).score
    let improved = true
    let guard = 0
    while (improved && guard < 20) {
      improved = false
      guard++
      for (let i = 1; i < bestTour.length - 1; i++) {
        for (let j = i + 1; j < bestTour.length; j++) {
          if (i === 1 && j === bestTour.length - 1) continue
          const candidate = bestTour
            .slice(0, i)
            .concat(bestTour.slice(i, j + 1).reverse())
            .concat(bestTour.slice(j + 1))
          const score = walkTimeline(candidate).score
          if (score + 1e-6 < bestScore) {
            bestTour = candidate
            bestScore = score
            improved = true
          }
        }
      }
    }
    return { tour: bestTour, score: bestScore }
  }

  let bestTour = null
  let bestScore = Infinity
  for (let start = 0; start < n; start++) {
    const result = twoOpt(construct(start))
    if (result.score < bestScore) {
      bestScore = result.score
      bestTour = result.tour
    }
  }

  return (bestTour || [0]).map((index) => points[index])
}

/** 交通方式选择 */
function chooseMode(distanceMeters, opts) {
  const { transportPref = 'mixed', party = 2, hasElder = false } = opts || {}
  const km = distanceMeters / 1000

  if (transportPref === 'drive' && km > 1.2) return 'drive'
  if (km <= 1.0) return 'walk'
  if (hasElder || party >= 5) {
    if (km <= 1.8) return 'walk'
    return transportPref === 'transit' ? 'transit' : 'taxi'
  }
  if (transportPref === 'taxi') return 'taxi'
  if (transportPref === 'transit') return km <= 1.6 ? 'walk' : 'transit'
  if (km <= 1.6) return 'walk'
  if (km <= 3.2) return 'transit'
  // mixed：短途打车省时，长途公交省钱
  return km <= 9 ? 'taxi' : 'transit'
}

function legCost(mode, distanceMeters, party) {
  const km = distanceMeters / 1000
  const pax = Math.max(1, Number(party) || 1)
  if (mode === 'walk' || mode === 'bike') return 0
  if (mode === 'transit') return Math.round(3 * pax)
  if (mode === 'taxi') return Math.round(13 + Math.max(0, km - 3) * 2.7)
  if (mode === 'drive') return Math.round(km * 0.9 + 10)
  return 0
}

function clock(minutes) {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`
}

/**
 * 生成单日时间轴
 * resolveLeg(from, to, mode) 返回 { mode, minutes, distance, points?, estimated }
 */
function scheduleDay(options) {
  const {
    ordered,
    hotel,
    rainProb = 0,
    weatherText = '',
    party = 2,
    budget,
    startClock,
    endClock,
    lunchPrice,
    dinnerPrice,
    resolveLeg
  } = options

  const startMinutes = typeof startClock === 'string' ? (() => {
    const [h, m] = startClock.split(':').map(Number)
    return h * 60 + m
  })() : 9 * 60

  // 用户设置的每日结束时间；默认 21:00
  const endMinutes = typeof endClock === 'string' ? (() => {
    const [h, m] = endClock.split(':').map(Number)
    return h * 60 + m
  })() : 21 * 60
  const deadline = Math.max(startMinutes + 60, Math.min(24 * 60 - 1, endMinutes))

  const items = []
  const dropped = []
  let cursor = startMinutes
  let lunchDone = false
  let dinnerDone = false

  const addMeal = (type) => {
    const isLunch = type === 'lunch'
    const cost = Math.round((isLunch ? lunchPrice : dinnerPrice) * Math.max(1, party))
    items.push({
      type: 'meal',
      timeText: clock(cursor),
      endText: clock(cursor + 55),
      title: isLunch ? '午餐 · 就近解决' : '晚餐 · 就近解决',
      subtitle: `建议 55 分钟，约 ${cost} 元`,
      minutes: 55,
      cost,
      icon: '食'
    })
    cursor += 55
    if (isLunch) lunchDone = true
    else dinnerDone = true
  }

  for (let i = 0; i < ordered.length; i++) {
    const poi = ordered[i]
    const from = i === 0 ? hotel : ordered[i - 1]
    const mode = chooseMode(haversine(from, poi), options.transport)
    let leg = resolveLeg(from, poi, mode)

    // 出发前跨过饭点 → 先吃饭
    if (!lunchDone && cursor + leg.minutes >= 12 * 60 && cursor < 12 * 60) addMeal('lunch')
    if (!dinnerDone && cursor + leg.minutes >= 18 * 60 && cursor < 18 * 60) addMeal('dinner')

    const arrival = cursor + leg.minutes
    const duration = Math.min(Number(poi.duration) || 120, 300)

    // 开放时间硬约束：闭园/未开门且当天等不到合适时段 → 该点位不排入
    const windows = parseOpenWindows(poi.openTime)
    const win = resolveOpenWindow(windows, arrival, duration)
    if (!win.ok) {
      dropped.push(poi.name)
      continue
    }
    const wait = win.wait

    // 超过用户设定的结束时间无法完成 → 标记为“未排入”，不打断后续
    if (arrival + wait + duration > deadline && i > 0) {
      dropped.push(poi.name)
      continue
    }

    const legCostValue = legCost(leg.mode, leg.distance, party)
    const waitText = wait > 0 ? ` · 等待开园 ${wait} 分钟` : ''
    items.push({
      type: 'transit',
      fromName: from.name || '出发地',
      toName: poi.name,
      modeText: leg.mode,
      timeText: clock(cursor),
      endText: clock(arrival + wait),
      minutes: leg.minutes,
      distance: leg.distance,
      cost: legCostValue,
      points: leg.points || null,
      estimated: !!leg.estimated,
      title: `${from.name || '出发地'} → ${poi.name}`,
      subtitle: `${modeLabel(leg.mode)} · ${Math.round(leg.distance)} 米 · 约 ${leg.minutes} 分钟${waitText}`,
      icon: modeLabel(leg.mode).slice(0, 1)
    })

    cursor = arrival + wait

    // 到达后已过饭点 → 先吃饭再游玩
    if (!lunchDone && cursor >= 12 * 60 + 20) {
      addMeal('lunch')
      cursor = Math.max(cursor, 12 * 60 + 55)
    }
    if (!dinnerDone && cursor >= 18 * 60 + 20) {
      addMeal('dinner')
    }

    const visitStart = cursor
    const unitCost =
      poi.cost !== null && poi.cost !== undefined && Number.isFinite(Number(poi.cost)) ? Number(poi.cost) : null
    items.push({
      type: 'poi',
      poiId: poi.id,
      name: poi.name,
      category: poi.category,
      timeText: clock(visitStart),
      endText: clock(visitStart + duration),
      minutes: duration,
      cost: unitCost === null ? 0 : unitCost * Math.max(1, party),
      unitCost,
      rating: poi.rating,
      outdoor: poi.outdoor,
      lng: poi.lng,
      lat: poi.lat,
      address: poi.address,
      tags: (poi.tags || []).slice(0, 3),
      openTime: poi.openTime,
      subtitle: `建议游玩 ${duration} 分钟${
        unitCost === null ? ' · 票价未公开，以景区公告为准' : unitCost ? ` · 门票约 ${Math.round(unitCost)} 元/人` : ' · 免费'
      }`,
      icon: '景',
      tips: poi.tips || ''
    })

    cursor = visitStart + duration
  }

  // 收尾：若最后一个点位结束太晚，仍标注返回
  items.push({
    type: 'end',
    timeText: clock(cursor),
    title: '返回住处 / 自由活动',
    subtitle: rainProb >= 60 ? '有降雨，注意随身携带雨具' : weatherText || '可按体力灵活调整',
    icon: '返'
  })

  return { items, dropped, endText: clock(cursor) }
}

function modeLabel(mode) {
  return {
    walk: '步行',
    bike: '骑行',
    transit: '公交/地铁',
    taxi: '打车',
    drive: '自驾'
  }[mode] || '出行'
}

/** 汇总当日行程指标 */
function summarizeItems(items, party) {
  let travelMinutes = 0
  let travelDistance = 0
  let transportCost = 0
  let ticketCost = 0
  let mealCost = 0
  let poiCount = 0
  let unknownTicketCount = 0

  items.forEach((item) => {
    if (item.type === 'transit') {
      travelMinutes += item.minutes || 0
      travelDistance += item.distance || 0
      transportCost += item.cost || 0
    }
    if (item.type === 'poi') {
      poiCount++
      if (item.unitCost === null || item.unitCost === undefined) unknownTicketCount++
      else ticketCost += item.cost || 0
    }
    if (item.type === 'meal') mealCost += item.cost || 0
  })

  return {
    travelMinutes,
    travelDistance,
    transportCost,
    ticketCost,
    mealCost,
    poiCount,
    unknownTicketCount,
    cost: transportCost + ticketCost + mealCost
  }
}

module.exports = {
  PACES,
  PREF_TAGS,
  VARIANTS,
  matchPrefs,
  scorePoi,
  geometricMedian,
  scoreStay,
  assignDays,
  optimizeOrder,
  chooseMode,
  legCost,
  scheduleDay,
  summarizeItems,
  clamp
}
