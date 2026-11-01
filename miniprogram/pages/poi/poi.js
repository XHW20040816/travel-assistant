const storage = require('../../services/storage')
const dateUtil = require('../../utils/date')
const format = require('../../utils/format')

const PART_LABELS = [
  { key: 'interest', label: '偏好匹配' },
  { key: 'quality', label: '口碑评分' },
  { key: 'popularity', label: '热度' },
  { key: 'costFit', label: '预算适配' },
  { key: 'weatherFit', label: '天气适配' },
  { key: 'durationFit', label: '时长匹配' },
  { key: 'proximity', label: '就近程度' }
]

function findPlanPoi(plan, id) {
  if (!plan || !plan.pois) return null
  return plan.pois.find((item) => String(item.id) === String(id)) || null
}

/** 兜底：从当日时间轴中还原点位信息 */
function findByItem(plan, id) {
  if (!plan || !plan.days) return null
  for (let i = 0; i < plan.days.length; i++) {
    const items = plan.days[i].items || []
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      if (item.type === 'poi' && String(item.poiId) === String(id)) {
        return {
          id: item.poiId,
          name: item.name,
          category: item.category,
          tags: item.tags || [],
          lng: item.lng,
          lat: item.lat,
          address: item.address,
          rating: item.rating,
          cost: item.unitCost,
          duration: item.minutes,
          openTime: item.openTime,
          tips: item.tips,
          outdoor: item.outdoor,
          fetchedAt: 0
        }
      }
    }
  }
  return null
}

Page({
  data: {
    poi: null,
    empty: false,
    planPoi: null,
    hasScore: false,
    parts: [],
    guides: [],
    dayLabel: '',
    cityName: '',
    ratingText: '—',
    reviewsText: '',
    costText: '',
    durationText: '',
    fetchedText: '更新时间未知'
  },

  onLoad(options) {
    let id = ''
    try {
      id = decodeURIComponent((options && options.id) || '')
    } catch (err) {
      id = String((options && options.id) || '')
    }
    const bundle = storage.getBundle()
    const index = bundle && bundle.plans ? Number(bundle.activeIndex) || 0 : 0
    const plan = bundle && bundle.plans ? bundle.plans[index] || bundle.plans[0] : null

    const planPoi = findPlanPoi(plan, id)
    const poi = storage.findPoi(id) || planPoi || findByItem(plan, id)
    if (!poi) {
      this.setData({ empty: true })
      return
    }

    const cityName =
      poi.city ||
      (bundle && bundle.dest && bundle.dest.name) ||
      (plan && plan.dest && plan.dest.name) ||
      ''

    const related =
      planPoi && planPoi.reasons && planPoi.reasons.length
        ? planPoi.reasons
        : ['综合评分、偏好与通勤成本综合入选']

    // 攻略统一在攻略页按用户输入的城市检索，点位页不再内嵌预置/平台攻略
    const relatedGuides = []

    const scoreParts = planPoi && planPoi.scoreParts ? planPoi.scoreParts : null
    const parts = scoreParts
      ? PART_LABELS.map(({ key, label }) => {
          const value = Math.round((Number(scoreParts[key]) || 0) * 100)
          return { key, label, value, width: Math.min(100, Math.max(4, value)) }
        })
      : []

    const dayIndex = planPoi ? Number(planPoi.dayIndex) : -1
    let dayLabel = ''
    if (plan && plan.days && dayIndex >= 0 && plan.days[dayIndex]) {
      dayLabel = `D${dayIndex + 1} · ${plan.days[dayIndex].dateLabel} ${plan.days[dayIndex].weekday}`
    }

    const rating = Number(poi.rating) || 0
    const reviewsText = poi.reviews ? `${format.popular(poi.reviews)} 条评价` : ''
    const costKnown = poi.cost !== null && poi.cost !== undefined && Number.isFinite(Number(poi.cost))
    const data = {
      poi,
      planPoi: planPoi
        ? {
            ...planPoi,
            reasonsText: related,
            scoreGrade: planPoi.score >= 80 ? '优选' : planPoi.score >= 65 ? '推荐' : '备选'
          }
        : null,
      hasScore: !!planPoi,
      parts,
      guides: relatedGuides,
      dayLabel,
      cityName,
      ratingText: rating ? rating.toFixed(1) : '—',
      reviewsText,
      costText: !costKnown ? '票价未公开' : Number(poi.cost) ? `${format.money(poi.cost)}/人` : '免费',
      durationText: format.duration(Number(poi.duration) || 120),
      fetchedText: poi.fetchedAt ? `${dateUtil.relativeTime(poi.fetchedAt)}更新` : '更新时间未知'
    }

    this.setData(data)
    wx.setNavigationBarTitle({ title: poi.name || '点位详情' })
  },

  navigate() {
    const poi = this.data.poi
    if (!poi || !poi.lng || !poi.lat) {
      wx.showToast({ title: '缺少坐标，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: Number(poi.lat),
      longitude: Number(poi.lng),
      name: poi.name,
      address: poi.address || '',
      scale: 16
    })
  },

  copyInfo() {
    const poi = this.data.poi
    if (!poi) return
    const lines = [
      poi.name,
      poi.category ? `类型：${poi.category}` : '',
      `开放时间：${poi.openTime || '以官方公告为准'}`,
      `建议游玩：${this.data.durationText}`,
      `门票：${this.data.costText}`,
      `地址：${poi.address || '—'}`,
      poi.tips ? `提示：${poi.tips}` : ''
    ].filter(Boolean)
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '点位信息已复制', icon: 'none' })
    })
  },

  copySearch() {
    const poi = this.data.poi
    if (!poi) return
    const keyword = `${this.data.cityName} ${poi.name} 攻略`
    wx.setClipboardData({
      data: keyword,
      success: () => wx.showToast({ title: '已复制搜索词', icon: 'none' })
    })
  },

  goGuide() {
    wx.switchTab({ url: '/pages/guide/guide' })
  },

  goBack() {
    wx.navigateBack()
  }
})
