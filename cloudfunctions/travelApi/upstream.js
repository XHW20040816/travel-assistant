/**
 * 上游请求构建与校验（纯逻辑，不依赖微信云环境，便于本地测试）
 *
 * 支持动作：
 *   geocode / poiText / poiAround / district / weather / weather7d /
 *   routeDriving / routeWalking / routeTransit / distance / capabilities
 */
const https = require('https')
const crypto = require('crypto')

const AMAP_ENDPOINTS = {
  geocode: 'https://restapi.amap.com/v3/geocode/geo',
  poiText: 'https://restapi.amap.com/v3/place/text',
  poiAround: 'https://restapi.amap.com/v3/place/around',
  district: 'https://restapi.amap.com/v3/config/district',
  weather: 'https://restapi.amap.com/v3/weather/weatherInfo',
  routeDriving: 'https://restapi.amap.com/v3/direction/driving',
  routeWalking: 'https://restapi.amap.com/v3/direction/walking',
  routeTransit: 'https://restapi.amap.com/v3/direction/transit/integrated',
  distance: 'https://restapi.amap.com/v3/distance'
}

const BAIDU_ENDPOINTS = {
  geocode: 'https://api.map.baidu.com/geocoding/v3/',
  poiText: 'https://api.map.baidu.com/place/v2/search',
  weather: 'https://api.map.baidu.com/weather/v1/',
  routeDriving: 'https://api.map.baidu.com/directionlite/v1/driving',
  routeWalking: 'https://api.map.baidu.com/directionlite/v1/walking'
}

const QWEATHER_7D_DEFAULT_HOST = 'https://devapi.qweather.com'

function qweatherUrl(env) {
  const host = String(env.QWEATHER_HOST || QWEATHER_7D_DEFAULT_HOST).replace(/\/+$/, '')
  return `${host}/v7/weather/7d`
}

// 白名单：避免把其它地图商的专有参数透传给上游
const AMAP_FIELDS = {
  geocode: ['address', 'city', 'batch', 'output'],
  poiText: ['keywords', 'types', 'city', 'citylimit', 'offset', 'page', 'extensions', 'children'],
  poiAround: ['location', 'keywords', 'types', 'radius', 'offset', 'page', 'extensions', 'sortrule', 'citylimit'],
  district: ['keywords', 'subdistrict', 'extensions', 'level', 'city'],
  weather: ['city', 'extensions', 'type'],
  routeDriving: ['origin', 'destination', 'strategy', 'waypoints', 'avoidpolygons', 'avoidroad', 'extensions', 'nosteps', 'taxi', 'cartype'],
  routeWalking: ['origin', 'destination', 'extensions'],
  routeTransit: ['origin', 'destination', 'city', 'cityd', 'strategy', 'nightflag', 'date', 'time', 'extensions', 'multipath'],
  distance: ['origins', 'destination', 'type', 'strategy', 'extensions']
}

const BAIDU_FIELDS = {
  geocode: ['address', 'city', 'ret_coordtype'],
  poiText: ['region', 'scope', 'page_size', 'page_num', 'filter', 'tag'],
  weather: ['district_id', 'data_type', 'coordtype'],
  routeDriving: ['origin', 'destination', 'waypoints', 'coord_type', 'ret_coordtype', 'steps_info', 'alternatives'],
  routeWalking: ['origin', 'destination', 'coord_type']
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function pick(source, fields) {
  const out = {}
  fields.forEach((key) => {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') out[key] = source[key]
  })
  return out
}

/** GCJ02 → BD09：百度路径规划要求 BD09 且顺序为「纬度,经度」 */
function gcj02ToBd09(lng, lat) {
  const xPi = (Math.PI * 3000) / 180
  const x = Number(lng)
  const y = Number(lat)
  const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * xPi)
  const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * xPi)
  return { lng: z * Math.cos(theta) + 0.0065, lat: z * Math.sin(theta) + 0.006 }
}

function checkPoint(lng, lat, label) {
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw fail('BAD_PARAM', `坐标不合法：${label || `${lng},${lat}`}`)
  }
  return { lng, lat }
}

function checkPointText(text, label) {
  const [lng, lat] = String(text || '').split(',').map(Number)
  return checkPoint(lng, lat, label || text)
}

/** 校验高德参数中的坐标字段，非法坐标不发起上游请求 */
function assertPoints(params) {
  ;['origin', 'destination', 'location'].forEach((key) => {
    if (params[key] !== undefined && params[key] !== '') checkPointText(params[key], key)
  })
  ;['origins', 'waypoints'].forEach((key) => {
    if (!params[key]) return
    String(params[key])
      .split('|')
      .forEach((part) => checkPointText(part, key))
  })
}

function toBaiduPoint(text) {
  const point = checkPointText(text, 'origin/destination')
  const converted = gcj02ToBd09(point.lng, point.lat)
  return `${converted.lat},${converted.lng}`
}

function capabilities(env) {
  const config = env || {}
  const caps = {
    amap: !!config.AMAP_KEY,
    baidu: !!config.BAIDU_AK,
    baiduSn: !!config.BAIDU_SK,
    qweather: !!config.QWEATHER_KEY,
    defaultProvider: config.MAP_PROVIDER || 'amap',
    missing: []
  }
  if (!caps.amap) caps.missing.push('AMAP_KEY')
  if (!caps.baidu) caps.missing.push('BAIDU_AK')
  if (!caps.qweather) caps.missing.push('QWEATHER_KEY')
  return caps
}

/** RFC3986 编码：encodeURIComponent 不会转义 !'()*，签名要求一并编码 */
function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * 百度 SN 签名（SK 只存在于云函数环境变量，绝不能下发到客户端）
 * 1. 参数按 key 字典序排序，value 做 RFC3986 编码后拼成 key=value&...
 * 2. 拼上接口路径（如 /geocoding/v3/）得到 /path?query
 * 3. 对整个 /path?query 再做 RFC3986 编码，末尾拼接 SK
 * 4. MD5 取 32 位小写
 * 注意：timestamp 必须先加入参数集合再参与排序签名
 */
function baiduSign(urlPath, query, sk) {
  const queryText = Object.keys(query || {})
    .sort()
    .map((key) => `${key}=${rfc3986(query[key])}`)
    .join('&')
  const full = rfc3986(`${urlPath}?${queryText}`)
  return crypto
    .createHash('md5')
    .update(`${full}${sk}`, 'utf8')
    .digest('hex')
}

function buildAmap(action, params, env) {
  const key = env.AMAP_KEY
  if (!key) throw fail('NO_KEY', '未配置高德 Key：请先在「我的」中绑定导航 API Key')
  const url = AMAP_ENDPOINTS[action]
  if (!url) throw fail('NO_ACTION', `高德暂不支持 ${action}`)
  const fields = AMAP_FIELDS[action] || []
  const picked = pick(params, fields)
  assertPoints(picked)
  return { url, params: { ...picked, key }, provider: 'amap' }
}

function buildBaidu(action, params, env) {
  const ak = env.BAIDU_AK
  if (!ak) throw fail('NO_KEY', '未配置百度 Key：请先在「我的」中绑定导航 API Key')
  const url = BAIDU_ENDPOINTS[action]
  if (!url) throw fail('NO_ACTION', `百度地图暂不支持 ${action}`)

  const query = pick(params, BAIDU_FIELDS[action] || [])
  query.ak = ak
  query.output = 'json'

  if (action === 'geocode') {
    if (!query.address) throw fail('BAD_PARAM', '地理编码缺少 address 参数')
  }

  if (action === 'poiText') {
    if (!params.keywords) throw fail('BAD_PARAM', 'POI 检索缺少 keywords 参数')
    query.query = params.keywords
    query.region = params.city
    query.scope = '2'
    query.page_size = Math.min(20, Math.max(1, Number(params.offset) || 20))
    query.page_num = Math.max(1, Number(params.page) || 1)
  }

  if (action === 'weather') {
    query.district_id = params.city
    query.data_type = 'all'
  }

  if (action === 'routeDriving' || action === 'routeWalking') {
    query.origin = toBaiduPoint(params.origin)
    query.destination = toBaiduPoint(params.destination)
    if (query.waypoints) query.waypoints = String(query.waypoints).split('|').map(toBaiduPoint).join('|')
    delete query.coord_type
  }

  // 控制台开启 SN 校验时必须带 timestamp 与 sn；SK 只来自云函数环境变量
  const sk = String(env.BAIDU_SK || '').trim()
  if (sk) {
    query.timestamp = String(Math.floor(Date.now() / 1000))
    const path = new URL(url).pathname
    query.sn = baiduSign(path, query, sk)
  }

  return { url, params: query, provider: 'baidu' }
}

function buildQWeather(params, env) {
  const key = env.QWEATHER_KEY
  if (!key) throw fail('NO_KEY', '未配置和风天气 Key：请先在「我的」中绑定天气 API Key')
  if (!params.lng || !params.lat) throw fail('BAD_PARAM', '7 天预报缺少经纬度')
  const point = checkPoint(Number(params.lng), Number(params.lat), 'weather7d')
  return {
    url: qweatherUrl(env),
    params: { location: `${point.lng.toFixed(2)},${point.lat.toFixed(2)}`, key, lang: 'zh' },
    provider: 'qweather'
  }
}

/**
 * 生成上游请求
 * @param {String} provider amap | baidu
 * @param {String} action 见文件头
 * @param {Object} params 客户端传入参数
 * @param {Object} env 进程环境变量
 */
function buildRequest(provider, action, params, env) {
  if (action === 'weather7d') return buildQWeather(params || {}, env)
  if (provider === 'baidu') return buildBaidu(action, params || {}, env)
  return buildAmap(action, params || {}, env)
}

/** 统一校验上游响应，失败抛错（带 code） */
function validate(provider, action, data) {
  if (action === 'weather7d' || provider === 'qweather') {
    if (!data || String(data.code) !== '200') {
      throw fail(`QWEATHER_${data ? data.code : 'EMPTY'}`, '和风天气请求失败，请检查 Key、配额或坐标')
    }
    return data
  }
  if (provider === 'baidu') {
    if (!data || data.status !== 0) {
      const message = (data && data.message) || ''
      // 百度原始报错按类型映射，便于定位是 SN、AK、权限还是配额问题
      if (/SN/i.test(message)) {
        throw fail('BAIDU_SN', '百度 SN 校验失败：请确认「我的」中百度 AK 与 SK 匹配，且服务器时间同步')
      }
      if (/AK/i.test(message) && /非法|不存在|错误|不正确/i.test(message)) {
        throw fail('BAIDU_AK_INVALID', '百度 AK 无效：请在「我的」中重新填写导航 API Key')
      }
      if (/白名单|权限|禁用|referer|Referer/i.test(message)) {
        throw fail('BAIDU_PERMISSION', '百度 AK 权限或白名单受限：请检查控制台 IP 白名单与 SN 设置')
      }
      if (/配额|限制|quota|超限/i.test(message)) {
        throw fail('BAIDU_QUOTA', '百度地图配额已用尽：请稍后重试或在控制台提升配额')
      }
      throw fail('BAIDU_FAIL', message || `百度 ${action} 请求失败`)
    }
    return data
  }
  if (!data || data.status !== '1') {
    const code = data ? data.infocode || 'AMAP_FAIL' : 'EMPTY'
    if (code === 'USERKEY_PLAT_NOMATCH') {
      throw fail('KEY_PLAT_MISMATCH', '高德 Key 平台类型不匹配，请改用「Web服务」类型的 Key')
    }
    throw fail(code, (data && data.info) || `高德 ${action} 请求失败`)
  }
  return data
}

function ttlFor(action) {
  if (/weather/.test(action)) return 30 * 60 * 1000
  if (/route|distance/.test(action)) return 10 * 60 * 1000
  if (/geocode|district/.test(action)) return 30 * 24 * 3600 * 1000
  return 7 * 24 * 3600 * 1000
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

function cacheKey(provider, action, params) {
  const raw = `${provider}|${action}|${stableStringify(params || {})}`
  return crypto.createHash('md5').update(raw).digest('hex')
}

function fetchJson(url, params) {
  return new Promise((resolve, reject) => {
    const query = Object.keys(params || {})
      .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
      .map((key) => `${rfc3986(key)}=${rfc3986(params[key])}`)
      .join('&')
    const full = query ? `${url}?${query}` : url

    const req = https.get(full, { timeout: 12000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(fail(`HTTP_${res.statusCode}`, `上游 HTTP ${res.statusCode}：${body.slice(0, 100)}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(fail('BAD_RESPONSE', `上游返回无法解析：${body.slice(0, 100)}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(fail('TIMEOUT', '上游请求超时')))
    req.on('error', (err) => reject(fail('NETWORK', err.message || '网络请求失败')))
  })
}

module.exports = {
  AMAP_ENDPOINTS,
  BAIDU_ENDPOINTS,
  capabilities,
  buildRequest,
  validate,
  ttlFor,
  cacheKey,
  fetchJson,
  fail,
  gcj02ToBd09,
  rfc3986,
  baiduSign
}
