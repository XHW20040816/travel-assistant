/**
 * scheduledRefresh：定时清理过期缓存 + 定向预热（可选）
 *
 * 环境变量：
 *   REFRESH_CITIES：需要预热的城市，逗号分隔，如「北京,上海,成都」；留空则只清理缓存
 *   INTERNAL_TOKEN：与 travelApi 环境变量保持一致，用于云函数间调用鉴权（必填）
 *
 * 定时触发器见 config.json（每天 02:00 执行一次，可在云开发控制台调整）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'travel_cache'

async function callTravelApi(data) {
  const internalToken = process.env.INTERNAL_TOKEN
  const res = await cloud.callFunction({
    name: 'travelApi',
    data: Object.assign({ internalToken }, data)
  })
  const result = (res && res.result) || {}
  if (result.ok === false) throw new Error(result.message || '预热失败')
  return result
}

async function warmCity(city) {
  const geo = await callTravelApi({ action: 'geocode', params: { address: city, city }, force: true })
  const geocodes = (geo.data && geo.data.geocodes) || []
  const first = geocodes[0]
  if (!first || !first.adcode) return { city, ok: false, reason: '未解析到城市编码' }

  await callTravelApi({
    action: 'poiText',
    params: {
      keywords: '热门景点',
      types: '110000|110100|110200',
      city: first.adcode,
      citylimit: true,
      offset: 20,
      page: 1,
      extensions: 'all'
    },
    force: true
  })

  return { city, ok: true }
}

exports.main = async () => {
  let removed = 0
  try {
    const res = await db.collection(COLLECTION).where({ expireAt: db.command.lt(Date.now()) }).remove()
    removed = (res.stats && res.stats.removed) || 0
  } catch (err) {
    console.warn('[scheduledRefresh] 清理缓存失败', err && err.message)
  }

  const cities = String(process.env.REFRESH_CITIES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const warmed = []
  for (let i = 0; i < cities.length; i++) {
    try {
      warmed.push(await warmCity(cities[i]))
    } catch (err) {
      warmed.push({ city: cities[i], ok: false, reason: (err && err.message) || '预热失败' })
    }
  }

  return {
    ok: true,
    removed,
    warmed,
    time: new Date().toISOString()
  }
}
