/**
 * guideProxy 云函数：DeepSeek 生成攻略速览 + 平台真实搜索入口
 *
 * 小程序内不抓取小红书/抖音等站内内容：AI 只输出通用参考总结，
 * 条目链接为对应平台的搜索页，用户复制后在浏览器或 App 查看真实内容。
 *
 * Key 来源：用户在小程序「我的」页绑定自己的大模型 Key，
 * 随请求传入 event.llm；云函数不使用运营者的环境变量 Key。
 * INTERNAL_TOKEN 仅供云函数间调用，此时才回落到 DEEPSEEK_API_KEY。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY    仅内部调用兜底（可选）
 *   DEEPSEEK_BASE_URL    可选，默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL       内部调用默认模型（可选）
 *   INTERNAL_TOKEN       可选，供云函数间调用
 *
 * 返回 { ok, data: { city, generatedAt, items, cached }, code, message }
 * 条目字段：id/title/author/summary/points/updatedAt/url/credibility
 */
const cloud = require('wx-server-sdk')
const https = require('https')
const format = require('./format')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'travel_cache'

const PUBLIC_MSG = {
  NO_OPENID: '仅小程序内可调用该接口',
  BAD_PARAM: '参数格式不正确',
  NO_KEY: '请先在「我的」中绑定自己的大模型 Key',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  GUIDE_EMPTY: '暂未生成攻略速览，可换个目的地或稍后重试',
  UPSTREAM_FAIL: '攻略服务暂时不可用，请稍后重试'
}

const CACHE_TTL = 24 * 3600 * 1000
const RATE_WINDOW = 60 * 1000
const RATE_MAX = 6

function fail(code, message) {
  const err = new Error(message || PUBLIC_MSG[code] || '攻略服务异常')
  err.code = code
  return err
}

/**
 * 读取并校验大模型配置：优先用户传入的 Key，只有内部调用才用环境变量
 * 注意：不打印 Key，任何返回给客户端的内容都不含 Key
 */
function readLlm(event, isInternal) {
  const raw = (event && event.llm) || {}
  const clientDeepseek = String(raw.deepseek || '').trim()
  const clientModel = String(raw.model || '').trim()
  if (clientDeepseek) {
    if (clientDeepseek.length > 200) throw fail('BAD_PARAM', 'Key 长度异常')
    if (!/^[A-Za-z0-9._-]+$/.test(clientDeepseek)) throw fail('BAD_PARAM', 'Key 含非法字符')
  }
  const model = clientModel || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(model)) throw fail('BAD_PARAM', '模型名不合法')

  const envKey = isInternal ? process.env.DEEPSEEK_API_KEY || '' : ''
  const deepseek = clientDeepseek || envKey
  const source = clientDeepseek ? 'client' : envKey ? 'env' : 'none'
  return { deepseek, model, source }
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (err) {
      return reject(fail('UPSTREAM_FAIL', '检索地址不合法'))
    }
    const body = options.body || ''
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, options.headers || {}, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
          if (text.length > 512 * 1024) {
            req.destroy()
            reject(fail('UPSTREAM_FAIL', '上游响应过大'))
          }
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(fail('UPSTREAM_FAIL', `上游 HTTP ${res.statusCode}`))
          }
          try {
            resolve(JSON.parse(text))
          } catch (err) {
            reject(fail('UPSTREAM_FAIL', '上游返回非 JSON'))
          }
        })
      }
    )
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy()
      reject(fail('UPSTREAM_FAIL', '上游请求超时'))
    })
    req.on('error', () => reject(fail('UPSTREAM_FAIL', '上游网络异常')))
    if (body) req.write(body)
    req.end()
  })
}

async function cacheGet(key) {
  try {
    const res = await db.collection(COLLECTION).doc(key).get()
    const doc = res.data
    if (!doc || !doc.expireAt || Date.now() >= doc.expireAt) return null
    return doc.payload
  } catch (err) {
    return null
  }
}

async function cacheSet(key, payload) {
  try {
    await db.collection(COLLECTION).doc(key).set({
      data: { payload, expireAt: Date.now() + CACHE_TTL, updatedAt: Date.now() }
    })
  } catch (err) {
    console.warn('[guideProxy] 缓存写入失败', err && err.message)
  }
}

/**
 * 每 OPENID 每分钟最多 6 次；事务内裁剪 + 写回，计数异常时 fail-closed
 * 返回 true 表示本次应拒绝
 */
async function hitRateLimit(openid) {
  const key = `rl_guide_${format.md5(openid)}`
  const now = Date.now()
  try {
    let existing = null
    try {
      const res = await db.collection(COLLECTION).doc(key).get()
      existing = res.data || null
    } catch (err) {
      existing = null
    }
    const result = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(COLLECTION).doc(key)
      let doc = existing
      if (existing) {
        try {
          doc = (await ref.get()).data || existing
        } catch (err) {
          doc = existing
        }
      }
      const alive = ((doc && doc.hits) || [])
        .map(Number)
        .filter((time) => Number.isFinite(time) && now - time < RATE_WINDOW)
      alive.push(now)

      if (alive.length > RATE_MAX) {
        await ref.update({ data: { hits: alive.slice(-RATE_MAX - 1), updatedAt: now } })
        return true
      }
      const data = { hits: alive, updatedAt: now, expireAt: now + RATE_WINDOW }
      if (existing) await ref.update({ data })
      else await ref.set({ data })
      return false
    })
    return result === true || !!(result && result.result === true)
  } catch (err) {
    console.warn('[guideProxy] 限流计数失败，本次拒绝', err && err.message)
    return true
  }
}

/** 纯大模型生成攻略速览；不检索平台站内内容，避免抓取与版权风险 */
async function analyze(city, llm, platform, customPlatform) {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
  const payload = await requestJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.deepseek}`
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: format.buildAnalysisSystemPrompt(platform, customPlatform) },
        {
          role: 'user',
          content: format.buildAnalysisPrompt(city, platform, customPlatform, format.todayCN())
        }
      ]
    }),
    timeout: 20000
  })
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content
  return format.parseLlmJson(content)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const internalToken = process.env.INTERNAL_TOKEN
  const isInternal = !!(internalToken && event && event.token === internalToken)
  const city = String((event && event.city) || '').trim()
  const force = !!(event && event.force)
  const rawPlatform = String((event && event.platform) || '').trim()
  const platform = format.normalizePlatform(rawPlatform)
  const customPlatform = String((event && event.customPlatform) || '').trim()

  try {
    if (!OPENID && !isInternal) throw fail('NO_OPENID')
    if (!city || city.length > 20) throw fail('BAD_PARAM', 'city 参数缺失或过长')
    if (rawPlatform && !Object.prototype.hasOwnProperty.call(format.PLATFORMS, rawPlatform)) {
      throw fail('BAD_PARAM', 'platform 参数不合法')
    }
    // 自定义平台名校验：仅中文/字母/数字/空格，避免拼进搜索链接时带入异常文本
    if (customPlatform) {
      if (customPlatform.length > 12) throw fail('BAD_PARAM', 'customPlatform 参数过长')
      if (!/^[\u4e00-\u9fa5A-Za-z0-9 ]+$/.test(customPlatform)) {
        throw fail('BAD_PARAM', 'customPlatform 含非法字符')
      }
    }

    const llm = readLlm(event, isInternal)
    if (!llm.deepseek) throw fail('NO_KEY')
    console.log(
      '[audit]',
      JSON.stringify({
        fn: 'guideProxy',
        openid: OPENID ? format.md5(OPENID).slice(0, 12) : 'internal',
        city,
        platform,
        mode: 'llm',
        keySource: llm.source,
        model: llm.model
      })
    )

    if (OPENID && (await hitRateLimit(OPENID))) throw fail('RATE_LIMITED')

    // 纯大模型速览上线后，旧检索缓存（24 小时）不再命中
    const key = `guide_ai_v1_${format.md5(`${city}|${platform}|${customPlatform}|${llm.model}`)}`
    if (!force) {
      const cached = await cacheGet(key)
      if (cached) return { ok: true, data: Object.assign({}, cached, { cached: true }), cached: true }
    }

    const today = format.todayCN()
    const parsed = await analyze(city, llm, platform, customPlatform)
    if (!parsed) throw fail('UPSTREAM_FAIL', '攻略速览解析失败')
    const item = format.normalizeAnalysis(parsed, city, platform, customPlatform, today)
    if (!item) throw fail('GUIDE_EMPTY')

    const data = {
      city,
      platform,
      platformLabel: format.labelFor(platform, customPlatform),
      generatedAt: Date.now(),
      provider: 'deepseek',
      mode: 'llm',
      items: [item],
      sourceCount: 0,
      searchLink: item.url,
      searchLinkLabel: item.searchLinkLabel
    }
    await cacheSet(key, data)
    return { ok: true, data: Object.assign({}, data, { cached: false }), cached: false }
  } catch (err) {
    console.warn('[guideProxy]', city, err && err.code, err && err.message)
    const code = err && err.code && PUBLIC_MSG[err.code] ? err.code : 'UPSTREAM_FAIL'
    // 上游 401/403 基本是 Key 无效或无权限，按「未配置」返回，页面可直接引导去重新填写
    if (code === 'UPSTREAM_FAIL' && /401|403|unauthorized|invalid.{0,20}key/i.test(String((err && err.message) || ''))) {
      return { ok: false, code: 'NO_KEY', message: PUBLIC_MSG.NO_KEY }
    }
    return { ok: false, code, message: PUBLIC_MSG[code] }
  }
}
