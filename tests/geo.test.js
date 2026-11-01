/**
 * 坐标转换回归测试（无第三方依赖，直接 node tests/geo.test.js 运行）
 *
 * 覆盖：
 *   1. GCJ02 → BD09 固定城市基准值（防止公式方向写反）
 *   2. GCJ02 → BD09 → GCJ02 往返误差 < 1 米
 *   3. 客户端 geo.js 与云函数 upstream.js 的 gcj02ToBd09 输出一致
 *   4. 方向校验：百度坐标在国境内相对 GCJ02 整体偏东北
 */
const assert = require('assert')
const geo = require('../miniprogram/utils/geo')
const upstream = require('../cloudfunctions/travelApi/upstream')

const CASES = [
  { name: '北京', gcj: { lng: 116.397428, lat: 39.90923 }, bd: { lng: 116.40380056450005, lat: 39.9155730161122 } },
  { name: '上海', gcj: { lng: 121.473701, lat: 31.230416 }, bd: { lng: 121.48023840790201, lat: 31.236350800982365 } },
  { name: '成都', gcj: { lng: 104.066541, lat: 30.572269 }, bd: { lng: 104.07300542574244, lat: 30.578319637165702 } },
  { name: '三亚', gcj: { lng: 109.511909, lat: 18.252847 }, bd: { lng: 109.51846574504881, lat: 18.258582340587314 } }
]

// 1e-6 度约等于 0.11 米，足以锁定基准值又不因浮点误差误报
const DEG_TOLERANCE = 1e-6

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(`        ${err.message}`)
    process.exitCode = 1
  }
}

CASES.forEach((item) => {
  check(`${item.name} GCJ02 → BD09 基准值`, () => {
    const result = geo.gcj02ToBd09(item.gcj.lng, item.gcj.lat)
    assert.ok(Math.abs(result.lng - item.bd.lng) < DEG_TOLERANCE, `经度偏差 ${Math.abs(result.lng - item.bd.lng)}`)
    assert.ok(Math.abs(result.lat - item.bd.lat) < DEG_TOLERANCE, `纬度偏差 ${Math.abs(result.lat - item.bd.lat)}`)
  })

  check(`${item.name} GCJ02 → BD09 → GCJ02 往返误差 < 1 米`, () => {
    const bd = geo.gcj02ToBd09(item.gcj.lng, item.gcj.lat)
    const back = geo.bd09ToGcj02(bd.lng, bd.lat)
    const meters = geo.haversine(item.gcj, back)
    assert.ok(meters < 1, `往返误差 ${meters.toFixed(4)} 米`)
    console.log(`        ${item.name} 往返误差 ${meters.toFixed(4)} 米`)
  })

  check(`${item.name} BD09 → GCJ02 方向正确（百度坐标整体偏东北）`, () => {
    const bd = geo.gcj02ToBd09(item.gcj.lng, item.gcj.lat)
    const gcj = geo.bd09ToGcj02(bd.lng, bd.lat)
    assert.ok(bd.lng > gcj.lng && bd.lat > gcj.lat, 'BD09 应位于 GCJ02 的东北方向')
  })

  check(`${item.name} 客户端与云函数 gcj02ToBd09 一致`, () => {
    const client = geo.gcj02ToBd09(item.gcj.lng, item.gcj.lat)
    const server = upstream.gcj02ToBd09(item.gcj.lng, item.gcj.lat)
    assert.ok(Math.abs(client.lng - server.lng) < 1e-9, '经度与云函数不一致')
    assert.ok(Math.abs(client.lat - server.lat) < 1e-9, '纬度与云函数不一致')
  })
})

check('字符串坐标可正确转换', () => {
  const fromString = geo.bd09ToGcj02('116.40380056450005', '39.9155730161122')
  const fromNumber = geo.bd09ToGcj02(116.40380056450005, 39.9155730161122)
  assert.ok(Number.isFinite(fromString.lng) && Number.isFinite(fromString.lat), '输出必须为有限数值')
  assert.ok(Math.abs(fromString.lng - fromNumber.lng) < 1e-9, '字符串与数值输入结果应一致')
})

console.log(`\n坐标转换测试：${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`)
