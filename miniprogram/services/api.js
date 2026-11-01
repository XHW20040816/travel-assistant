/**
 * 统一上游网关
 *
 * - cloud  ：调用云函数 travelApi（默认），Key 仅存在于云函数环境变量
 * - direct ：小程序直连高德/百度（仅调试，需关闭域名校验）
 *
 * 统一返回：{ data, meta: { provider, source, fetchedAt, cached } }
 */
const config = require('../config/index')
const storage = require('./storage')

const AMAP_DIRECT = {
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

function qweatherDirectUrl() {
  const settings = storage.getSettings()
  const host = String(settings.qweatherHost || config.qweatherHost || 'https://devapi.qweather.com').replace(/\/+$/, '')
  return `${host}/v7/weather/7d`
}

function ttlFor(action) {
  if (/weather/.test(action)) return config.cacheTTL.weather
  if (/route|distance/.test(action)) return config.cacheTTL.route
  if (/geocode|district/.test(action)) return config.cacheTTL.geocode
  if (/poi/.test(action)) return config.cacheTTL.poi
  return config.cacheTTL.poi
}

function cacheKey(action, params) {
  const settings = storage.getSettings()
  return `${action}_${settings.mapProvider}_${JSON.stringify(params)}`
}

/** 云开发模式下把前端加密保存的 Key 一并交给云函数校验使用 */
function buildKeyPayload() {
  const keys = storage.getSettings().keys || {}
  const out = {}
  ;['amap', 'baidu', 'qweather'].forEach((name) => {
    if (keys[name]) out[name] = keys[name]
  })
  return Object.keys(out).length ? out : null
}

function wxRequest(url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      data,
      method: 'GET',
      timeout: 10000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data)
        else reject(new Error(`HTTP ${res.statusCode}`))
      },
      fail(err) {
        reject(new Error(err.errMsg || '网络请求失败'))
      }
    })
  })
}

function buildDirectRequest(action, params) {
  const settings = storage.getSettings()
  const provider = settings.mapProvider || 'amap'
  const keys = settings.keys || {}

  // 正式版不开放直连调试，避免 Key 出现在客户端
  if (!storage.isDirectAllowed()) throw makeError('DIRECT_DISABLED', '直连模式仅在开发版 / 体验版可用，正式版请使用云开发模式')

  if (action === 'weather7d') {
    const lng = Number(params.lng)
    const lat = Number(params.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw makeError('BAD_PARAM', '坐标不合法，无法请求 7 天预报')
    }
    if (!keys.qweather) throw makeError('NO_KEY', '未配置和风天气 Key，已回退高德 4 天预报')
    return {
      url: qweatherDirectUrl(),
      data: { location: `${params.lng},${params.lat}`, key: keys.qweather, lang: 'zh' }
    }
  }

  if (provider === 'baidu') {
    // 百度 SN 签名必须用 SK 计算，而 SK 属于服务端密钥不能进入小程序包，
    // 因此百度一律走云函数 travelApi，不提供直连分支
    throw makeError('BAIDU_CLOUD_ONLY', '百度地图需在云开发模式下由云函数签名调用，请把「我的」页数据源切换为「云开发」')
  }

  const url = AMAP_DIRECT[action]
  if (!url) throw new Error(`高德地图暂不支持 ${action}`)
  if (!keys.amap) throw makeError('NO_KEY', '未配置高德 Web 服务 Key')
  return { url, data: { ...params, key: keys.amap } }
}

/** 把 cloud.callFunction 的底层错误翻译成可执行的提示 */
function describeCloudError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  const matched = msg.match(/errCode:\s*(-?\d+)/)
  const errCode = matched ? matched[1] : ''
  if (/timeout|-504003|timed out/i.test(msg)) {
    return { code: 'CLOUD_TIMEOUT', message: '云函数调用超时：请在云开发控制台把 travelApi 超时时间调大（建议 60 秒）' }
  }
  if (msg.indexOf('-601034') >= 0 || /cloud.*(not.*open|未开通)/i.test(msg)) {
    return { code: 'CLOUD_NOT_OPEN', message: '云开发未开通：请在开发者工具中开通云开发并创建环境' }
  }
  if (msg.indexOf('-604100') >= 0 || /env.*(not exist|invalid)|环境.*不存在|环境\s*ID/i.test(msg)) {
    return { code: 'CLOUD_ENV_INVALID', message: '云环境不可用：请检查「我的」页云环境 ID 是否正确' }
  }
  if (msg.indexOf('-501000') >= 0 || /FunctionName|function not found|不存在/i.test(msg)) {
    return { code: 'CLOUD_FN_MISSING', message: '云函数未部署或依赖缺失：请重新上传并部署 travelApi（勾选云端安装依赖）' }
  }
  if (/cloud\.init|not initialized|未初始化|Cloud API isn't enabled/i.test(msg)) {
    return { code: 'CLOUD_NOT_INIT', message: '云开发未初始化：请把数据源切回「云开发」后重启小程序' }
  }
  if (/-501001|resource system error|资源/i.test(msg)) {
    return { code: 'CLOUD_RESOURCE', message: '云函数资源异常：请稍后重试，或在控制台查看函数日志' }
  }
  const brief = msg.replace(/^cloud\.callFunction:fail\s*/i, '').slice(0, 90)
  return { code: 'CLOUD_FAIL', message: `云函数调用失败${errCode ? `（${errCode}）` : ''}${brief ? `：${brief}` : ''}` }
}

function makeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 调用上游（带本地缓存）
 * @param {String} action geocode | poiText | poiAround | weather | routeDriving | routeWalking | routeTransit | distance
 * @param {Object} params
 * @param {Object} options { force }
 */
async function call(action, params, options) {
  const settings = storage.getSettings()
  const mode = settings.dataSource || 'cloud'
  const force = !!(options && options.force)
  const key = cacheKey(action, params)

  if (!force) {
    const cached = storage.cacheRead(key)
    if (cached) {
      return {
        data: cached.data,
        meta: {
          provider: action === 'weather7d' ? 'qweather' : settings.mapProvider,
          source: mode,
          fetchedAt: cached.fetchedAt,
          cached: true
        }
      }
    }
  }

  let result
  if (mode === 'cloud') {
    if (!wx.cloud) throw makeError('NO_CLOUD', '当前环境不支持云开发')
    let res
    try {
      const keyPayload = buildKeyPayload()
      res = await wx.cloud.callFunction({
        name: settings.cloudFn || config.cloudFn,
        data: Object.assign(
          { action, params, provider: settings.mapProvider, force },
          keyPayload ? { keys: keyPayload } : {}
        )
      })
    } catch (err) {
      console.warn('[cloud] callFunction 失败', err)
      const info = describeCloudError(err)
      throw makeError(info.code, info.message)
    }
    result = res && res.result
    if (!result || result.ok === false) {
      throw makeError(result ? result.code : 'CLOUD_FAIL', (result && result.message) || '云函数调用失败')
    }
  } else if (mode === 'direct') {
    const req = buildDirectRequest(action, params)
    const raw = await wxRequest(req.url, req.data)
    result = { ok: true, data: raw }
  } else {
    throw makeError('BAD_SOURCE', '数据源配置异常，请到「我的」重新选择')
  }

  const payload = result.data
  const ttl = result.ttl || ttlFor(action)
  storage.cacheWrite(key, payload, ttl)

  return {
    data: payload,
    meta: {
      provider: action === 'weather7d' ? 'qweather' : result.provider || settings.mapProvider,
      source: mode,
      fetchedAt: result.fetchedAt || Date.now(),
      cached: false
    }
  }
}

/** 简单并发限制执行器 */
async function runParallel(tasks, limit) {
  const results = new Array(tasks.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const index = cursor++
      try {
        results[index] = { ok: true, value: await tasks[index]() }
      } catch (err) {
        results[index] = { ok: false, error: err }
      }
    }
  })
  await Promise.all(workers)
  return results
}

let capsCache = null
let capsFetchedAt = 0
const CAPS_TTL = 10 * 60 * 1000

/**
 * 探测可用上游能力
 * - cloud 模式：由云函数读取环境变量并返回布尔值，Key 不出云端
 * - direct 模式：使用本机 Key
 * @param {Object} options { force }
 */
async function getCapabilities(options) {
  const force = !!(options && options.force)
  if (!force && capsCache && Date.now() - capsFetchedAt < CAPS_TTL) return capsCache

  const settings = storage.getSettings()
  const mode = settings.dataSource || 'cloud'
  const keys = settings.keys || {}
  const caps = {
    source: mode,
    provider: settings.mapProvider || 'amap',
    amap: !!keys.amap,
    baidu: !!keys.baidu,
    qweather: !!keys.qweather
  }

  if (mode === 'cloud' && wx.cloud) {
    try {
      const keyPayload = buildKeyPayload()
      const res = await wx.cloud.callFunction({
        name: settings.cloudFn || config.cloudFn,
        data: Object.assign({ action: 'capabilities' }, keyPayload ? { keys: keyPayload } : {})
      })
      const result = res && res.result
      if (result && result.ok && result.data) {
        caps.amap = !!result.data.amap
        caps.baidu = !!result.data.baidu
        caps.qweather = !!result.data.qweather
        caps.baiduSn = !!result.data.baiduSn
        caps.defaultProvider = result.data.defaultProvider
        caps.missing = result.data.missing || []
      }
    } catch (err) {
      console.warn('[capabilities] 云端探测失败', err && err.message)
    }
  }

  capsCache = caps
  capsFetchedAt = Date.now()
  return caps
}

module.exports = {
  call,
  makeError,
  runParallel,
  ttlFor,
  getCapabilities
}
