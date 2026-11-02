/**
 * 地图服务：POI 检索、地理编码、路径规划
 * 对外统一返回标准化结构，屏蔽高德/百度差异
 */
const api = require('./api')
const config = require('../config/index')
const geo = require('../utils/geo')

const PREF_QUERY = {
  nature: { keywords: '公园|风景区|湿地', types: '110000|110100' },
  culture: { keywords: '博物馆|古迹|寺庙', types: '140000|110000' },
  food: { keywords: '美食|小吃街', types: '050000' },
  family: { keywords: '动物园|游乐园|水族馆', types: '110000|080000' },
  shopping: { keywords: '购物中心|商业街', types: '060000' },
  night: { keywords: '夜景|酒吧|演出', types: '080000' },
  photo: { keywords: '观景台|景区', types: '110000' },
  show: { keywords: '剧场|演出', types: '080000' }
}

const NOISE_WORDS = ['酒店', '宾馆', '停车场', '售票', '入口', '地铁站', '公交站', '派出所', '医院', '银行', '加油站', '充电站']

/** 可作为目的地的行政区级别；村庄、兴趣点、门牌号等模糊匹配结果不直接采用 */
const ADMIN_LEVELS = ['国家', '省', '市', '直辖市', '城市', '区县', '区', '县', '县级市', '乡镇', '特别行政区']

/** Amap 的 city 可能返回数组，行政区名称统一去空白 */
function cleanAdminName(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join('')
  return String(value || '').replace(/\s+/g, '')
}

function normalizeLevel(value) {
  return String(value || '').replace(/[^\u4e00-\u9fa5]/g, '')
}

/** 关键词是否命中省/市/区县/乡镇任一行政名称，支持“杭州 西湖”这类多词输入 */
function matchAdminName(keyword, result) {
  const names = [result.province, result.adminCity, result.district, result.township]
    .map(cleanAdminName)
    .filter(Boolean)
  if (!names.length) return false
  const tokens = String(keyword || '')
    .split(/[\s,，、/|·]+/)
    .map(cleanAdminName)
    .filter(Boolean)
  const key = cleanAdminName(keyword)
  if (key) tokens.push(key)
  return names.some((name) =>
    tokens.some((token) => {
      if (!token) return false
      if (name.indexOf(token) >= 0) return true
      return token.length >= 2 && name.length >= 2 && token.indexOf(name) >= 0
    })
  )
}

/**
 * 自由文本地理编码校验：只接受行政区级别结果，避免“火星”被模糊匹配到贵州某村后直接规划
 * 地图选点反查地址时传 allowPoi，允许兴趣点、门牌号等精确坐标
 */
function assertGeoResult(result, keyword, options) {
  if (options && options.allowPoi) return
  const lng = Number(result.lng)
  const lat = Number(result.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw api.makeError('GEOCODE_FAIL', `「${keyword}」没有返回有效坐标`)
  }
  const hasAdminName = [result.province, result.adminCity, result.district, result.township].some((name) =>
    cleanAdminName(name)
  )
  const notFound = () => {
    throw api.makeError(
      'DEST_NOT_FOUND',
      `未找到城市/地区「${keyword}」，请输入城市或区县名称，或使用「地图选点」选择真实地点`
    )
  }
  if (hasAdminName) {
    if (!result.adcode || !matchAdminName(keyword, result)) notFound()
    return
  }
  // 百度正地理编码不返回 addressComponent，只能按 level 是否属于行政区划判断
  if (ADMIN_LEVELS.indexOf(normalizeLevel(result.level)) < 0) notFound()
}

/** 稳定短哈希，用于无 id 的 POI 生成唯一标识 */
function hashText(text) {
  const str = String(text || '')
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/** 上游未返回折线时按直线插值，仅用于地图展示 */
function straightPoints(from, to, count) {
  const total = count || 12
  const points = []
  for (let i = 0; i <= total; i += 1) {
    const ratio = i / total
    points.push({
      longitude: Number(from.lng) + (Number(to.lng) - Number(from.lng)) * ratio,
      latitude: Number(from.lat) + (Number(to.lat) - Number(from.lat)) * ratio
    })
  }
  return points
}

function includesAny(text, words) {
  return words.some((word) => text.indexOf(word) >= 0)
}

/** 名称归一化：仅用于同名匹配，去掉空白并统一大小写 */
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

function matchesName(name, names) {
  const key = normalizeName(name)
  if (!key) return false
  return names.some((item) => normalizeName(item) === key)
}

function detectCategory(text) {
  if (includesAny(text, ['公园', '风景', '自然', '湿地', '海滩', '湖', '山', '森林'])) return '自然'
  if (includesAny(text, ['博物馆', '文物', '古迹', '寺庙', '遗址', '文化', '艺术', '美术馆', '纪念馆'])) return '人文'
  if (includesAny(text, ['餐饮', '美食', '小吃', '夜市'])) return '美食'
  if (includesAny(text, ['购物', '商场', '市场', '商业街'])) return '购物'
  if (includesAny(text, ['酒吧', '夜', '剧场', '演艺'])) return '夜生活'
  if (includesAny(text, ['动物园', '水族馆', '乐园', '亲子', '海洋馆'])) return '亲子'
  if (includesAny(text, ['观景', '摄影', '打卡'])) return '摄影'
  return '综合'
}

function isOutdoor(text) {
  if (includesAny(text, ['博物馆', '美术馆', '展览', '商场', '购物中心', '剧院', '剧场', '水族馆', '纪念馆'])) return false
  return includesAny(text, ['公园', '风景', '广场', '街区', '海滩', '山', '湖', '湿地', '古镇', '步行街', '码头', '观景', '遗址'])
}

function defaultDuration(category, text) {
  if (includesAny(text, ['乐园', '迪士尼', '水世界'])) return 300
  if (includesAny(text, ['博物馆', '美术馆', '纪念馆'])) return 150
  if (category === '美食') return 90
  if (category === '购物') return 120
  if (category === '自然') return 150
  return 120
}

function parseTags(type, name, category) {
  const tokens = String(type || '')
    .split(/[|;]/)
    .map((item) => item.trim())
    .filter((item) => item && !/^[0-9]+$/.test(item) && item.length <= 8)
  const tags = new Set(tokens.slice(0, 6))
  tags.add(category)
  if (includesAny(`${name}${type}`, ['夜景', '灯光'])) tags.add('夜景')
  if (includesAny(`${name}${type}`, ['亲子', '动物', '乐园'])) tags.add('亲子')
  return Array.from(tags)
}

function normalizeAmapPoi(raw, cityName) {
  const type = raw.type || ''
  const text = `${raw.name || ''}${type}`
  const category = detectCategory(text)
  const biz = raw.biz_ext || {}
  // 评分 / 人均消费只使用接口真实返回的字段，缺失即留空，不再填入默认值
  const ratingValue = Number(biz.rating !== undefined && biz.rating !== '' ? biz.rating : raw.rating)
  const rating = Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null
  const costValue = Number(biz.cost)
  const cost = Number.isFinite(costValue) && costValue >= 0 ? costValue : null
  return {
    id: raw.id || `amap-${hashText(text)}`,
    name: raw.name,
    city: cityName,
    category,
    tags: parseTags(type, raw.name, category),
    lng: Number(raw.location ? raw.location.split(',')[0] : 0),
    lat: Number(raw.location ? raw.location.split(',')[1] : 0),
    address: raw.address || '',
    rating,
    reviews: 0,
    cost,
    costKnown: cost !== null,
    duration: defaultDuration(category, text),
    outdoor: isOutdoor(text),
    openTime: biz.open_time || '以官方公告为准',
    tips: raw.tag || '',
    source: 'amap'
  }
}

function normalizeBaiduPoi(raw, cityName) {
  const text = `${raw.name || ''}${raw.type || ''}`
  const category = detectCategory(text)
  const detail = raw.detail_info || {}
  const location = raw.location || {}
  const lng = Number(location.lng)
  const lat = Number(location.lat)
  // 坐标缺失或非法时直接丢弃该点位，避免 NaN 坐标进入后续转换与路线请求
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return null
  }
  const converted = geo.bd09ToGcj02(lng, lat)
  const hasBaiduPrice =
    detail.price !== undefined && detail.price !== null && detail.price !== '' && Number.isFinite(Number(detail.price))
  return {
    id: `baidu-${hashText(raw.uid || text)}`,
    name: raw.name,
    city: cityName,
    category,
    tags: parseTags(raw.type || raw.tag || '', raw.name, category),
    lng: converted.lng,
    lat: converted.lat,
    address: raw.address || '',
    rating: Number(detail.overall_rating) > 0 ? Number(detail.overall_rating) : null,
    reviews: Number(detail.comment_num || 0),
    cost: hasBaiduPrice ? Number(detail.price) : null,
    costKnown: hasBaiduPrice,
    duration: defaultDuration(category, text),
    outdoor: isOutdoor(text),
    openTime: '以官方公告为准',
    tips: raw.tag || '',
    source: 'baidu'
  }
}

/** 住宿类型标签：上游类型码不稳定，名称关键词优先，识别不出按酒店处理 */
const STAY_TYPE_LABEL = { hotel: '酒店', homestay: '民宿', hostel: '青旅' }
const STAY_HINTS = ['酒店', '宾馆', '民宿', '客栈', '旅舍', '青旅', '旅馆', '公寓', '度假村', '度假酒店']
const STAY_NOISE = ['用品', '设备', '家具', '装修', '管理', '招聘', '食材', '批发', '门业', '窗帘', '床垫', 'ktv', '会所']

function detectStayType(name, type) {
  const text = `${name || ''}${type || ''}`
  if (includesAny(text, ['青年旅舍', '青年旅社', '青旅', '国际青年'])) return 'hostel'
  if (includesAny(text, ['民宿', '客栈', '农家乐', '农家院', '小院'])) return 'homestay'
  return 'hotel'
}

/**
 * 住宿 POI 标准化：只保留真实返回的价格/评分字段，缺失即留空
 * 不用默认价或估算价填充，避免把「未知」当「便宜」
 */
function normalizeHotelPoi(raw, provider, cityName) {
  if (!raw) return null
  const name = String(raw.name || '')
  const type = String(raw.type || '')
  const text = `${name}${type}`
  if (!name || includesAny(name, STAY_NOISE)) return null
  if (!includesAny(text, STAY_HINTS) && !includesAny(type, ['住宿', '宾馆', '酒店', '旅馆', '旅舍'])) return null

  let lng
  let lat
  if (provider === 'baidu') {
    const location = raw.location || {}
    lng = Number(location.lng)
    lat = Number(location.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
    const converted = geo.bd09ToGcj02(lng, lat)
    lng = converted.lng
    lat = converted.lat
  } else {
    const parts = String(raw.location || '').split(',')
    lng = Number(parts[0])
    lat = Number(parts[1])
  }
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null

  const detail = (provider === 'baidu' ? raw.detail_info : raw.biz_ext) || {}
  const rawRating = provider === 'baidu' ? detail.overall_rating : detail.rating !== undefined && detail.rating !== '' ? detail.rating : raw.rating
  const ratingValue = Number(rawRating)
  const rating = Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null
  const priceValue = Number(provider === 'baidu' ? detail.price : detail.cost)
  const price = Number.isFinite(priceValue) && priceValue > 0 ? priceValue : null
  const stayType = detectStayType(name, type)

  return {
    id:
      provider === 'baidu'
        ? `baidu-stay-${hashText(raw.uid || text)}`
        : raw.id || `amap-stay-${hashText(text)}`,
    name,
    city: cityName,
    stayType,
    typeLabel: STAY_TYPE_LABEL[stayType],
    lng,
    lat,
    address: raw.address || '',
    rating,
    reviews: provider === 'baidu' ? Number(detail.comment_num || 0) : 0,
    price,
    priceKnown: price !== null,
    source: provider
  }
}

function normalizePoi(raw, provider, cityName) {
  return provider === 'baidu' ? normalizeBaiduPoi(raw, cityName) : normalizeAmapPoi(raw, cityName)
}

async function geocode(keyword, city, options) {
  const params = { address: keyword }
  // city 只做同名消歧，留空时交给上游按地址自行判断（地图选点常常只给地址）
  if (city) params.city = city
  const { data, meta } = await api.call('geocode', params)
  const provider = meta.provider

  if (provider === 'baidu') {
    if (data.status !== 0 || !data.result) throw api.makeError('GEOCODE_FAIL', data.message || '百度地理编码失败')
    const converted = geo.bd09ToGcj02(data.result.location.lng, data.result.location.lat)
    const comp = data.result.addressComponent || {}
    const adminCity = cleanAdminName(comp.city)
    const result = {
      name: keyword,
      city: adminCity || cleanAdminName(comp.province) || cleanAdminName(comp.district) || keyword,
      adminCity,
      adcode: cleanAdminName(comp.adcode) || cleanAdminName(comp.city_code),
      province: cleanAdminName(comp.province),
      district: cleanAdminName(comp.district),
      township: cleanAdminName(comp.town),
      lng: converted.lng,
      lat: converted.lat,
      level: data.result.level,
      source: 'baidu',
      fetchedAt: meta.fetchedAt
    }
    assertGeoResult(result, keyword, options)
    return result
  }

  if (data.status !== '1' || !data.geocodes || !data.geocodes.length) {
    throw api.makeError('GEOCODE_FAIL', data.info || '未找到该地址')
  }
  const item = data.geocodes[0]
  const [lng, lat] = item.location.split(',').map(Number)
  const adminCity = cleanAdminName(item.city)
  const result = {
    name: item.formatted_address || keyword,
    city: adminCity || cleanAdminName(item.province) || cleanAdminName(item.district) || keyword,
    adminCity,
    adcode: cleanAdminName(item.adcode),
    province: cleanAdminName(item.province),
    district: cleanAdminName(item.district),
    township: cleanAdminName(item.township),
    lng,
    lat,
    level: item.level,
    source: 'amap',
    fetchedAt: meta.fetchedAt
  }
  assertGeoResult(result, keyword, options)
  return result
}

/**
 * POI 搜索
 * @param {Object} options { cityName, adcode, center, prefs, limit, force, focusKeywords }
 * focusKeywords 用于把用户在规划页勾选的景点单独检索一次，并在结果中标记 focus
 */
async function searchPoi(options) {
  const { cityName, adcode, center, prefs = [], limit = config.limits.maxPoiCandidates } = options
  const focusKeywords = (options.focusKeywords || []).map(String).filter(Boolean).slice(0, 4)

  const queries = [{ keywords: '热门景点', types: '110000|110100|110200' }]
  prefs.slice(0, 4).forEach((pref) => {
    if (PREF_QUERY[pref]) queries.push(PREF_QUERY[pref])
  })
  // 用户勾选的景点必须进入候选池，单独查一次比依赖“热门景点”排序更可靠
  if (focusKeywords.length) queries.push({ keywords: focusKeywords.join('|') })

  const tasks = queries.map((query) => () => {
    const params = {
      keywords: query.keywords,
      city: adcode || cityName,
      citylimit: true,
      offset: 20,
      page: 1,
      extensions: 'all'
    }
    if (query.types) params.types = query.types
    return api.call('poiText', params, { force: options.force })
  })
  const results = await api.runParallel(tasks, 3)

  const merged = []
  const seen = new Set()
  let lastFetchedAt = 0
  const failures = []

  results.forEach((result) => {
    if (!result.ok || !result.value) {
      if (result.error) failures.push(result.error)
      return
    }
    const { data, meta } = result.value
    const provider = meta.provider || 'amap'
    lastFetchedAt = Math.max(lastFetchedAt, meta.fetchedAt || 0)
    const list = provider === 'baidu' ? (data.results || []) : (data.pois || [])
    if (provider === 'amap' && data.status !== '1') return
    list.forEach((raw) => {
      const poi = normalizePoi(raw, provider, cityName)
      if (!poi || !poi.name || !poi.lng || !poi.lat) return
      if (includesAny(poi.name, NOISE_WORDS)) return
      if (center && geo.haversine(center, poi) > 45000) return
      const key = poi.name.replace(/\s/g, '')
      if (seen.has(key)) return
      seen.add(key)
      merged.push(poi)
    })
  })

  if (!merged.length) {
    // 所有查询都失败时，优先暴露真实原因（限流 / 服务未开通），不要一律报“未检索到景点”
    const first = failures[0]
    if (first && first.code === 'RATE_LIMITED') {
      throw api.makeError('RATE_LIMITED', '景点检索过于频繁，请稍后再试')
    }
    if (first && first.code === 'NO_KEY') {
      throw api.makeError('NO_KEY', '景点服务暂时不可用，请稍后重试')
    }
    throw api.makeError('NO_POI', '未检索到目的地景点，请更换城市或稍后重试')
  }

  const focusSet = focusKeywords.map(normalizeName).filter(Boolean)
  merged.forEach((poi) => {
    if (focusSet.length && matchesName(poi.name, focusSet)) poi.focus = true
  })

  merged.sort(
    (a, b) =>
      (b.focus ? 1 : 0) - (a.focus ? 1 : 0) ||
      (b.rating || 0) - (a.rating || 0) ||
      (b.reviews || 0) - (a.reviews || 0)
  )
  return merged.slice(0, limit).map((poi) => ({ ...poi, fetchedAt: lastFetchedAt || Date.now() }))
}

function parsePolyline(text, maxPoints) {
  if (!text) return []
  const raw = String(text)
    .split(';')
    .map((pair) => {
      const [lng, lat] = pair.split(',').map(Number)
      return { longitude: lng, latitude: lat }
    })
    .filter((point) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude))
  if (!raw.length) return []
  const step = Math.max(1, Math.ceil(raw.length / (maxPoints || 80)))
  const sampled = raw.filter((_, index) => index % step === 0)
  const last = raw[raw.length - 1]
  if (sampled[sampled.length - 1] !== last) sampled.push(last)
  return sampled
}

function collectStepPoints(steps) {
  let points = []
  ;(steps || []).forEach((step) => {
    if (!step.polyline) return
    const parsed = parsePolyline(step.polyline)
    points = points.concat(parsed)
  })
  return points
}

function normalizeAmapRoute(raw, mode) {
  if (raw.status !== '1' || !raw.route) throw api.makeError('ROUTE_FAIL', raw.info || '高德路径规划失败')
  if (mode === 'transit') {
    const transit = raw.route.transits && raw.route.transits[0]
    if (!transit) throw api.makeError('ROUTE_FAIL', '无可用公交方案')
    let points = []
    ;(transit.segments || []).forEach((seg) => {
      if (seg.walking) points = points.concat(collectStepPoints(seg.walking.steps))
      if (seg.bus && seg.bus.buslines && seg.bus.buslines[0]) {
        points = points.concat(parsePolyline(seg.bus.buslines[0].polyline))
      }
    })
    return {
      mode,
      distance: Number(transit.distance) || 0,
      minutes: Math.max(1, Math.round((Number(transit.duration) || 0) / 60)),
      points,
      costEstimate: Number(transit.cost) || 0,
      estimated: false,
      source: 'amap'
    }
  }

  const path = raw.route.paths && raw.route.paths[0]
  if (!path) throw api.makeError('ROUTE_FAIL', '无可用路径')
  return {
    mode,
    distance: Number(path.distance) || 0,
    minutes: Math.max(1, Math.round((Number(path.duration) || 0) / 60)),
    points: collectStepPoints(path.steps),
    costEstimate: Number(path.tolls) || 0,
    estimated: false,
    source: 'amap'
  }
}

function normalizeBaiduRoute(raw, mode) {
  if (raw.status !== 0 || !raw.result || !raw.result.routes || !raw.result.routes[0]) {
    throw api.makeError('ROUTE_FAIL', raw.message || '百度路径规划失败')
  }
  const route = raw.result.routes[0]
  const points = []
  ;(route.steps || []).forEach((step) => {
    const parsed = parsePolyline(step.path)
    parsed.forEach((point) => {
      const converted = geo.bd09ToGcj02(point.longitude, point.latitude)
      points.push({ longitude: converted.lng, latitude: converted.lat })
    })
  })
  return {
    mode,
    distance: Number(route.distance) || 0,
    minutes: Math.max(1, Math.round((Number(route.duration) || 0) / 60)),
    points,
    costEstimate: 0,
    estimated: false,
    source: 'baidu'
  }
}

/**
 * 路径规划（含失败回退：估算 + 提示）
 */
async function routePlan(options) {
  const { from, to, mode, city, cityd, force } = options

  const action = mode === 'walk' ? 'routeWalking' : mode === 'transit' ? 'routeTransit' : 'routeDriving'
  const params = {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    city: cityd || city,
    cityd: cityd || city,
    strategy: 0,
    extensions: 'base'
  }

  try {
    const { data, meta } = await api.call(action, params, { force })
    const normalized =
      meta.provider === 'baidu'
        ? normalizeBaiduRoute(data, mode)
        : normalizeAmapRoute(data, mode)
    if (!normalized.points.length) normalized.points = straightPoints(from, to)
    normalized.fetchedAt = meta.fetchedAt
    normalized.cached = meta.cached
    return normalized
  } catch (err) {
    const estimate = geo.estimateLeg(from, to, mode)
    return {
      ...estimate,
      points: straightPoints(from, to),
      costEstimate: 0,
      source: 'estimate',
      fallbackReason: err.message,
      fetchedAt: Date.now()
    }
  }
}

module.exports = {
  geocode,
  searchPoi,
  routePlan,
  detectCategory,
  isOutdoor,
  parsePolyline,
  normalizeName,
  STAY_TYPE_LABEL,
  detectStayType,
  normalizeHotelPoi
}
