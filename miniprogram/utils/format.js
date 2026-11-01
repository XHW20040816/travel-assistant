/**
 * 展示格式化工具
 */
function distance(meters) {
  const m = Number(meters) || 0
  if (m < 1000) return `${Math.round(m)} 米`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} 公里`
}

function duration(minutes) {
  const min = Math.max(0, Math.round(Number(minutes) || 0))
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

function shortDuration(minutes) {
  const min = Math.max(0, Math.round(Number(minutes) || 0))
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${m}m` : `${h}h`
}

function money(value) {
  const n = Math.round(Number(value) || 0)
  return `¥${n}`
}

function popular(count) {
  const n = Number(count) || 0
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return `${n}`
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`
}

function weekdayDate(dateStr) {
  const date = require('./date')
  return `${date.weekdayCN(dateStr)} ${date.parseDate(dateStr).getMonth() + 1}月${date.parseDate(dateStr).getDate()}日`
}

function grade(score) {
  if (score >= 86) return { text: '优选', cls: 'tag--green' }
  if (score >= 76) return { text: '推荐', cls: 'tag--blue' }
  if (score >= 66) return { text: '可用', cls: 'tag--orange' }
  return { text: '备选', cls: '' }
}

function modeText(mode) {
  const map = {
    walk: '步行',
    bike: '骑行',
    transit: '公交/地铁',
    taxi: '打车',
    drive: '自驾'
  }
  return map[mode] || mode
}

function modeBadge(mode) {
  const map = {
    walk: '步',
    bike: '骑',
    transit: '公',
    taxi: '车',
    drive: '驾'
  }
  return map[mode] || '行'
}

module.exports = {
  distance,
  duration,
  shortDuration,
  money,
  popular,
  percent,
  weekdayDate,
  grade,
  modeText,
  modeBadge
}
