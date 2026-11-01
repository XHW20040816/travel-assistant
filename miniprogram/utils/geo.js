/**
 * 地理计算：球面距离、绕行系数、分模式时长估算
 * 坐标统一使用 [lng, lat] 数组或 {lng, lat} 对象
 */
function toArr(point) {
  if (!point) return [0, 0]
  if (Array.isArray(point)) return [Number(point[0]), Number(point[1])]
  return [Number(point.lng), Number(point.lat)]
}

function toRad(deg) {
  return (deg * Math.PI) / 180
}

/** 球面距离（米） */
function haversine(a, b) {
  const [lng1, lat1] = toArr(a)
  const [lng2, lat2] = toArr(b)
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 市区实际路况绕行系数 */
const DETOUR = 1.28

/** 各交通方式平均速度（km/h），公交已包含候车时间 */
const SPEED = {
  walk: 4.6,
  bike: 11,
  transit: 18,
  taxi: 26,
  drive: 30
}

/** 估算两点间某交通方式的距离与时长 */
function estimateLeg(from, to, mode) {
  const straight = haversine(from, to)
  const km = (straight * DETOUR) / 1000
  const speed = SPEED[mode] || SPEED.taxi
  const minutes = Math.max(2, Math.round((km / speed) * 60 + (mode === 'transit' ? 8 : 2)))
  return {
    mode,
    distance: Math.round(km * 1000),
    minutes,
    estimated: true
  }
}

/** 多点中心点 */
function centroid(points) {
  if (!points.length) return null
  let lng = 0
  let lat = 0
  points.forEach((p) => {
    const [x, y] = toArr(p)
    lng += x
    lat += y
  })
  return { lng: lng / points.length, lat: lat / points.length }
}

/** 粗略判断点是否落在城市范围（用于 POI 去重与异常过滤） */
function withinRadius(center, point, radiusKm) {
  return haversine(center, point) <= radiusKm * 1000
}

/**
 * BD09 → GCJ02
 * 百度地图返回 BD09 坐标，而微信 map 组件使用 GCJ02，接入百度时必须转换
 * 公式：先扣除百度偏移，再反向旋转缩放
 */
function bd09ToGcj02(lng, lat) {
  const xPi = (Math.PI * 3000) / 180
  const x = Number(lng) - 0.0065
  const y = Number(lat) - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * xPi)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPi)
  return {
    lng: z * Math.cos(theta),
    lat: z * Math.sin(theta)
  }
}

/**
 * GCJ02 → BD09（提交给百度接口时使用）
 * 与云函数 upstream.js 的实现保持一致
 */
function gcj02ToBd09(lng, lat) {
  const xPi = (Math.PI * 3000) / 180
  const x = Number(lng)
  const y = Number(lat)
  const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * xPi)
  const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * xPi)
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006
  }
}

module.exports = {
  toArr,
  haversine,
  estimateLeg,
  centroid,
  withinRadius,
  bd09ToGcj02,
  gcj02ToBd09,
  SPEED,
  DETOUR
}
