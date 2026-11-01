/**
 * 住宿锚点与打分回归测试（无第三方依赖，直接 node tests/decision.test.js 运行）
 *
 * 覆盖：
 *   1. 单点 / 重合点直接返回，避免除零
 *   2. 几何中位数迭代收敛，且目标值不劣于质心
 *   3. 离群点场景下，几何中位数明显优于质心
 *   4. 权重能把锚点拉向高权重点位
 *   5. 住宿打分：价格缺失按中性分、类型不匹配降权
 *   6. 规划页勾选景点（focusNames）兴趣加权与名称归一化匹配
 */
const assert = require('assert')
const decision = require('../miniprogram/utils/decision')
const geo = require('../miniprogram/utils/geo')

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

function objective(point, points) {
  return points.reduce((sum, item) => sum + (Number(item.weight) || 1) * geo.haversine(point, item), 0)
}

check('单点返回自身坐标', () => {
  const result = decision.geometricMedian([{ lng: 116.4, lat: 39.9 }])
  assert.ok(result)
  assert.ok(Math.abs(result.lng - 116.4) < 1e-9)
  assert.ok(Math.abs(result.lat - 39.9) < 1e-9)
  assert.strictEqual(result.converged, true)
})

check('同坐标重复点合并，不出现除零', () => {
  const result = decision.geometricMedian([
    { lng: 116.4, lat: 39.9 },
    { lng: 116.4, lat: 39.9, weight: 3 }
  ])
  assert.ok(result)
  assert.ok(Math.abs(result.lng - 116.4) < 1e-9)
  assert.ok(Math.abs(result.lat - 39.9) < 1e-9)
  assert.strictEqual(result.converged, true)
})

const triangle = [
  { lng: 116.3, lat: 39.9 },
  { lng: 116.45, lat: 39.95 },
  { lng: 116.4, lat: 39.8 }
]

check('三角形：Weiszfeld 收敛且目标值不劣于质心', () => {
  const result = decision.geometricMedian(triangle, { maxIter: 80, toleranceMeters: 1 })
  assert.ok(result.converged, '应在最大迭代内收敛')
  assert.ok(result.iterations <= 80)
  const centroid = geo.centroid(triangle)
  const medianValue = objective(result, triangle)
  const centroidValue = objective(centroid, triangle)
  // 允许 1 米内的浮点误差；几何中位数必须更优或持平
  assert.ok(medianValue <= centroidValue + 1, `锚点目标 ${medianValue} 应不高于质心 ${centroidValue}`)
})

check('离群点：几何中位数比质心更稳健', () => {
  const points = [
    { lng: 116.3, lat: 39.9 },
    { lng: 116.4, lat: 39.9 },
    { lng: 116.5, lat: 39.9 },
    { lng: 118.0, lat: 39.9 }
  ]
  const result = decision.geometricMedian(points)
  const centroid = geo.centroid(points)
  const medianValue = objective(result, points)
  const centroidValue = objective(centroid, points)
  assert.ok(medianValue < centroidValue * 0.8, `锚点 ${medianValue} 应明显小于质心 ${centroidValue}`)
  // 锚点应留在主簇一侧，而不是被 118 的离群点拉走
  assert.ok(result.lng < centroid.lng, '锚点经度应比质心更靠近主簇')
})

check('权重把锚点拉向高权重点位', () => {
  const points = [
    { lng: 116.3, lat: 39.9, weight: 5 },
    { lng: 116.6, lat: 39.9, weight: 1 }
  ]
  const result = decision.geometricMedian(points)
  const centroid = geo.centroid(points)
  assert.ok(result.lng < centroid.lng, '高权重点位应把锚点拉向 116.3')
  assert.ok(result.lng < 116.45, `锚点经度 ${result.lng} 应明显偏离低权重点`)
})

check('空输入返回 null', () => {
  assert.strictEqual(decision.geometricMedian([]), null)
  assert.strictEqual(decision.geometricMedian(null), null)
})

const poiCtx = {
  prefKeys: [],
  weights: decision.VARIANTS.balanced.weights,
  budgetPerDay: 400,
  rainProb: 0,
  pace: 'normal',
  center: { lng: 116.4, lat: 39.9 },
  party: 2,
  hasElder: false
}
const basePoi = {
  name: '宽窄巷子',
  category: '景点',
  tags: ['历史街区'],
  rating: 4.6,
  reviews: 12000,
  cost: 0,
  duration: 120,
  outdoor: true,
  lng: 116.4,
  lat: 39.9
}

check('规划页勾选景点在兴趣分上加权', () => {
  const normal = decision.scorePoi({ ...basePoi }, poiCtx)
  const focused = decision.scorePoi({ ...basePoi }, { ...poiCtx, focusNames: ['宽窄巷子'] })
  assert.ok(focused.parts.interest > normal.parts.interest, `兴趣分 ${focused.parts.interest} 应高于 ${normal.parts.interest}`)
  assert.ok(focused.score > normal.score, `总分 ${focused.score} 应高于 ${normal.score}`)
  assert.ok(focused.reasons.indexOf('已选景点，按你的选择优先') >= 0)
})

check('勾选景点名忽略空白与大小写匹配', () => {
  const normal = decision.scorePoi({ ...basePoi }, poiCtx)
  const focused = decision.scorePoi({ ...basePoi }, { ...poiCtx, focusNames: [' 宽窄巷子 '] })
  assert.ok(focused.score > normal.score, '带空白的同名景点也应获得加权')
})

check('未勾选的景点不加权', () => {
  const normal = decision.scorePoi({ ...basePoi }, poiCtx)
  const other = decision.scorePoi({ ...basePoi }, { ...poiCtx, focusNames: ['故宫博物院'] })
  assert.strictEqual(other.score, normal.score)
})

const baseStay = {
  lng: 116.41,
  lat: 39.91,
  stayType: 'hotel',
  rating: 4.6,
  price: 350,
  priceKnown: true
}
const ctx = {
  anchor: { lng: 116.4, lat: 39.9 },
  pois: [
    { lng: 116.35, lat: 39.9, duration: 120 },
    { lng: 116.45, lat: 39.95, duration: 90 }
  ],
  budgetMin: 200,
  budgetMax: 600,
  type: 'hotel',
  transport: 'mixed',
  party: 2,
  hasElder: false
}

check('住宿打分：价格在预算内优于价格未知', () => {
  const known = decision.scoreStay({ ...baseStay }, ctx)
  const unknown = decision.scoreStay({ ...baseStay, price: null, priceKnown: false }, ctx)
  assert.ok(known.score > unknown.score, `预算内 ${known.score} 应高于未知 ${unknown.score}`)
  assert.ok(unknown.reasons.indexOf('参考价未公开，以平台为准') >= 0)
})

check('住宿打分：类型不匹配降权', () => {
  const matched = decision.scoreStay({ ...baseStay, stayType: 'hotel' }, ctx)
  const mismatched = decision.scoreStay({ ...baseStay, stayType: 'homestay' }, ctx)
  assert.ok(matched.score > mismatched.score, `类型匹配 ${matched.score} 应高于不匹配 ${mismatched.score}`)
})

check('住宿打分：超预算按比例扣分，不高于预算内', () => {
  const inBudget = decision.scoreStay({ ...baseStay, price: 500 }, ctx)
  const overBudget = decision.scoreStay({ ...baseStay, price: 1200 }, ctx)
  assert.ok(inBudget.score > overBudget.score, `预算内 ${inBudget.score} 应高于超预算 ${overBudget.score}`)
})

console.log(`\n住宿锚点与打分测试：${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`)
