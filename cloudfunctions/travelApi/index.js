/**
 * travelApi 云函数：代理高德 / 百度 / 和风天气
 *
 * 调用方式（小程序端）：
 *   wx.cloud.callFunction({
 *     name: 'travelApi',
 *     data: { action, params, provider, force, keys }
 *   })
 *
 * Key 来源（优先级从高到低）：
 *   1. keys: { amap, baidu, qweather } —— 小程序「我的」页前端配置（本机加密存储）
 *   2. 云函数环境变量 AMAP_KEY / BAIDU_AK / QWEATHER_KEY
 *
 * 云函数环境变量（控制台 - 函数配置，可选）：
 *   AMAP_KEY       高德 Web 服务 Key
 *   BAIDU_AK       百度地图服务端 AK
 *   BAIDU_SK       百度地图服务端 SK（控制台开启 SN 校验时必填，只存云端）
 *   QWEATHER_KEY   和风天气 Key（可选，用于 7 天预报）
 *   QWEATHER_HOST  和风 API Host（可选，默认 https://devapi.qweather.com）
 *   MAP_PROVIDER   默认地图商 amap | baidu（可选）
 *   INTERNAL_TOKEN 云函数间调用令牌（可选），定时任务调用时必须与之一致
 *
 * 安全策略：
 *   1. 仅接受小程序调用（cloud.getWXContext().OPENID），capabilities 豁免便于控制台自测
 *   2. action 白名单，避免任意代理
 *   3. params 仅允许扁平对象：键数 ≤ 12、字符串 ≤ 200 字符、序列化 ≤ 2000 字节
 *   4. 按 OPENID + action 做 60 秒滑动窗口限流（默认 20 次/分钟），计数存 travel_cache
 *   5. 错误脱敏：非安全错误码统一返回 UPSTREAM_FAIL，不暴露上游原始信息
 *
 * 支持 action：
 *   capabilities / geocode / poiText / poiAround / district / weather /
 *   weather7d / routeDriving / routeWalking / routeTransit / distance
 *
 * 统一返回：
 *   成功 { ok: true, data, provider, action, fetchedAt, ttl, cached }
 *   失败 { ok: false, code, message }
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const upstream = require('./upstream')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'travel_cache'

const ALLOWED_ACTIONS = [
  'capabilities',
  'geocode',
  'poiText',
  'poiAround',
  'district',
  'weather',
  'weather7d',
  'routeDriving',
  'routeWalking',
  'routeTransit',
  'distance'
]

const PROVIDERS = ['amap', 'baidu']

// 对外只返回脱敏 code 与通用文案，原始错误细节仅保留在服务端日志
const PUBLIC_MSG = {
  NO_OPENID: '仅小程序内可调用该接口',
  BAD_REQUEST: '请求参数不完整',
  BAD_ACTION: '不支持的接口',
  BAD_PARAM: '参数格式不正确',
  FORBIDDEN: '无调用权限',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  NO_KEY: '服务暂未配置该能力',
  KEY_PLAT_MISMATCH: '高德 Key 平台类型不匹配，请改用「Web服务」类型的 Key',
  BAIDU_SN: '百度 SN 校验失败：请确认云函数 BAIDU_SK 与 AK 匹配，且服务器时间同步',
  BAIDU_AK_INVALID: '百度 AK 无效：请检查「我的」页 AK 或 BAIDU_AK 环境变量',
  BAIDU_PERMISSION: '百度 AK 权限或白名单受限：请检查控制台 IP 白名单与 SN 设置',
  BAIDU_QUOTA: '百度地图配额已用尽：请稍后重试或在控制台提升配额',
  BAIDU_FAIL: '百度地图请求失败，请检查 AK/SK、SN 签名或配额',
  NO_ACTION: '不支持的接口',
  TIMEOUT: '请求超时，请稍后重试',
  UPSTREAM_FAIL: '地图服务暂时不可用，请稍后重试'
}

const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX_HITS = 20
const PARAM_MAX_KEYS = 12
const PARAM_MAX_STRING = 200
const PARAM_MAX_BYTES = 2000
const KEY_MAX_LEN = 200

/** 前端传入的 Key：仅接受字符串，长度受限，不写入日志 */
function assertKeys(event) {
  const raw = event && event.keys
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw upstream.fail('BAD_PARAM', 'keys 参数格式不正确')
  }
  const out = {}
  ;['amap', 'baidu', 'qweather'].forEach((name) => {
    const value = raw[name]
    if (value === undefined || value === null || value === '') return
    if (typeof value !== 'string') throw upstream.fail('BAD_PARAM', `keys.${name} 格式不正确`)
    const text = value.trim()
    if (!text) return
    if (text.length > KEY_MAX_LEN) throw upstream.fail('BAD_PARAM', `keys.${name} 长度异常`)
    if (!/^[A-Za-z0-9._-]+$/.test(text)) throw upstream.fail('BAD_PARAM', `keys.${name} 含非法字符`)
    out[name] = text
  })
  return out
}

/** 前端 Key 优先，缺失时回退云函数环境变量（定时任务仍可用环境变量） */
function buildUpstreamEnv(clientKeys) {
  return {
    AMAP_KEY: clientKeys.amap || process.env.AMAP_KEY || '',
    BAIDU_AK: clientKeys.baidu || process.env.BAIDU_AK || '',
    // SK 只从云函数环境变量读取，绝不接受前端传入
    BAIDU_SK: process.env.BAIDU_SK || '',
    QWEATHER_KEY: clientKeys.qweather || process.env.QWEATHER_KEY || '',
    QWEATHER_HOST: process.env.QWEATHER_HOST,
    MAP_PROVIDER: process.env.MAP_PROVIDER
  }
}

/** 审计：只记录 Key 来源与脱敏 OPENID，不记录 Key 内容 */
function auditKeys(action, openid, clientKeys, env) {
  const sourceOf = (name, value) => (!value ? 'none' : clientKeys[name] === value ? 'client' : 'env')
  console.log(
    '[audit]',
    JSON.stringify({
      fn: 'travelApi',
      action,
      openid: openid ? crypto.createHash('md5').update(openid).digest('hex').slice(0, 12) : 'anonymous',
      amap: sourceOf('amap', env.AMAP_KEY),
      baidu: sourceOf('baidu', env.BAIDU_AK),
      baiduSn: env.BAIDU_SK ? 'env' : 'none',
      qweather: sourceOf('qweather', env.QWEATHER_KEY)
    })
  )
}

let collectionReady = false
async function ensureCollection() {
  if (collectionReady) return
  collectionReady = true
  try {
    await db.createCollection(COLLECTION)
  } catch (err) {
    // 集合已存在或当前环境不允许创建，忽略；后续读写失败会回退到直连上游
  }
}

async function cacheGet(key) {
  try {
    const res = await db.collection(COLLECTION).doc(key).get()
    const doc = res.data
    if (!doc || !doc.expireAt || Date.now() >= doc.expireAt) return null
    return doc
  } catch (err) {
    return null
  }
}

async function cacheSet(key, payload, ttl, meta) {
  await ensureCollection()
  try {
    await db.collection(COLLECTION).doc(key).set({
      data: {
        payload,
        ttl,
        action: meta.action,
        provider: meta.provider,
        fetchedAt: meta.fetchedAt,
        expireAt: meta.fetchedAt + ttl
      }
    })
  } catch (err) {
    console.warn('[travelApi] 缓存写入失败', err && err.message)
  }
}

/** 云函数间调用（定时任务）凭 INTERNAL_TOKEN 放行 */
function isInternalCall(event) {
  const token = process.env.INTERNAL_TOKEN
  if (!token) return false
  const provided = event && event.internalToken
  return !!provided && String(provided) === token
}

function assertParams(params) {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw upstream.fail('BAD_PARAM', 'params 必须为对象')
  }
  const keys = Object.keys(params)
  if (keys.length > PARAM_MAX_KEYS) {
    throw upstream.fail('BAD_PARAM', `参数数量超限（最多 ${PARAM_MAX_KEYS} 个）`)
  }
  keys.forEach((key) => {
    const value = params[key]
    const type = typeof value
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw upstream.fail('BAD_PARAM', `参数 ${key} 仅支持字符串、数字或布尔值`)
    }
    if (type === 'string' && value.length > PARAM_MAX_STRING) {
      throw upstream.fail('BAD_PARAM', `参数 ${key} 内容过长`)
    }
    if (type === 'number' && !Number.isFinite(value)) {
      throw upstream.fail('BAD_PARAM', `参数 ${key} 不是有效数字`)
    }
  })
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > PARAM_MAX_BYTES) {
    throw upstream.fail('BAD_PARAM', '参数体积超限')
  }
  return params
}

function rateDocId(openid, action) {
  return `rl_${crypto.createHash('md5').update(`${openid}|${action}`).digest('hex')}`
}

async function readRateDoc(id) {
  try {
    const res = await db.collection(COLLECTION).doc(id).get()
    return res.data || null
  } catch (err) {
    return null
  }
}

function filterHits(doc, now) {
  return ((doc && doc.hits) || [])
    .map(Number)
    .filter((stamp) => Number.isFinite(stamp) && now - stamp < RATE_WINDOW_MS)
}

/**
 * 60 秒滑动窗口限流：计数存 travel_cache，事务内裁剪旧计数并写回
 * 返回 true 表示已超限（本次请求应被拒绝）
 * 计数读写异常时按 fail-closed 拒绝，避免数据库故障期间限流被绕过
 */
async function hitRateLimit(openid, action) {
  const now = Date.now()
  const id = rateDocId(openid, action)
  try {
    await ensureCollection()
    // 事务内的 get 对不存在的文档会报错，先在事务外判断是否存在
    const existing = await readRateDoc(id)
    const result = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(COLLECTION).doc(id)
      let doc = existing
      if (existing) {
        try {
          doc = (await ref.get()).data || existing
        } catch (err) {
          doc = existing
        }
      }
      const hits = filterHits(doc, now)
      hits.push(now)

      if (hits.length > RATE_MAX_HITS) {
        // 超限后继续记录时间戳，持续高频调用会一直被拒绝，停止 60 秒后自动恢复
        await ref.update({ data: { hits: hits.slice(-RATE_MAX_HITS - 1), updatedAt: now } })
        return true
      }

      const data = { hits, action, updatedAt: now, expireAt: now + RATE_WINDOW_MS }
      if (existing) await ref.update({ data })
      else await ref.set({ data })
      return false
    })
    // 兼容不同 SDK 版本：可能返回布尔值，也可能包一层 result
    return result === true || !!(result && result.result === true)
  } catch (err) {
    console.warn('[travelApi] 限流计数失败，本次拒绝', err && err.message)
    return true
  }
}

function sanitizeError(err) {
  const code = (err && err.code) || 'UPSTREAM_FAIL'
  if (PUBLIC_MSG[code]) return { ok: false, code, message: PUBLIC_MSG[code] }
  return { ok: false, code: 'UPSTREAM_FAIL', message: PUBLIC_MSG.UPSTREAM_FAIL }
}

exports.main = async (event) => {
  const action = event && event.action
  const internal = isInternalCall(event)
  let openid = ''
  let baiduSkReady = false
  try {
    openid = (cloud.getWXContext() || {}).OPENID || ''
  } catch (err) {
    openid = ''
  }

  try {
    if (!action) throw upstream.fail('BAD_REQUEST', '缺少 action 参数')
    if (ALLOWED_ACTIONS.indexOf(action) < 0) throw upstream.fail('BAD_ACTION', '不支持的接口')

    // capabilities 仅返回能力布尔值，允许控制台无 OPENID 自测
    const allowAnonymous = action === 'capabilities'
    if (!openid && !internal && !allowAnonymous) {
      throw upstream.fail('NO_OPENID', '仅小程序内可调用该接口')
    }

    const params = assertParams(event && event.params)
    // 多用户公开部署时可设 ALLOW_CLIENT_KEYS=0，只允许云端环境变量 Key
    const allowClientKeys = process.env.ALLOW_CLIENT_KEYS !== '0'
    const clientKeys = allowClientKeys ? assertKeys(event) : {}
    const upstreamEnv = buildUpstreamEnv(clientKeys)
    baiduSkReady = !!upstreamEnv.BAIDU_SK
    auditKeys(action, openid, clientKeys, upstreamEnv)

    const provider = (event && event.provider) || upstreamEnv.MAP_PROVIDER || 'amap'
    if (action !== 'weather7d' && PROVIDERS.indexOf(provider) < 0) {
      throw upstream.fail('BAD_PARAM', '不支持的地图供应商')
    }
    const force = !!(event && event.force)

    if (openid) {
      const limited = await hitRateLimit(openid, action)
      if (limited) throw upstream.fail('RATE_LIMITED', '请求过于频繁，请稍后再试')
    }

    if (action === 'capabilities') {
      return { ok: true, data: upstream.capabilities(upstreamEnv), action }
    }

    const cacheProvider = action === 'weather7d' ? 'qweather' : provider
    const key = upstream.cacheKey(cacheProvider, action, params)
    const hit = force ? null : await cacheGet(key)
    if (hit) {
      return {
        ok: true,
        data: hit.payload,
        provider: hit.provider,
        action,
        fetchedAt: hit.fetchedAt,
        ttl: hit.ttl,
        cached: true
      }
    }

    const request = upstream.buildRequest(provider, action, params, upstreamEnv)
    const data = upstream.validate(request.provider, action, await upstream.fetchJson(request.url, request.params))

    const fetchedAt = Date.now()
    const ttl = upstream.ttlFor(action)
    await cacheSet(key, data, ttl, { action, provider: request.provider, fetchedAt })

    return {
      ok: true,
      data,
      provider: request.provider,
      action,
      fetchedAt,
      ttl,
      cached: false
    }
  } catch (err) {
    console.warn('[travelApi]', action, err && err.code, err && err.message)
    // SN 失败时直接告诉前端云端是否读到 BAIDU_SK，避免只看到百度的原始 211 报错
    if (err && err.code === 'BAIDU_SN') {
      const hint = baiduSkReady
        ? '云端已读取 BAIDU_SK：请确认该 SK 与请求所用 AK 属于同一应用、AK 校验方式为 SN，并核对控制台 SK 是否完整'
        : '云端未读取到 BAIDU_SK：请在云开发控制台 → 云函数 travelApi → 配置 → 环境变量 添加 BAIDU_SK 后保存，并重新部署函数'
      return { ok: false, code: 'BAIDU_SN', message: `百度 SN 校验失败（211）。${hint}` }
    }
    return sanitizeError(err)
  }
}
