/**
 * 日期/时间工具（小程序端统一使用本地时区）
 */
function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 解析 yyyy-MM-dd 日期，非法输入返回 Invalid Date（不静默进位）
 * 支持 Date 实例与字符串；斜杠格式、空串、2026-13-40 均视为非法
 */
function parseDate(str) {
  if (str instanceof Date) return new Date(str.getFullYear(), str.getMonth(), str.getDate())
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''))
  if (!m) return new Date(NaN)
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return new Date(NaN)
  const date = new Date(y, mo - 1, d)
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return new Date(NaN) // 拦截 2026-02-31 这类进位
  return date
}

/** 是否为合法日期 */
function isValidDate(str) {
  return !isNaN(parseDate(str).getTime())
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr)
  d.setDate(d.getDate() + days)
  return formatDate(d)
}

/** 两个日期之间的天数（含首尾）；非法或结束早于开始时返回 0 */
function daysBetween(startDate, endDate) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) return 0
  const diff = parseDate(endDate).getTime() - parseDate(startDate).getTime()
  if (diff < 0) return 0
  return Math.round(diff / 86400000) + 1
}

function weekdayCN(dateStr) {
  const d = parseDate(dateStr)
  if (isNaN(d.getTime())) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

function isWeekend(dateStr) {
  const day = parseDate(dateStr).getDay()
  return day === 0 || day === 6
}

function dateList(startDate, days) {
  const out = []
  for (let i = 0; i < days; i++) out.push(addDays(startDate, i))
  return out
}

function todayStr() {
  return formatDate(new Date())
}

function minutesToClock(minutes) {
  const total = Math.max(0, Math.round(minutes))
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`
}

function clockToMinutes(clock) {
  const [h, m] = String(clock).split(':').map(Number)
  return h * 60 + (m || 0)
}

function relativeTime(timestamp) {
  if (!timestamp) return '未知'
  const diff = Date.now() - timestamp
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 30 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`
  const d = new Date(timestamp)
  return `${formatDate(d)} 更新`
}

module.exports = {
  pad,
  formatDate,
  parseDate,
  isValidDate,
  daysBetween,
  addDays,
  weekdayCN,
  isWeekend,
  dateList,
  todayStr,
  minutesToClock,
  clockToMinutes,
  relativeTime
}
