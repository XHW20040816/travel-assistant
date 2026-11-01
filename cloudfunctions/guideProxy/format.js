/**
 * guideProxy 纯函数：检索结果解析、提示词、LLM 输出归一化
 * 与 wx-server-sdk 解耦，便于本地单元测试
 */
const crypto = require('crypto')

function md5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex')
}

/** 北京时间当天 yyyy-MM-dd */
function todayCN() {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

/** 兼容博查返回的几种结构，抽出网页结果 */
function extractResults(payload) {
  const data = (payload && payload.data) || payload || {}
  const candidates = [
    data.webPages && data.webPages.value,
    data.webPages && data.webPages.list,
    data.results,
    data.value,
    payload && payload.webPages && payload.webPages.value
  ]
  const list = candidates.find((item) => Array.isArray(item)) || []
  return list
    .map((item) => ({
      title: String(item.name || item.title || '').trim(),
      url: String(item.url || item.link || '').trim(),
      snippet: String(item.summary || item.snippet || '').trim(),
      publishedAt: String(item.datePublished || item.dateLastCrawled || item.date || '').slice(0, 10),
      site: String(item.siteName || '')
    }))
    .filter((item) => item.title && /^https?:\/\/[^/\s]+/.test(item.url))
    .slice(0, 12)
}

/** 常见平台名 → 公开域名（自定义平台「其他」的硬过滤依据；未收录的平台名走宽松匹配） */
const CUSTOM_SITES = {
  携程: ['ctrip.com', 'trip.com'],
  去哪儿: ['qunar.com'],
  美团: ['meituan.com'],
  大众点评: ['dianping.com'],
  飞猪: ['fliggy.com'],
  穷游: ['qyer.com'],
  途牛: ['tuniu.com'],
  同程: ['ly.com'],
  马蜂窝: ['mafengwo.cn', 'mafengwo.com'],
  知乎: ['zhihu.com'],
  小红书: ['xiaohongshu.com', 'xhslink.com'],
  抖音: ['douyin.com', 'iesdouyin.com'],
  B站: ['bilibili.com', 'b23.tv']
}

/** 攻略平台：检索词 + 域名白名单，与前端 config.guidePlatforms 保持一致 */
const PLATFORMS = {
  all: {
    key: 'all',
    label: '全部平台',
    sites: [],
    queries: (city) => [`${city} 旅行攻略 最新`, `${city} 旅行攻略 避坑 景点`]
  },
  xiaohongshu: {
    key: 'xiaohongshu',
    label: '小红书',
    sites: ['xiaohongshu.com', 'xhslink.com'],
    queries: (city) => [
      `${city} 旅行攻略 小红书`,
      `${city} 小红书 美食 景点 攻略 site:xiaohongshu.com`,
      `site:xiaohongshu.com ${city} 小红书 攻略 避坑`
    ]
  },
  douyin: {
    key: 'douyin',
    label: '抖音',
    sites: ['douyin.com', 'iesdouyin.com'],
    queries: (city) => [
      `${city} 旅行攻略 抖音`,
      `${city} 抖音 景点 打卡 攻略 site:douyin.com`,
      `site:douyin.com ${city} 抖音 景点 攻略`
    ]
  },
  zhihu: {
    key: 'zhihu',
    label: '知乎',
    sites: ['zhihu.com'],
    queries: (city) => [
      `${city} 旅行攻略 知乎`,
      `${city} 知乎 旅游 攻略 经验 site:zhihu.com`,
      `site:zhihu.com ${city} 知乎 旅游 攻略`
    ]
  },
  mafengwo: {
    key: 'mafengwo',
    label: '马蜂窝',
    sites: ['mafengwo.cn', 'mafengwo.com'],
    queries: (city) => [
      `${city} 旅行攻略 马蜂窝`,
      `${city} 马蜂窝 自由行 攻略 site:mafengwo.cn`,
      `site:mafengwo.cn ${city} 马蜂窝 旅游 攻略`
    ]
  },
  bilibili: {
    key: 'bilibili',
    label: 'B站',
    sites: ['bilibili.com', 'b23.tv'],
    queries: (city) => [
      `${city} 旅行攻略 bilibili`,
      `${city} B站 旅游 vlog 攻略 site:bilibili.com`,
      `site:bilibili.com ${city} B站 旅游 攻略`
    ]
  },
  // 自定义平台：用户输入平台名（如 携程、去哪儿），检索词按名称生成；
  // 有域名映射的平台（CUSTOM_SITES）按真实域名 site: 限定并做域名过滤，未收录的靠检索词限定
  other: {
    key: 'other',
    label: '其他',
    sites: [],
    queries: (city, customName) => {
      const name = String(customName || '').trim()
      if (!name) return [`${city} 旅行攻略 最新`, `${city} 旅行攻略 避坑 景点`]
      const sites = CUSTOM_SITES[name]
      const siteQuery = sites && sites.length ? ` site:${sites[0]}` : ''
      return [`${city} ${name} 旅行攻略 最新`, `${city} ${name} 攻略 景点${siteQuery}`]
    }
  }
}

function normalizePlatform(value) {
  const key = String(value || '').trim()
  return Object.prototype.hasOwnProperty.call(PLATFORMS, key) ? key : 'all'
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase()
  } catch (err) {
    return ''
  }
}

/**
 * 结果域名是否属于所选平台：
 * - all 表示不限；
 * - other（自定义平台）：平台名在 CUSTOM_SITES 有映射时按域名硬过滤，未收录时宽松放行（靠检索词限定）
 */
function matchesPlatform(url, platform, customName) {
  const key = normalizePlatform(platform)
  if (key === 'all') return true
  const host = hostOf(url)
  if (!host) return false
  if (key === 'other') {
    const name = String(customName || '').trim()
    const sites = name ? CUSTOM_SITES[name] || [] : []
    if (!sites.length) return true
    return sites.some((site) => host === site || host.indexOf(`.${site}`) >= 0)
  }
  return PLATFORMS[key].sites.some((site) => host === site || host.indexOf(`.${site}`) >= 0)
}

/** 从原帖域名识别平台，用于前端展示；自定义平台（other）无固定域名，跳过 */
function detectPlatform(url) {
  const keys = Object.keys(PLATFORMS).filter((key) => key !== 'all' && key !== 'other')
  for (let i = 0; i < keys.length; i += 1) {
    if (matchesPlatform(url, keys[i])) return { key: keys[i], label: PLATFORMS[keys[i]].label }
  }
  return { key: 'other', label: '网页' }
}

/** 检索结果的来源站标签：预置平台按域名识别，其余匹配常见平台域名映射（如 携程→ctrip.com），否则标「网页」 */
function sourceLabel(url) {
  const meta = detectPlatform(url)
  if (meta.key !== 'other') return meta.label
  const host = hostOf(url)
  if (!host) return '网页'
  const names = Object.keys(CUSTOM_SITES)
  for (let i = 0; i < names.length; i += 1) {
    if (CUSTOM_SITES[names[i]].some((site) => host === site || host.indexOf(`.${site}`) >= 0)) {
      return names[i]
    }
  }
  return '网页'
}

function buildQueries(city, platform, customName) {
  const key = normalizePlatform(platform)
  return PLATFORMS[key].queries(city, String(customName || '').trim())
}

/** 所选平台的展示名：自定义平台优先用用户输入的平台名 */
function labelFor(platform, customName) {
  const key = normalizePlatform(platform)
  const custom = String(customName || '').trim()
  return key === 'other' && custom ? custom : PLATFORMS[key].label
}

/** 各平台的内容整理口径：让大模型按平台的内容形态提炼，而不是统一套模板 */
const PLATFORM_STYLE = {
  all: '多平台汇总：按来源平台分别整理，同一平台最多 2 条；保留每条的真实来源平台，不要把不同平台的内容混成一条。',
  xiaohongshu: '小红书笔记口径：保留真实体验与打卡视角，重点提炼排队时长、人均价格、拍照机位与避坑点，标题可口语化。',
  douyin: '抖音内容口径：从视频文案提炼可执行的路线、机位、营业时间与人均消费，不要描述镜头、剪辑或画面效果。',
  zhihu: '知乎内容口径：偏经验总结与理性比较，重点提炼避坑、预算、交通对比与适用人群，少用夸张语气。',
  mafengwo: '马蜂窝内容口径：偏完整行程，重点提炼路线顺序、交通方式、门票价格与住宿位置，方便直接照着走。',
  bilibili: 'B站内容口径：从视频攻略提炼时间线、路线、机位与注意事项，不要描述画面或up主个人表现。',
  other: '按用户指定平台的内容口径整理：只保留与该平台直接相关的内容，按该平台常见的内容形态提炼要点。'
}

/** 自定义平台未收录域名时，用平台名与标题/摘要/站点做文本相关性判断 */
function mentionsPlatform(row, customName) {
  const name = String(customName || '').replace(/\s+/g, '').toLowerCase()
  if (!name) return true
  const hay = `${row.title || ''}${row.snippet || ''}${row.site || ''}${row.url || ''}`
    .replace(/\s+/g, '')
    .toLowerCase()
  return hay.indexOf(name) >= 0
}

/**
 * 结果是否真的属于所选平台：
 * - 预置平台按域名硬过滤；
 * - 自定义平台已收录域名时按域名过滤，未收录时要求标题/摘要/站点提到该平台名
 */
function isPlatformRelevant(row, platform, customName) {
  if (!row || !matchesPlatform(row.url, platform, customName)) return false
  const key = normalizePlatform(platform)
  if (key !== 'other') return true
  const name = String(customName || '').trim()
  if (!name) return true
  const sites = CUSTOM_SITES[name] || []
  if (sites.length) return true
  return mentionsPlatform(row, name)
}

/** 平台内容搜索入口：小程序不抓取站内内容，只给可复制的真实搜索链接 */
const PLATFORM_SEARCH = {
  xiaohongshu: (query) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
  douyin: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}`,
  zhihu: (query) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
  mafengwo: (query) => `https://www.mafengwo.cn/search/q.php?q=${encodeURIComponent(query)}`,
  bilibili: (query) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`
}

/** 所选平台的真实搜索链接；自定义平台回退到浏览器搜索 */
function buildSearchLink(city, platform, customName) {
  const key = normalizePlatform(platform)
  const name = String(customName || '').trim()
  const query = key === 'other' && name ? `${city} ${name} 旅行攻略` : `${city} 旅行攻略`
  if (PLATFORM_SEARCH[key]) return PLATFORM_SEARCH[key](query)
  return `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
}

function searchLinkLabel(platform, customName) {
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  return key === 'other' ? `在浏览器搜索「${label}」相关攻略` : `去${label}搜索真实笔记`
}

/** 纯大模型速览的系统提示：按平台口径组织内容，但不声称来自该平台帖子 */
function buildAnalysisSystemPrompt(platform, customName) {
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  const style = PLATFORM_STYLE[key] || PLATFORM_STYLE.all
  return `你是旅行规划编辑，为「${label}」用户生成目的地攻略速览，只输出 JSON。内容只来自通用旅行知识，不得声称引用或整理自「${label}」的具体帖子，不得编造帖子标题、作者、点赞数或原帖链接。整理口径：${style}`
}

function buildAnalysisPrompt(city, platform, customName, today) {
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  const style = PLATFORM_STYLE[key] || PLATFORM_STYLE.all
  return [
    `今天是 ${today}。为「${city}」生成一份面向「${label}」用户的攻略速览，作为出行前的参考。`,
    '要求：',
    '1. 只写通用、相对稳定的旅行信息；不得编造具体帖子、作者、点赞数或链接。',
    '2. 价格、营业时间、预约规则等易变信息不要给精确数字，提醒以官方公告为准。',
    '3. overview 80-120 字，说明城市玩法、节奏与适合人群。',
    '4. highlights 4-6 条，每条不超过 24 字，写具体可去的地点或吃法。',
    '5. tips 3-5 条，每条不超过 24 字，写避坑、交通或预约建议。',
    '6. bestTime 一句话，不超过 20 字。',
    `7. 整理口径：${style}`,
    '8. 只输出 JSON，不要额外解释，结构如下：',
    '{"overview":"","highlights":[""],"tips":[""],"bestTime":""}'
  ].join('\n')
}

function cleanList(input, limit) {
  return (Array.isArray(input) ? input : [])
    .map((item) => cleanText(String(item || '')).slice(0, 30))
    .filter(Boolean)
    .slice(0, limit)
}

/** 把大模型速览整理成页面现有的攻略条目结构，链接使用平台真实搜索入口 */
function normalizeAnalysis(parsed, city, platform, customName, today) {
  if (!parsed || typeof parsed !== 'object') return null
  const overview = cleanText(String(parsed.overview || '')).slice(0, 200)
  if (!overview) return null
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  const highlights = cleanList(parsed.highlights, 6)
  const tips = cleanList(parsed.tips, 5)
  const bestTime = cleanText(String(parsed.bestTime || '')).slice(0, 30)
  if (!highlights.length && !tips.length) return null
  const points = []
  if (bestTime) points.push(`最佳时间：${bestTime}`)
  highlights.forEach((item) => points.push(item))
  tips.forEach((item) => points.push(item))
  return {
    id: `ai-${md5(`${city}|${key}|${String(customName || '').trim()}`).slice(0, 8)}`,
    city,
    title: `${city}｜${label}攻略速览`,
    author: 'AI 参考',
    sourceName: label,
    likes: 0,
    credibility: 'AI 参考',
    updatedAt: today,
    summary: overview,
    points: points.slice(0, 7),
    related: [],
    url: buildSearchLink(city, key, customName),
    platform: key,
    platformLabel: label,
    searchLinkLabel: searchLinkLabel(key, customName)
  }
}

/** 大模型系统提示：随所选平台切换角色与整理口径，避免所有平台都套同一模板 */
function buildSystemPrompt(platform, customName) {
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  const style = PLATFORM_STYLE[key] || PLATFORM_STYLE.all
  const scope =
    key === 'all'
      ? '你会收到多个平台的检索结果，需要按来源平台分别整理，不得混淆来源。'
      : `素材全部来自「${label}」，不得补充其他平台的内容或来源标注。`
  return `你是严谨的旅行攻略编辑，本次专门整理「${label}」的攻略，只输出 JSON。${scope}整理口径：${style}`
}

/** 条目的展示平台：按本次所选平台标注；自定义平台标注用户输入的平台名，全部平台按原帖域名识别 */
function itemPlatform(url, platform, customName) {
  const key = normalizePlatform(platform)
  if (key === 'all') return detectPlatform(url)
  if (key === 'other') {
    const name = String(customName || '').trim()
    return { key: 'other', label: name || detectPlatform(url).label }
  }
  return { key, label: PLATFORMS[key].label }
}

function buildPrompt(city, results, today, platform, customName) {
  const key = normalizePlatform(platform)
  const label = labelFor(key, customName)
  const platformRule =
    key === 'all'
      ? '4. 结果来自多个平台，按来源平台分别整理；标题/摘要/要点不得编造或标注结果中没有出现的平台来源。'
      : key === 'other'
        ? `4. 本次要整理的是「${label}」的攻略：只整理内容确实与「${label}」相关（标题或摘要提到「${label}」，或「来源平台」标注为「${label}」）的条目；不得把其他平台的内容当作「${label}」攻略；若没有相关条目，输出空 items 数组。`
        : `4. 本次只检索「${label}」的公开内容：只能整理「来源平台」为「${label}」的条目，不得引用其他平台；标题/摘要/要点中不得出现其他平台名称；若没有该平台条目，输出空 items 数组。`
  const style = PLATFORM_STYLE[key] || PLATFORM_STYLE.all
  const annotated = results.map((row) =>
    Object.assign({}, row, { 来源平台: sourceLabel(row.url), 来源站点: row.site || sourceLabel(row.url) })
  )
  const intro =
    key === 'all'
      ? `根据下面检索到的多个平台网页结果，为「${city}」提炼最新、最实用的攻略。`
      : `根据下面检索到的「${label}」网页结果，为「${city}」提炼最新、最实用的攻略。`
  const tail =
    key === 'all' ? '检索结果（每条已标注「来源平台」）：' : `检索结果（每条已标注「来源平台」，全部属于「${label}」）：`
  return [
    `你是旅行攻略编辑，今天是 ${today}。${intro}`,
    '要求：',
    '1. 只能使用给定结果，不得编造；url 必须从结果中原样复制，不能改写。',
    '2. 输出 4-6 条，优先发布时间新、内容具体（路线、时间、避坑、价格）的条目；不足时有多少输出多少。',
    '3. updatedAt 用结果中的发布日期，缺失则用今天；summary 不超过 80 字；points 2-3 条，每条不超过 40 字。',
    platformRule,
    `5. 整理口径：${style}`,
    '6. 只输出 JSON，不要额外解释，结构如下：',
    '{"items":[{"title":"","author":"","summary":"","points":[""],"updatedAt":"yyyy-MM-dd","url":""}]}',
    tail,
    JSON.stringify(annotated)
  ].join('\n')
}

/** 强调类 emoji 映射为普通标点（❗→！、❓→？等），避免低版本字体下显示为方块乱码 */
const EMOJI_PUNCT_MAP = {
  0x2757: '！', // ❗
  0x2753: '？', // ❓
  0x203c: '！', // ‼
  0x2049: '！？' // ⁉
}

/** 白名单码点：中文、ASCII、常见中英文标点；其余（emoji、符号、假名等）一律过滤 */
function isAllowedCode(code) {
  if (code >= 0x4e00 && code <= 0x9fff) return true // CJK 统一表意文字
  if (code >= 0x3400 && code <= 0x4dbf) return true // CJK 扩展 A
  if (code >= 0x3000 && code <= 0x303f) return true // CJK 标点与全角空格
  if (code >= 0xff01 && code <= 0xff5e) return true // 全角 ASCII 变体（！：（）等）
  if (code >= 0x2018 && code <= 0x201f) return true // ‘ ’ “ ”
  if (code >= 0x20 && code <= 0x7e) return true // ASCII 可打印（含空格与英文标点）
  if (
    code === 0x2013 || code === 0x2014 || // – —
    code === 0x2026 || code === 0x00b7 || // … ·
    code === 0x00a5 || code === 0x00a9 || code === 0x00ae || // ¥ © ®
    code === 0x00d7 || code === 0x00f7 || // × ÷
    code === 0x2022 || code === 0x2027 || code === 0x203b // • ‧ ※
  ) {
    return true
  }
  return false
}

/** 清洗攻略文本：删除不可见控制字符，映射强调类 emoji，过滤其余 emoji/符号 */
function cleanText(text) {
  const raw = String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // 控制字符
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '') // 零宽/方向/行分隔
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0)
    if (Object.prototype.hasOwnProperty.call(EMOJI_PUNCT_MAP, code)) {
      out += EMOJI_PUNCT_MAP[code]
      continue
    }
    if (isAllowedCode(code)) out += ch
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

/** 解析 LLM 输出，容忍代码块与前后缀文本 */
function parseLlmJson(text) {
  const raw = String(text || '').replace(/```json/gi, '```').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch (err) {
    return null
  }
}

/** 校验并归一化 LLM 条目；只接受检索结果中出现过的 url，防止编造链接 */
function normalizeItems(rawItems, searchResults, city, today, platform, customPlatform) {
  const allowed = new Set(searchResults.map((item) => item.url))
  const byUrl = new Map(searchResults.map((item) => [item.url, item]))
  const seen = new Set()
  const items = []

  ;(Array.isArray(rawItems) ? rawItems : []).forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const url = String(raw.url || '').trim()
    if (!allowed.has(url) || seen.has(url) || !matchesPlatform(url, platform, customPlatform)) return
    const title = cleanText(String(raw.title || '')).slice(0, 60)
    const search = byUrl.get(url) || {}
    const summary = cleanText(String(raw.summary || search.snippet || '')).slice(0, 120)
    if (!title || !summary) return
    const updatedAt = isDate(raw.updatedAt)
      ? raw.updatedAt
      : isDate(search.publishedAt)
        ? search.publishedAt
        : today
    const points = (Array.isArray(raw.points) ? raw.points : [])
      .map((point) => cleanText(String(point || '')))
      .filter(Boolean)
      .slice(0, 3)
      .map((point) => point.slice(0, 60))
    seen.add(url)
    const platformMeta = itemPlatform(url, platform, customPlatform)
    items.push({
      id: `live-${md5(url).slice(0, 8)}`,
      city,
      title,
      author: cleanText(String(raw.author || '实时检索')).slice(0, 20),
      sourceName: cleanText(String(search.site || '')).slice(0, 20),
      likes: 0,
      credibility: '实时检索',
      updatedAt,
      summary,
      points,
      related: [],
      url,
      platform: platformMeta.key,
      platformLabel: platformMeta.label
    })
  })

  return items.slice(0, 6)
}

module.exports = {
  md5,
  todayCN,
  isDate,
  extractResults,
  buildQueries,
  buildPrompt,
  buildSystemPrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisPrompt,
  normalizeAnalysis,
  buildSearchLink,
  searchLinkLabel,
  parseLlmJson,
  normalizeItems,
  itemPlatform,
  cleanText,
  isAllowedCode,
  PLATFORMS,
  PLATFORM_STYLE,
  normalizePlatform,
  matchesPlatform,
  isPlatformRelevant,
  mentionsPlatform,
  labelFor,
  detectPlatform,
  sourceLabel,
  CUSTOM_SITES
}
