/**
 * 攻略服务
 * 攻略由云端大模型检索公开结果并整理：按用户选择的平台检索，只展示内容与原帖地址
 */
const storage = require('./storage')
const config = require('../config/index')
const dateUtil = require('../utils/date')
const mapService = require('./map')

/** 各平台的公开域名，用于展示与兜底识别；云函数侧也按同一批域名过滤 */
const PLATFORM_SITES = {
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  douyin: ['douyin.com', 'iesdouyin.com'],
  zhihu: ['zhihu.com'],
  mafengwo: ['mafengwo.cn', 'mafengwo.com'],
  bilibili: ['bilibili.com', 'b23.tv']
}

function normalizePlatform(key) {
  const value = String(key || '')
  const allowed = (config.guidePlatforms || []).some((item) => item.key === value)
  return allowed ? value : config.defaultGuidePlatform
}

function platformLabel(key) {
  const normalized = normalizePlatform(key)
  const item = (config.guidePlatforms || []).find((entry) => entry.key === normalized)
  return item ? item.label : '其他'
}

/** 从原帖域名识别平台；识别不出时按普通网页展示（小程序没有完整 URL 实现） */
function detectPlatform(url) {
  const matched = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''))
  if (!matched) return 'other'
  const host = matched[1].toLowerCase().replace(/^.*@/, '').split(':')[0]
  const keys = Object.keys(PLATFORM_SITES)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (PLATFORM_SITES[key].some((site) => host === site || host.indexOf(`.${site}`) >= 0)) return key
  }
  return 'other'
}

function labelOf(key) {
  return key === 'other' ? '网页' : platformLabel(key)
}

/** 从 URL 取出小写域名，用于校验条目是否属于所选平台 */
function hostOf(url) {
  const matched = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''))
  if (!matched) return ''
  return matched[1].toLowerCase().replace(/^.*@/, '').split(':')[0]
}

function belongsToPlatform(platform, url) {
  const key = normalizePlatform(platform)
  if (key === 'all' || key === 'other') return true
  const sites = PLATFORM_SITES[key] || []
  const host = hostOf(url)
  return !!host && sites.some((site) => host === site || host.indexOf(`.${site}`) >= 0)
}

/**
 * 前端兜底校验：云端旧版本或历史缓存可能返回其他平台的条目，
 * 预置平台按域名拦截，自定义平台按云端标注的平台名拦截，避免「选小红书却显示报纸」。
 */
function keepLiveItem(platform, customPlatform, item) {
  if (platform === 'all') return true
  if (platform === 'other') {
    const name = String(customPlatform || '').trim()
    return !!name && String(item.platformLabel || '').trim() === name
  }
  return belongsToPlatform(platform, item.url)
}

/**
 * 清洗攻略文本：删除不可见控制字符，映射强调类 emoji（❗→！等），过滤其余 emoji/符号。
 * 与云函数 guideProxy/format.js 的 cleanText 保持一致，用于兜底清洗历史缓存数据。
 */
const EMOJI_PUNCT_MAP = { 0x2757: '！', 0x2753: '？', 0x203c: '！', 0x2049: '！？' }

function isAllowedCode(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点与全角空格
    (code >= 0xff01 && code <= 0xff5e) || // 全角 ASCII 变体
    (code >= 0x2018 && code <= 0x201f) || // ‘ ’ “ ”
    (code >= 0x20 && code <= 0x7e) || // ASCII 可打印
    code === 0x2013 || code === 0x2014 || code === 0x2026 || code === 0x00b7 || code === 0x00a5
  )
}

function cleanText(text) {
  const raw = String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (Object.prototype.hasOwnProperty.call(EMOJI_PUNCT_MAP, code)) {
      out += EMOJI_PUNCT_MAP[code]
      continue
    }
    if (isAllowedCode(code)) out += raw[i]
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

function daysSince(dateStr) {
  if (!dateStr) return 999
  const updated = dateUtil.parseDate(dateStr)
  if (isNaN(updated.getTime())) return 999
  const diff = Date.now() - updated.getTime()
  return Math.max(0, Math.floor(diff / 86400000))
}

function decorate(guide) {
  const updatedDays = daysSince(guide.updatedAt)
  let freshnessText = '近期更新'
  let stale = false
  if (updatedDays > 120) {
    freshnessText = '内容较旧，需复核'
    stale = true
  } else if (updatedDays > 60) {
    freshnessText = '可参考，注意时效'
  }
  const rawPlatform = String(guide.platform || '')
  const platform =
    rawPlatform === 'other' || PLATFORM_SITES[rawPlatform] ? rawPlatform : detectPlatform(guide.url)
  // 云函数已按本次所选平台标注来源（自定义平台为用户输入的平台名），优先沿用
  const cloudLabel = cleanText(guide.platformLabel)
  const platformLabelText =
    platform === 'other' && cloudLabel && cloudLabel !== '网页' ? cloudLabel : labelOf(platform)
  return {
    ...guide,
    title: cleanText(guide.title),
    summary: cleanText(guide.summary),
    author: cleanText(guide.author),
    sourceName: cleanText(guide.sourceName),
    points: (Array.isArray(guide.points) ? guide.points : []).map(cleanText).filter(Boolean),
    platform,
    platformLabel: platformLabelText,
    updatedDays,
    freshnessText,
    stale,
    updatedText: `${guide.updatedAt} 生成`
  }
}

/** 按已选点位匹配攻略；不足时补充城市通用攻略 */
function forPlan(city, poiNames, limit) {
  return []
}

/** 云端大模型检索条目：必须有可复制的原帖链接 */
function isValidLive(guide) {
  if (!guide || typeof guide !== 'object') return false
  if (typeof guide.id !== 'string' || !guide.id) return false
  if (typeof guide.title !== 'string' || !guide.title) return false
  if (typeof guide.updatedAt !== 'string' || !dateUtil.isValidDate(guide.updatedAt)) return false
  if (typeof guide.url !== 'string' || !/^https?:\/\/[^/\s]+/.test(guide.url)) return false
  if (typeof guide.summary !== 'string' || !guide.summary) return false
  return true
}

/** 把 cloud.callFunction 的底层错误翻译成页面可读的提示 */
function describeCloudError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  const matched = msg.match(/errCode:\s*(-?\d+)/)
  const errCode = matched ? matched[1] : ''
  if (/timeout|-504003|timed out/i.test(msg)) {
    return { code: 'CLOUD_TIMEOUT', message: '云函数调用超时：请把 guideProxy 超时时间调到 60 秒' }
  }
  if (msg.indexOf('-601034') >= 0 || /cloud.*(not.*open|未开通)/i.test(msg)) {
    return { code: 'CLOUD_NOT_OPEN', message: '云开发未开通：请先在开发者工具中开通云开发' }
  }
  if (msg.indexOf('-604100') >= 0 || /env.*(not exist|invalid)|环境.*不存在/i.test(msg)) {
    return { code: 'CLOUD_ENV_INVALID', message: '云环境不可用：请检查「我的」页云环境 ID' }
  }
  if (msg.indexOf('-501000') >= 0 || /FunctionName|not found|不存在/i.test(msg)) {
    return { code: 'CLOUD_FN_MISSING', message: '云函数 guideProxy 未部署或依赖缺失：请用「云端安装依赖」重新部署' }
  }
  if (/cloud\.init|not initialized|未初始化|Cloud API isn't enabled/i.test(msg)) {
    return { code: 'CLOUD_NOT_INIT', message: '云开发未初始化：请把数据源切回「云开发」后重启小程序' }
  }
  const brief = msg.replace(/^cloud\.callFunction:fail\s*/i, '').slice(0, 90)
  return { code: 'CLOUD_FAIL', message: `云函数调用失败${errCode ? `（${errCode}）` : ''}${brief ? `：${brief}` : ''}` }
}

function emptyLive(error) {
  return {
    items: [],
    generatedAt: 0,
    cached: false,
    sourceCount: 0,
    provider: '',
    error: error || null
  }
}

/**
 * 调用云函数 guideProxy（DeepSeek 生成攻略速览 + 平台搜索入口）
 * 优先使用「我的」页前端配置（加密存储）的解密结果，未配置时由云函数回退环境变量；
 * 返回结构化结果，失败时带 error 供页面区分「未配置 / 超时 / 无结果」等场景
 */
function fetchCloud(city, options) {
  const settings = storage.getSettings()
  if (settings.dataSource !== 'cloud' || !wx.cloud) {
    return Promise.resolve(emptyLive({ code: 'NOT_CLOUD', message: '当前为直连调试模式，大模型速览需云开发模式' }))
  }
  const platform = normalizePlatform(options && options.platform)
  const customPlatform =
    platform === 'other' ? String((options && options.customPlatform) || '').trim() : ''
  const payload = { city, platform, force: !!(options && options.force) }
  if (customPlatform) payload.customPlatform = customPlatform
  const llm = storage.getLlmConfig()
  if (llm && llm.deepseek) {
    payload.llm = { deepseek: llm.deepseek, model: llm.model }
  }
  return wx.cloud
    .callFunction({
      name: settings.guideFn || config.guideFn,
      data: payload
    })
    .then((res) => {
      const result = res && res.result
      if (!result || result.ok === false || !result.data) {
        const error = {
          code: (result && result.code) || 'UPSTREAM_FAIL',
          message: (result && result.message) || '攻略服务暂时不可用'
        }
        if (result && result.ok === false) console.warn('[guide]', error.code, error.message)
        return emptyLive(error)
      }
      const data = result.data
      const watched = platform === 'other' && customPlatform ? customPlatform : platformLabel(platform)
      const rawItems = (Array.isArray(data.items) ? data.items : []).filter(isValidLive).map(decorate)
      const items = rawItems
        .filter((item) => keepLiveItem(platform, customPlatform, item))
        .map((item) => (platform === 'all' ? item : { ...item, platform, platformLabel: watched }))
      if (rawItems.length && !items.length) {
        return emptyLive({
          code: 'PLATFORM_MISMATCH',
          message: `云端返回的攻略不属于「${watched}」，请重新部署 guideProxy 后点「重新检索」`
        })
      }
      return {
        items,
        generatedAt: Number(data.generatedAt) || 0,
        cached: !!data.cached,
        sourceCount: Number(data.sourceCount) || 0,
        provider: String(data.provider || ''),
        mode: String(data.mode || ''),
        searchLinkLabel: String(data.searchLinkLabel || ''),
        platform,
        platformLabel: watched,
        error: null
      }
    })
    .catch((err) => {
      console.warn('[guide] 云端攻略失败', (err && (err.errMsg || err.message)) || err)
      return emptyLive(describeCloudError(err))
    })
}

/**
 * 系统推荐的热门景点：先定位城市中心，再按热门景点检索
 * 目的地来自地图选点时优先使用其坐标，避免同名地点偏移
 * 返回精简结构，供规划页筛选与勾选
 */
function suggestSpots(city, options) {
  const opts = options || {}
  const limit = Math.max(4, Math.min(20, Number(opts.limit) || 12))
  const dest = opts.dest
  const hasPoint =
    dest && Number.isFinite(Number(dest.lng)) && Number.isFinite(Number(dest.lat))
  const center = hasPoint ? { lng: Number(dest.lng), lat: Number(dest.lat) } : null
  const adcode = (dest && dest.adcode) || ''

  const prepared = center && adcode
    ? Promise.resolve({ center, adcode, cityName: dest.name || city })
    : mapService.geocode(city, city).then((result) => ({
        center: center || { lng: result.lng, lat: result.lat },
        adcode: result.adcode || '',
        cityName: result.city || city
      }))

  return prepared
    .then((base) =>
      mapService.searchPoi({
        cityName: base.cityName,
        adcode: base.adcode,
        center: base.center,
        prefs: opts.prefs || [],
        limit
      })
    )
    .then((list) =>
      list.map((poi) => ({
        id: poi.id,
        name: poi.name,
        category: poi.category,
        rating: poi.rating,
        ratingText: Number(poi.rating) > 0 ? Number(poi.rating).toFixed(1) : '暂无评分',
        lng: poi.lng,
        lat: poi.lat,
        address: poi.address,
        tags: (poi.tags || []).slice(0, 2)
      }))
    )
}

/**
 * 读取城市攻略：返回云端大模型检索结果（本地不保留任何预置攻略内容）
 * @returns {Promise<{ live: Object }>}
 */
function load(city, options) {
  return fetchCloud(city, options).then((live) => ({ live }))
}

/**
 * 校验自建攻略服务地址：必须 https，且域名在 config.guideApiAllowHosts 白名单内
 * 返回去掉末尾斜杠的规范地址；不合法返回空串
 */
function normalizeBase(raw) {
  const base = String(raw || '').trim()
  if (!base) return ''
  if (!/^https:\/\/[^/?#\s]+/i.test(base)) return ''
  const hostMatch = /^https:\/\/([^/?#:]+)/i.exec(base)
  if (!hostMatch) return ''
  const host = hostMatch[1].toLowerCase()
  const allowHosts = (config.guideApiAllowHosts || []).map((item) => String(item).toLowerCase())
  if (allowHosts.indexOf(host) < 0) return ''
  return base.replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/** 远端攻略条目必须包含合法基础字段，缺字段条目直接丢弃 */
function isValidRemote(guide) {
  if (!guide || typeof guide !== 'object') return false
  if (typeof guide.id !== 'string' || !guide.id) return false
  if (typeof guide.title !== 'string' || !guide.title) return false
  if (typeof guide.updatedAt !== 'string' || !dateUtil.isValidDate(guide.updatedAt)) return false
  return true
}

/**
 * 可选：自建攻略聚合服务（需自行确保数据来源合规）
 */
function fetchRemote(city) {
  const settings = storage.getSettings()
  const base = normalizeBase(settings.guideApiBase)
  if (!base) return Promise.resolve([])

  const url = `${base}?city=${encodeURIComponent(city)}`
  return new Promise((resolve) => {
    wx.request({
      url,
      method: 'GET',
      timeout: 8000,
      success(res) {
        if (res.statusCode !== 200 || !res.data) return resolve([])
        const list = Array.isArray(res.data) ? res.data : res.data.list
        if (!Array.isArray(list)) return resolve([])
        resolve(list.filter(isValidRemote).map(decorate))
      },
      fail() {
        resolve([])
      }
    })
  })
}

module.exports = {
  load,
  fetchCloud,
  suggestSpots,
  forPlan,
  fetchRemote,
  normalizeBase,
  decorate,
  daysSince,
  normalizePlatform,
  platformLabel,
  detectPlatform,
  PLATFORM_SITES
}
