/**
 * 本地存储：设置、历史、缓存（带 TTL 与抓取时间）
 */
const config = require('../config/index')
const cipher = require('../utils/cipher')

const KEYS = {
  SETTINGS: 'TA_SETTINGS_V1',
  HISTORY: 'TA_HISTORY_V1',
  CURRENT: 'TA_CURRENT_BUNDLE_V1',
  POI: 'TA_POI_INDEX_V1',
  PENDING: 'TA_PENDING_REQUEST_V1',
  GUIDE_DRAFT: 'TA_GUIDE_DRAFT_V1',
  LLM: 'TA_LLM_CIPHER_V1',
  MAP: 'TA_MAP_CIPHER_V1',
  CACHE: 'TA_CACHE_V1_'
}

const DEFAULT_LLM = {
  deepseek: '',
  model: 'deepseek-chat'
}

const DEFAULT_SETTINGS = {
  dataSource: config.dataSource,
  mapProvider: config.mapProvider,
  cloudEnv: config.cloudEnv,
  cloudFn: config.cloudFn,
  qweatherHost: config.qweatherHost,
  keys: Object.assign({}, config.keys),
  guideApiBase: config.guideApiBase,
  guidePlatform: config.defaultGuidePlatform,
  guidePlatformCustom: '',
  defaultCity: Object.assign({}, config.defaultCity)
}

/** 仅开发版 / 体验版允许直连调试；正式版强制 cloud */
function isDirectAllowed() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return false
    const info = wx.getAccountInfoSync()
    const version = info && info.miniProgram ? info.miniProgram.envVersion : ''
    return version === 'develop' || version === 'trial'
  } catch (err) {
    return false
  }
}

function getSettings() {
  let saved = null
  try {
    saved = wx.getStorageSync(KEYS.SETTINGS)
  } catch (err) {
    saved = null
  }
  if (!saved || typeof saved !== 'object') saved = null
  const base = { ...DEFAULT_SETTINGS, ...(saved || {}) }

  // 旧版本曾把 Key 明文持久化到本地，读取时迁移为加密存储并清除明文副本；
  // 云开发环境等参数已不再由前端暴露，一并清理历史残留
  if (saved && (saved.keys || saved.cloudEnv || saved.cloudFn || saved.guideApiBase)) {
    if (saved.keys && typeof saved.keys === 'object') saveMapKeys(saved.keys)
    try {
      const cleaned = { ...saved }
      delete cleaned.keys
      delete cleaned.cloudEnv
      delete cleaned.cloudFn
      delete cleaned.guideApiBase
      wx.setStorageSync(KEYS.SETTINGS, cleaned)
    } catch (err) {
      console.warn('[settings] 清理本地配置失败', err)
    }
  }

  // 旧版本可能是 demo（已移除）或正式版下的 direct，统一回落到 cloud
  let dataSource = base.dataSource
  if (dataSource === 'demo' || (dataSource === 'direct' && !isDirectAllowed())) dataSource = 'cloud'

  return {
    ...base,
    dataSource,
    cloudEnv: config.cloudEnv,
    cloudFn: config.cloudFn,
    guideApiBase: config.guideApiBase,
    keys: getMapKeys(),
    defaultCity: { ...DEFAULT_SETTINGS.defaultCity, ...((saved && saved.defaultCity) || {}) }
  }
}

function saveSettings(patch) {
  const base = getSettings()
  if (patch && patch.keys && typeof patch.keys === 'object') {
    saveMapKeys(patch.keys)
  }
  const next = {
    ...base,
    ...patch,
    keys: getMapKeys()
  }
  if (next.dataSource === 'demo') next.dataSource = 'cloud'
  if (next.dataSource === 'direct' && !isDirectAllowed()) next.dataSource = 'cloud'

  // 落盘时剔除 Key，Key 只以密文形式保存在独立的 Storage 项
  const persisted = { ...next }
  delete persisted.keys
  delete persisted.cloudEnv
  delete persisted.cloudFn
  delete persisted.guideApiBase
  try {
    wx.setStorageSync(KEYS.SETTINGS, persisted)
  } catch (err) {
    console.warn('[settings] 保存失败', err)
  }
  return next
}

/** 读取地图/天气 Key（解密后返回，仅用于内存） */
function getMapKeys() {
  const fallback = { ...DEFAULT_SETTINGS.keys }
  try {
    const blob = wx.getStorageSync(KEYS.MAP)
    if (!blob || typeof blob !== 'string') return fallback
    const text = cipher.decryptText(blob)
    if (!text) return fallback
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      amap: String(parsed.amap || ''),
      baidu: String(parsed.baidu || ''),
      qweather: String(parsed.qweather || '')
    }
  } catch (err) {
    console.warn('[settings] 地图 Key 解密失败', err && err.message)
    return fallback
  }
}

/** 加密保存地图/天气 Key；全部为空时清除 */
function saveMapKeys(patch) {
  const next = {
    amap: String((patch && patch.amap) || '').trim(),
    baidu: String((patch && patch.baidu) || '').trim(),
    qweather: String((patch && patch.qweather) || '').trim()
  }
  try {
    if (!next.amap && !next.baidu && !next.qweather) {
      wx.removeStorageSync(KEYS.MAP)
    } else {
      wx.setStorageSync(KEYS.MAP, cipher.encryptText(JSON.stringify(next)))
    }
  } catch (err) {
    console.warn('[settings] 地图 Key 保存失败', err && err.message)
    return null
  }
  return next
}

function getSourceMode() {
  return getSettings().dataSource || 'cloud'
}

/**
 * 攻略大模型配置：解密后返回，仅用于内存，不写入明文 Storage
 * @returns {{deepseek:String, model:String}|null}
 */
function getLlmConfig() {
  try {
    const blob = wx.getStorageSync(KEYS.LLM)
    if (!blob || typeof blob !== 'string') return null
    const text = cipher.decryptText(blob)
    if (!text) return null
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      deepseek: String(parsed.deepseek || ''),
      model: String(parsed.model || DEFAULT_LLM.model)
    }
  } catch (err) {
    console.warn('[settings] 大模型配置解密失败', err && err.message)
    return null
  }
}

/** 加密保存攻略大模型配置；DeepSeek Key 为空时视为清除 */
function saveLlmConfig(patch) {
  const next = {
    deepseek: String((patch && patch.deepseek) || '').trim(),
    model: String((patch && patch.model) || '').trim() || DEFAULT_LLM.model
  }
  if (!next.deepseek) {
    clearLlmConfig()
    return null
  }
  try {
    wx.setStorageSync(KEYS.LLM, cipher.encryptText(JSON.stringify(next)))
  } catch (err) {
    console.warn('[settings] 大模型配置保存失败', err && err.message)
    return null
  }
  return next
}

function clearLlmConfig() {
  try {
    wx.removeStorageSync(KEYS.LLM)
  } catch (err) {
    console.warn('[settings] 清除大模型配置失败', err && err.message)
  }
}

function hasLlmConfig() {
  const llm = getLlmConfig()
  return !!(llm && llm.deepseek)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function setPendingRequest(request) {
  wx.setStorageSync(KEYS.PENDING, request)
}

/**
 * 攻略页 → 规划页的草稿：目的地与坐标
 * 只在用户主动「去规划」时写入，规划页读取后保留到下一次覆盖
 */
function setGuideDraft(draft) {
  if (!isPlainObject(draft)) return
  try {
    wx.setStorageSync(KEYS.GUIDE_DRAFT, draft)
  } catch (err) {
    console.warn('[guideDraft] 保存失败', err)
  }
}

function getGuideDraft() {
  const value = wx.getStorageSync(KEYS.GUIDE_DRAFT)
  if (!isPlainObject(value)) {
    if (value) wx.removeStorageSync(KEYS.GUIDE_DRAFT)
    return null
  }
  return value
}

function clearGuideDraft() {
  try {
    wx.removeStorageSync(KEYS.GUIDE_DRAFT)
  } catch (err) {
    console.warn('[guideDraft] 清除失败', err)
  }
}

function getPendingRequest() {
  const value = wx.getStorageSync(KEYS.PENDING)
  if (!isPlainObject(value)) {
    if (value) wx.removeStorageSync(KEYS.PENDING)
    return null
  }
  return value
}

function saveBundle(bundle) {
  wx.setStorageSync(KEYS.CURRENT, bundle)
}

function getBundle() {
  const value = wx.getStorageSync(KEYS.CURRENT)
  if (!isPlainObject(value)) {
    if (value) wx.removeStorageSync(KEYS.CURRENT)
    return null
  }
  return value
}

function setPoiIndex(index) {
  wx.setStorageSync(KEYS.POI, index)
}

function getPoiIndex() {
  const value = wx.getStorageSync(KEYS.POI)
  if (!isPlainObject(value)) {
    if (value) wx.removeStorageSync(KEYS.POI)
    return {}
  }
  return value
}

function findPoi(id) {
  return getPoiIndex()[id] || null
}

function listHistory() {
  const raw = wx.getStorageSync(KEYS.HISTORY)
  if (!Array.isArray(raw)) {
    if (raw) wx.removeStorageSync(KEYS.HISTORY)
    return []
  }
  return raw
    .filter((item) => isPlainObject(item))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

function addHistory(entry) {
  let list = listHistory()
  list = list.filter((item) => item.id !== entry.id)
  list.unshift(entry)
  list = list.slice(0, 8)
  wx.setStorageSync(KEYS.HISTORY, list)
  return list
}

function removeHistory(id) {
  const list = listHistory().filter((item) => item.id !== id)
  wx.setStorageSync(KEYS.HISTORY, list)
  return list
}

function clearHistory() {
  wx.removeStorageSync(KEYS.HISTORY)
}

/** 读取缓存记录：{ data, fetchedAt, expireAt } */
function cacheRead(key) {
  try {
    const record = wx.getStorageSync(KEYS.CACHE + key)
    if (!record || !record.expireAt) return null
    if (Date.now() > record.expireAt) return null
    return record
  } catch (err) {
    return null
  }
}

function cacheWrite(key, data, ttl) {
  const record = {
    data,
    fetchedAt: Date.now(),
    expireAt: Date.now() + ttl
  }
  try {
    wx.setStorageSync(KEYS.CACHE + key, record)
  } catch (err) {
    console.warn('[cache] write failed', err)
  }
  return record
}

function cacheClear() {
  try {
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).forEach((key) => {
      if (key.indexOf(KEYS.CACHE) === 0) wx.removeStorageSync(key)
    })
  } catch (err) {
    console.warn('[cache] clear failed', err)
  }
}

function cacheSize() {
  try {
    const info = wx.getStorageInfoSync()
    const keys = (info.keys || []).filter((key) => key.indexOf(KEYS.CACHE) === 0)
    return { count: keys.length, currentSize: info.currentSize, limitSize: info.limitSize }
  } catch (err) {
    return { count: 0, currentSize: 0, limitSize: 0 }
  }
}

module.exports = {
  KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_LLM,
  getSettings,
  saveSettings,
  isDirectAllowed,
  getSourceMode,
  getMapKeys,
  saveMapKeys,
  getLlmConfig,
  saveLlmConfig,
  clearLlmConfig,
  hasLlmConfig,
  setPendingRequest,
  getPendingRequest,
  setGuideDraft,
  getGuideDraft,
  clearGuideDraft,
  saveBundle,
  getBundle,
  setPoiIndex,
  getPoiIndex,
  findPoi,
  listHistory,
  addHistory,
  removeHistory,
  clearHistory,
  cacheRead,
  cacheWrite,
  cacheClear,
  cacheSize
}
