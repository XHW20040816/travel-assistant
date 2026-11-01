/**
 * 住宿推荐：按预算与类型检索酒店/民宿/青旅，并按通勤锚点打分排序
 *
 * 数据全部来自现有 poiText 网关（高德/百度），价格缺失不做臆造；
 * 缓存沿用 poiText 的 7 天 TTL，不新增云函数 action。
 */
const api = require('./api')
const mapService = require('./map')
const decision = require('../utils/decision')
const geo = require('../utils/geo')
const format = require('../utils/format')

const QUERY_BY_TYPE = {
  any: '酒店|民宿|客栈|青年旅舍',
  hotel: '酒店|宾馆',
  homestay: '民宿|客栈',
  hostel: '青年旅舍|青旅'
}

const TYPE_LABEL = {
  any: '不限',
  hotel: '酒店',
  homestay: '民宿',
  hostel: '青旅'
}

function typeLabel(type) {
  return TYPE_LABEL[type] || TYPE_LABEL.any
}

function normalizeType(type) {
  return QUERY_BY_TYPE[type] ? type : 'any'
}

/** 按关键词检索住宿候选，返回标准化结构 */
async function search(options) {
  const type = normalizeType(options.type)
  const city = options.adcode || options.cityName || ''
  const params = {
    keywords: QUERY_BY_TYPE[type],
    city,
    citylimit: true,
    offset: 20,
    page: 1,
    extensions: 'all'
  }
  const { data, meta } = await api.call('poiText', params, { force: options.force })
  const provider = meta.provider

  if (provider === 'baidu') {
    if (Number(data.status) !== 0) throw api.makeError('POI_FAIL', data.message || '百度住宿检索失败')
  } else if (data.status !== '1') {
    throw api.makeError('POI_FAIL', data.info || '高德住宿检索失败')
  }

  const list = provider === 'baidu' ? data.results || [] : data.pois || []
  const merged = []
  const seen = new Set()

  list.forEach((raw) => {
    const item = mapService.normalizeHotelPoi(raw, provider, options.cityName)
    if (!item) return
    if (options.center && geo.haversine(options.center, item) > 30000) return
    const key = item.name.replace(/\s/g, '')
    if (seen.has(key)) return
    seen.add(key)
    merged.push({ ...item, fetchedAt: meta.fetchedAt || Date.now() })
  })

  return { list: merged, provider, fetchedAt: meta.fetchedAt || Date.now() }
}

/** 行程点位去重后作为锚点求解输入，权重取游玩时长 */
function anchorPoints(pois) {
  const seen = {}
  const points = []
  ;(pois || []).forEach((poi) => {
    const lng = Number(poi && poi.lng)
    const lat = Number(poi && poi.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`
    if (seen[key]) return
    seen[key] = true
    points.push({ lng, lat, weight: Math.max(30, Number(poi.duration) || 120) })
  })
  return points
}

/**
 * 推荐住宿
 * @param {Object} options {
 *   cityName, adcode, center, pois, budgetMin, budgetMax,
 *   type, transport, party, hasElder, limit, force
 * }
 */
async function recommend(options) {
  const pois = options.pois || []
  const points = anchorPoints(pois)
  const anchor = decision.geometricMedian(points, { maxIter: 80, toleranceMeters: 2 })

  const primary = await search(options)
  let list = primary.list
  let provider = primary.provider
  let fetchedAt = primary.fetchedAt

  // 指定类型没有结果时，回退到全类型再试一次，避免页面空白
  if (!list.length && options.type && options.type !== 'any') {
    const fallback = await search({ ...options, type: 'any', force: options.force })
    list = fallback.list
    provider = fallback.provider
    fetchedAt = fallback.fetchedAt
  }

  if (!list.length) {
    return { anchor, anchorText: '', stays: [], meta: { provider, fetchedAt, candidateCount: 0 } }
  }

  const scored = list.map((stay) =>
    decision.scoreStay(stay, {
      anchor,
      pois,
      budgetMin: options.budgetMin,
      budgetMax: options.budgetMax,
      type: options.type,
      transport: options.transport,
      party: options.party,
      hasElder: options.hasElder
    })
  )
  scored.sort((a, b) => b.score - a.score || (Number(b.stay.rating) || 0) - (Number(a.stay.rating) || 0))

  const limit = Math.max(1, Math.min(3, Number(options.limit) || 3))
  const stays = scored.slice(0, limit).map((entry, index) => {
    const stay = entry.stay
    const priceKnown = !!(stay.priceKnown && Number.isFinite(Number(stay.price)))
    const price = priceKnown ? Number(stay.price) : null
    const budgetMatched = priceKnown && price >= Number(options.budgetMin) && price <= Number(options.budgetMax)
    const hasRating = Number(stay.rating) > 0
    return {
      id: stay.id,
      name: stay.name,
      stayType: stay.stayType,
      typeLabel: stay.typeLabel,
      lng: stay.lng,
      lat: stay.lat,
      address: stay.address || '',
      rating: hasRating ? Number(stay.rating) : null,
      ratingText: hasRating ? `${Number(stay.rating).toFixed(1)} 分` : '暂无评分',
      price,
      priceKnown,
      priceText: priceKnown ? `参考价 ${format.money(price)}/晚` : '参考价未公开',
      priceTag: priceKnown ? `${format.money(price)}/晚` : '未公开',
      anchorText: entry.anchorKm === null ? '' : `距锚点 ${entry.anchorKm.toFixed(1)} 公里`,
      commuteText: `日均通勤约 ${entry.avgMinutes} 分钟`,
      score: Math.round(entry.score * 100),
      rank: index + 1,
      reasons: entry.reasons.slice(0, 3),
      budgetMatched
    }
  })

  const anchorText = points.length
    ? `已按 ${points.length} 个行程点位（游玩时长加权）求解通勤锚点`
    : '未取得行程点位，按目的地中心估算通勤'

  return {
    anchor,
    anchorText,
    stays,
    meta: {
      provider,
      fetchedAt,
      candidateCount: list.length
    }
  }
}

module.exports = {
  recommend,
  search,
  typeLabel,
  QUERY_BY_TYPE
}
