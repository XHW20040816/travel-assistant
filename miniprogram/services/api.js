/**
 * 统一上游网关
 *
 * 仅支持云开发：调用云函数 travelApi；
 * Key 由用户在「我的」页自行绑定，本机加密保存，随请求附带，仅用于本次上游调用。
 *
 * 统一返回：{ data, meta: { provider, source, fetchedAt, cached } }
 */
const config = require('../config/index')
const storage = require('./storage')

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

/** 把用户在本机加密保存的 Key 一并交给云函数，仅用于本次请求 */
function buildKeyPayload() {
  const keys = storage.getSettings().keys || {}
  const out = {}
  ;['amap', 'baidu', 'baiduSk', 'qweather'].forEach((name) => {
    if (keys[name]) out[name] = keys[name]
  })
  return Object.keys(out).length ? out : null
}

/** 把 cloud.callFunction 的底层错误翻译成可执行的提示 */
function describeCloudError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  if (/timeout|-504003|timed out/i.test(msg)) {
    return { code: 'CLOUD_TIMEOUT', message: '服务响应超时，请稍后重试' }
  }
  if (msg.indexOf('-601034') >= 0 || /cloud.*(not.*open|未开通)/i.test(msg)) {
    return { code: 'CLOUD_NOT_OPEN', message: '服务暂未开通，请稍后重试' }
  }
  if (msg.indexOf('-604100') >= 0 || /env.*(not exist|invalid)|环境.*不存在|环境\s*ID/i.test(msg)) {
    return { code: 'CLOUD_ENV_INVALID', message: '服务配置异常，请稍后重试' }
  }
  if (msg.indexOf('-501000') >= 0 || /FunctionName|function not found|不存在/i.test(msg)) {
    return { code: 'CLOUD_FN_MISSING', message: '服务暂不可用，请稍后重试' }
  }
  if (/cloud\.init|not initialized|未初始化|Cloud API isn't enabled/i.test(msg)) {
    return { code: 'CLOUD_NOT_INIT', message: '服务初始化失败，请重启小程序后重试' }
  }
  if (/-501001|resource system error|资源/i.test(msg)) {
    return { code: 'CLOUD_RESOURCE', message: '服务繁忙，请稍后重试' }
  }
  return { code: 'CLOUD_FAIL', message: '服务暂时不可用，请稍后重试' }
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
  const force = !!(options && options.force)
  const key = cacheKey(action, params)

  if (!force) {
    const cached = storage.cacheRead(key)
    if (cached) {
      return {
        data: cached.data,
        meta: {
          provider: cached.provider || (action === 'weather7d' ? 'qweather' : 'amap'),
          source: 'cloud',
          fetchedAt: cached.fetchedAt,
          cached: true
        }
      }
    }
  }

  if (!wx.cloud) throw makeError('NO_CLOUD', '当前环境不支持云开发')
  const keyPayload = buildKeyPayload()
  let res
  try {
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
  const result = res && res.result
  if (!result || result.ok === false) {
    throw makeError(result ? result.code : 'CLOUD_FAIL', (result && result.message) || '云函数调用失败')
  }

  const payload = result.data
  const ttl = result.ttl || ttlFor(action)
  const provider = action === 'weather7d' ? 'qweather' : result.provider || 'amap'
  storage.cacheWrite(key, payload, ttl, provider)

  return {
    data: payload,
    meta: {
      provider,
      source: 'cloud',
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
 * 探测可用的上游能力：用本机保存的 Key 请求云函数，返回布尔值
 * @param {Object} options { force }
 */
async function getCapabilities(options) {
  const force = !!(options && options.force)
  if (!force && capsCache && Date.now() - capsFetchedAt < CAPS_TTL) return capsCache

  const settings = storage.getSettings()
  const keys = settings.keys || {}
  const caps = {
    source: 'cloud',
    provider: settings.mapProvider || 'amap',
    amap: !!keys.amap,
    baidu: !!keys.baidu,
    qweather: !!keys.qweather,
    baiduSn: !!keys.baiduSk
  }

  if (wx.cloud) {
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
        if (result.data.defaultProvider) caps.provider = result.data.defaultProvider
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
