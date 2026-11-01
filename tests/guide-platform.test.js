/**
 * 攻略平台「其他/自定义」改造回归测试（无第三方依赖，直接 node tests/guide-platform.test.js 运行）
 *
 * 覆盖：
 *   1. 云函数 format：other 平台合法、自定义平台名映射常见平台域名做硬过滤
 *   2. 检索词与提示词带自定义平台名，提示词标注每条结果的「来源平台」
 *   3. 前端 services/guide：normalizePlatform 接受 other、回退到默认平台、平台标签正确
 *   4. 历史 all 兼容：normalizePlatform 仍可识别 all（历史缓存 key 与旧请求不中断）
 */
const assert = require('assert')

// 前端 services/guide.js 在 node 环境仅调用 wx 于函数体内，require 前补一个空壳防止意外
global.wx = {}
global.getApp = () => null

const format = require('../cloudfunctions/guideProxy/format')
const guideService = require('../miniprogram/services/guide')

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

/* ---------- 云函数 format ---------- */

check('other 是合法平台，不再回退 all', () => {
  assert.strictEqual(format.normalizePlatform('other'), 'other')
})

check('历史 all 平台仍可识别（兼容旧缓存与请求）', () => {
  assert.strictEqual(format.normalizePlatform('all'), 'all')
})

check('自定义平台未填平台名时宽松放行（不丢弃结果）', () => {
  assert.strictEqual(format.matchesPlatform('https://example.com/any/1', 'other', ''), true)
})

check('自定义平台未收录域名映射时宽松放行', () => {
  assert.strictEqual(format.matchesPlatform('https://example.com/any/1', 'other', '随心游'), true)
})

check('自定义平台名映射到域名时按域名硬过滤（携程→ctrip.com）', () => {
  assert.strictEqual(format.matchesPlatform('https://you.ctrip.com/guide/1', 'other', '携程'), true)
  assert.strictEqual(format.matchesPlatform('https://www.xiaohongshu.com/explore/1', 'other', '携程'), false)
  assert.strictEqual(format.matchesPlatform('https://www.douyin.com/video/1', 'other', '携程'), false)
})

check('自定义平台检索词含平台名与映射域名 site 限定', () => {
  const queries = format.buildQueries('成都', 'other', '携程')
  assert.ok(queries.every((query) => query.indexOf('携程') >= 0))
  assert.ok(queries.some((query) => query.indexOf('site:ctrip.com') >= 0))
})

check('自定义平台未收录映射时检索词不带 site 限定', () => {
  const queries = format.buildQueries('成都', 'other', '随心游')
  assert.ok(queries.some((query) => query.indexOf('随心游') >= 0))
  assert.ok(!queries.some((query) => query.indexOf('site:') >= 0))
})

check('自定义平台未填名称时回落到通用检索词', () => {
  assert.deepStrictEqual(format.buildQueries('成都', 'other', ''), format.buildQueries('成都', 'all'))
})

check('自定义平台提示词使用用户输入的平台名', () => {
  const prompt = format.buildPrompt('成都', [], '2026-11-02', 'other', '携程')
  assert.ok(prompt.indexOf('「携程」') >= 0)
  assert.ok(prompt.indexOf('多个平台') < 0)
})

check('预置平台提示词只允许整理该平台条目并标注来源平台', () => {
  const results = [
    { url: 'https://www.xiaohongshu.com/explore/1', title: 'x' },
    { url: 'https://www.douyin.com/video/1', title: 'y' }
  ]
  const prompt = format.buildPrompt('成都', results, '2026-11-02', 'xiaohongshu')
  assert.ok(prompt.indexOf('只检索「小红书」') >= 0)
  assert.ok(prompt.indexOf('不得出现其他平台名称') >= 0)
  assert.ok(prompt.indexOf('来源平台') >= 0)
  assert.ok(prompt.indexOf('"来源平台":"小红书"') >= 0, '检索结果应逐条标注来源平台')
})

check('other 模式下不按域名丢弃检索条目（未收录映射）', () => {
  const xhsUrl = 'https://www.xiaohongshu.com/explore/1'
  const douyinUrl = 'https://www.douyin.com/video/1'
  const rawItems = [
    { title: '小红书攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: xhsUrl },
    { title: '抖音攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: douyinUrl }
  ]
  const searchResults = [
    { url: xhsUrl, snippet: 'x', publishedAt: '2026-10-12' },
    { url: douyinUrl, snippet: 'y', publishedAt: '2026-10-12' }
  ]
  const items = format.normalizeItems(rawItems, searchResults, '成都', '2026-11-02', 'other', '随心游')
  assert.strictEqual(items.length, 2)
})

check('自定义平台名映射到域名时 normalizeItems 也按域名过滤', () => {
  const ctripUrl = 'https://you.ctrip.com/guide/1'
  const xhsUrl = 'https://www.xiaohongshu.com/explore/1'
  const rawItems = [
    { title: '携程攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: ctripUrl },
    { title: '小红书攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: xhsUrl }
  ]
  const searchResults = [
    { url: ctripUrl, snippet: 'x', publishedAt: '2026-10-12' },
    { url: xhsUrl, snippet: 'y', publishedAt: '2026-10-12' }
  ]
  const items = format.normalizeItems(rawItems, searchResults, '成都', '2026-11-02', 'other', '携程')
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].url, ctripUrl)
})

check('来源站标签：映射平台可识别，未知站标「网页」', () => {
  assert.strictEqual(format.sourceLabel('https://you.ctrip.com/guide/1'), '携程')
  assert.strictEqual(format.sourceLabel('https://www.xiaohongshu.com/explore/1'), '小红书')
  assert.strictEqual(format.sourceLabel('https://example.com/post'), '网页')
})

check('自定义平台不干扰既有平台识别', () => {
  assert.deepStrictEqual(format.detectPlatform('https://www.douyin.com/video/1'), { key: 'douyin', label: '抖音' })
  assert.deepStrictEqual(format.detectPlatform('https://example.com/post'), { key: 'other', label: '网页' })
})

/* ---------- 前端 services/guide ---------- */

check('前端 normalizePlatform 接受 other', () => {
  assert.strictEqual(guideService.normalizePlatform('other'), 'other')
})

check('前端 normalizePlatform 对已删除的 all 回退到默认平台（小红书）', () => {
  assert.strictEqual(guideService.normalizePlatform('all'), 'xiaohongshu')
})

check('前端未知平台回退到默认平台（小红书）', () => {
  assert.strictEqual(guideService.normalizePlatform('ctrip'), 'xiaohongshu')
})

check('前端平台标签：other 显示为「其他」，预置平台标签不变', () => {
  assert.strictEqual(guideService.platformLabel('other'), '其他')
  assert.strictEqual(guideService.platformLabel('xiaohongshu'), '小红书')
})

console.log(`\n攻略平台自定义测试：${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`)
