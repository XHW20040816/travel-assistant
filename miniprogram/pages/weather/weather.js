const storage = require('../../services/storage')
const dateUtil = require('../../utils/date')

Page({
  data: {
    plan: null,
    days: [],
    summary: '',
    sourceText: '',
    empty: false
  },

  onLoad() {
    const bundle = storage.getBundle()
    if (!bundle || !bundle.plans || !bundle.plans.length) {
      this.setData({ empty: true })
      return
    }
    const index = Number(bundle.activeIndex) || 0
    const plan = bundle.plans[index] || bundle.plans[0]

    const days = plan.days.map((day, i) => {
      const weather = day.weather || {}
      const clothing = day.clothing || { level: '—', text: '', items: [], tips: [] }
      const activity = day.activity || { level: '', text: '' }
      return {
        index: i,
        label: `D${i + 1}`,
        dateLabel: day.dateLabel,
        weekday: day.weekday,
        weatherText: day.weatherText,
        nightText: weather.nightWeather || '',
        tempText: day.tempText,
        dayTemp: weather.dayTemp,
        nightTemp: weather.nightTemp,
        rainProb: Number.isFinite(Number(weather.rainProb)) ? Math.round(Number(weather.rainProb)) : null,
        rainProbText: Number.isFinite(Number(weather.rainProb)) ? `${Math.round(Number(weather.rainProb))}%` : '—',
        windText: `${weather.windDir || ''} ${weather.windScale || ''}`.trim(),
        humidityText: weather.humidity ? `${weather.humidity}%` : '—',
        uvText: weather.uvIndex ? `${weather.uvIndex}` : '—',
        clothing,
        clothingItems: (clothing.items || []).join(' / '),
        activity,
        outOfRange: !!weather.outOfRange,
        note: weather.note || ''
      }
    })

    const realDays = days.filter((day) => Number.isFinite(Number(day.dayTemp)) && Number.isFinite(Number(day.nightTemp)))
    const summary = realDays.length
      ? `行程温度 ${Math.min(...realDays.map((day) => Number(day.nightTemp)))}~${Math.max(
          ...realDays.map((day) => Number(day.dayTemp))
        )}℃，最高降水概率 ${days.reduce((max, day) => Math.max(max, Number(day.rainProb) || 0), 0)}%；穿衣以「${Array.from(
          new Set(realDays.map((day) => day.clothing.level))
        ).join(' / ')}」为主。`
      : '所选日期暂无实时预报，未提供穿衣与活动推断，出行前请复核最新天气。'
    const meta = plan.meta || {}
    const sourceText = `${meta.dataNote || '数据说明缺失'}${
      meta.weatherFetchedAt ? ` · 更新于 ${dateUtil.relativeTime(meta.weatherFetchedAt)}` : ''
    }`

    this.setData({ plan, days, summary, sourceText })
    wx.setNavigationBarTitle({ title: `${plan.dest ? plan.dest.name : ''} 天气` })
  },

  goPlan() {
    wx.navigateBack()
  },

  goGuide() {
    wx.switchTab({ url: '/pages/guide/guide' })
  }
})
