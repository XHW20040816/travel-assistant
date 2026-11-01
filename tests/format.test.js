/**
 * guideProxy format 清洗逻辑回归测试（无第三方依赖，直接 node tests/format.test.js 运行）
 *
 * 覆盖：
 *   1. 强调类 emoji（❗/❓）映射为普通标点，杜绝低版本字体方块乱码
 *   2. 其余 emoji（🔥 等）直接删除
 *   3. 中文、全角标点、中文引号等合法字符保留
 *   4. 控制字符 / 零宽字符被清除
 *   5. normalizeItems 对 title / summary / points / author 应用了清洗
 */
const assert = require('assert')
const format = require('../cloudfunctions/guideProxy/format')

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

check('❗ 映射为 ！（重叹号不再产生方块）', () => {
  const out = format.cleanText('成都都江堰“日照金山”火了❗❗❗海外网友喊话')
  assert.strictEqual(out, '成都都江堰“日照金山”火了！！！海外网友喊话')
})

check('❓ 映射为 ？', () => {
  assert.strictEqual(format.cleanText('真的假的❓'), '真的假的？')
})

check('普通 emoji（🔥）被删除', () => {
  const out = format.cleanText('爆火🔥的景点')
  assert.strictEqual(out, '爆火的景点')
})

check('中文与全角标点保留', () => {
  const out = format.cleanText('白天游古堰景区、登青城山，夜晚看“都江夜堰”光影演艺：双线玩法！')
  assert.strictEqual(out, '白天游古堰景区、登青城山，夜晚看“都江夜堰”光影演艺：双线玩法！')
})

check('英文、数字与常用符号保留', () => {
  const out = format.cleanText('成都 D1 09:00 出发，¥328/晚（含早）· 电话 028-1234567 ！')
  assert.strictEqual(out, '成都 D1 09:00 出发，¥328/晚（含早）· 电话 028-1234567 ！')
})

check('控制字符与零宽字符被清除', () => {
  const out = format.cleanText('攻略\u0000要点\u200b清单\ufeff结尾')
  assert.strictEqual(out, '攻略要点清单结尾')
})

check('连续空格压缩并去除首尾空白', () => {
  assert.strictEqual(format.cleanText('  成都   攻略  '), '成都 攻略')
})

check('normalizeItems 对标题应用清洗（含 url 白名单校验）', () => {
  const url = 'https://example.com/guide-1'
  const rawItems = [
    { title: '都江堰“日照金山”火了❗❗❗', summary: '双线玩法🔥值得看', points: ['白天游古堰\u200b', '晚上看演艺❗'], updatedAt: '2026-10-12', url }
  ]
  const searchResults = [{ url, snippet: '原始摘要', publishedAt: '2026-10-12' }]
  const items = format.normalizeItems(rawItems, searchResults, '成都', '2026-11-02')
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].title, '都江堰“日照金山”火了！！！')
  assert.strictEqual(items[0].summary, '双线玩法值得看')
  assert.deepStrictEqual(items[0].points, ['白天游古堰', '晚上看演艺！'])
})

check('平台检索词包含对应平台与域名限定', () => {
  const xhs = format.buildQueries('成都', 'xiaohongshu')
  const douyin = format.buildQueries('成都', 'douyin')
  assert.ok(xhs.every((query) => query.indexOf('小红书') >= 0))
  assert.ok(xhs.some((query) => query.indexOf('site:xiaohongshu.com') >= 0))
  assert.ok(douyin.every((query) => query.indexOf('抖音') >= 0))
  // 非法平台回落到全部平台
  assert.deepStrictEqual(format.buildQueries('成都', 'unknown'), format.buildQueries('成都', 'all'))
})

check('平台域名匹配与识别', () => {
  assert.strictEqual(format.matchesPlatform('https://www.xiaohongshu.com/explore/1', 'xiaohongshu'), true)
  assert.strictEqual(format.matchesPlatform('https://www.douyin.com/video/1', 'xiaohongshu'), false)
  assert.strictEqual(format.matchesPlatform('https://example.com/post', 'all'), true)
  assert.deepStrictEqual(format.detectPlatform('https://zhuanlan.zhihu.com/p/1'), { key: 'zhihu', label: '知乎' })
  assert.deepStrictEqual(format.detectPlatform('https://www.douyin.com/video/1'), { key: 'douyin', label: '抖音' })
  assert.deepStrictEqual(format.detectPlatform('https://example.com/post'), { key: 'other', label: '网页' })
})

check('平台模式下剔除其他平台的条目', () => {
  const xhsUrl = 'https://www.xiaohongshu.com/explore/1'
  const douyinUrl = 'https://www.douyin.com/video/1'
  const rawItems = [
    { title: '成都攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: xhsUrl },
    { title: '抖音攻略', summary: '摘要', points: [], updatedAt: '2026-10-12', url: douyinUrl }
  ]
  const searchResults = [
    { url: xhsUrl, snippet: 'x', publishedAt: '2026-10-12' },
    { url: douyinUrl, snippet: 'y', publishedAt: '2026-10-12' }
  ]
  const items = format.normalizeItems(rawItems, searchResults, '成都', '2026-11-02', 'xiaohongshu')
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].url, xhsUrl)
  assert.strictEqual(items[0].platform, 'xiaohongshu')
  assert.strictEqual(items[0].platformLabel, '小红书')
})

check('提示词按平台限定来源', () => {
  const prompt = format.buildPrompt('成都', [], '2026-11-02', 'zhihu')
  assert.ok(prompt.indexOf('只检索「知乎」') >= 0)
  const allPrompt = format.buildPrompt('成都', [], '2026-11-02', 'all')
  assert.ok(allPrompt.indexOf('多个平台') >= 0)
})

console.log(`\n攻略文本清洗测试：${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`)
