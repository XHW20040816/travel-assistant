const storage = require('../../services/storage')
const mapService = require('../../services/map')
const format = require('../../utils/format')

const PALETTE = ['#A86F00', '#1E9E6A', '#D97B12', '#7C4DD8', '#D5494F']

Page({
  data: {
    plan: null,
    dayTabs: [],
    activeDay: 0,
    markers: [],
    polylines: [],
    includePoints: [],
    center: { latitude: 39.9042, longitude: 116.4074 },
    legs: [],
    dayInfo: null,
    empty: false
  },

  onLoad() {
    const bundle = storage.getBundle()
    if (!bundle || !bundle.plans || !bundle.plans.length) {
      this.setData({ empty: true })
      return
    }
    const index = Number(bundle.activeIndex) || 0
    this.bundle = bundle
    this.plan = bundle.plans[index] || bundle.plans[0]
    this.dest = this.plan.dest || (bundle.request && bundle.request.dest) || {}

    const dayTabs = this.plan.days.map((day, i) => ({
      index: i,
      label: `D${i + 1}`,
      date: day.dateLabel,
      weather: day.weatherText
    }))
    this.setData({ plan: this.plan, dayTabs })
    wx.setNavigationBarTitle({ title: `${this.plan.dest ? this.plan.dest.name : ''} · 路线地图` })
    this.selectDay(0)
  },

  selectDay(e) {
    const index = typeof e === 'number' ? e : Number(e.currentTarget.dataset.index)
    this.setData({ activeDay: index })
    this.buildDay(index)
  },

  buildDay(dayIndex) {
    const day = this.plan.days[dayIndex]
    if (!day) return

    const hotel = this.plan.hotel || { name: '出发点', lng: this.dest.lng, lat: this.dest.lat }
    let cursor = { name: hotel.name, lng: Number(hotel.lng), lat: Number(hotel.lat) }
    let pendingTransit = null
    let poiOrder = 0

    const markers = []
    const legs = []
    const includePoints = []

    if (cursor.lng && cursor.lat) {
      includePoints.push({ longitude: cursor.lng, latitude: cursor.lat })
    }

    day.items.forEach((item, itemIndex) => {
      if (item.type === 'transit') {
        pendingTransit = { item, itemIndex }
        return
      }
      if (item.type !== 'poi') return

      poiOrder++
      const to = { name: item.name, lng: Number(item.lng), lat: Number(item.lat), id: item.poiId }
      if (item.lng && item.lat) {
        markers.push({
          id: 100 + poiOrder,
          latitude: to.lat,
          longitude: to.lng,
          iconPath: '/assets/marker.png',
          width: 28,
          height: 37,
          label: {
            content: `${poiOrder}`,
            color: '#FFFFFF',
            fontSize: 10,
            bgColor: '#A86F00',
            borderRadius: 20,
            padding: 3,
            anchorX: 0,
            anchorY: -22,
            textAlign: 'center'
          },
          callout: {
            content: `${poiOrder}. ${item.name}`,
            color: '#2B2418',
            fontSize: 12,
            borderRadius: 8,
            padding: 8,
            bgColor: '#FFFFFF',
            display: 'BYCLICK',
            textAlign: 'center'
          }
        })
        includePoints.push({ longitude: to.lng, latitude: to.lat })
      }

      if (pendingTransit) {
        const raw = pendingTransit.item
        const mode = raw.mode || 'walk'
        legs.push({
          index: legs.length,
          itemIndex: pendingTransit.itemIndex,
          fromName: cursor.name,
          toName: item.name,
          from: { lng: cursor.lng, lat: cursor.lat, name: cursor.name },
          to: { lng: to.lng, lat: to.lat, name: to.name },
          mode: mode || 'walk',
          modeLabel: format.modeText(mode || 'walk'),
          badge: format.modeBadge(mode || 'walk'),
          minutes: raw.minutes || 0,
          durationText: format.duration(raw.minutes || 0),
          distanceText: format.distance(raw.distance || 0),
          costText: raw.cost ? format.money(raw.cost) : '',
          estimated: !!raw.estimated,
          points: raw.points && raw.points.length ? raw.points : null
        })
      }

      cursor = to
      pendingTransit = null
    })

    // 没有对应 POI 的散段（理论上不会出现）忽略
    if (!legs.length) {
      const target = markers[0]
      if (target) {
        legs.push({
          index: 0,
          itemIndex: -1,
          fromName: hotel.name,
          toName: '首个点位',
          from: { lng: cursor.lng, lat: cursor.lat, name: hotel.name },
          to: { lng: target.longitude, lat: target.latitude, name: '首个点位' },
          mode: 'walk',
          modeLabel: '步行',
          badge: '步',
          minutes: 0,
          durationText: '—',
          distanceText: '—',
          costText: '',
          estimated: true,
          points: null
        })
      }
    }

    const polylines = legs.map((leg, i) => ({
      points: leg.points && leg.points.length
        ? leg.points
        : [
            { longitude: leg.from.lng, latitude: leg.from.lat },
            { longitude: leg.to.lng, latitude: leg.to.lat }
          ],
      color: PALETTE[i % PALETTE.length],
      width: 6,
      dottedLine: !!leg.estimated,
      arrowLine: true,
      borderColor: '#FFFFFF',
      borderWidth: 1
    }))

    const totalMinutes = legs.reduce((sum, leg) => sum + (leg.minutes || 0), 0)
    const dayInfo = {
      date: day.dateLabel,
      weekday: day.weekday,
      weather: `${day.weatherText} ${day.tempText}`,
      clothing: day.clothing ? day.clothing.level : '',
      activity: day.activity ? day.activity.level : '',
      poiCount: markers.length,
      totalTravel: format.duration(totalMinutes),
      legCount: legs.length,
      estimatedCount: legs.filter((leg) => leg.estimated).length
    }

    this.legs = legs
    this.plan = this.plan

    const centerPoint = markers[0] || includePoints[0]
    this.setData({
      markers,
      polylines,
      includePoints,
      legs,
      dayInfo,
      center: centerPoint
        ? { latitude: centerPoint.latitude, longitude: centerPoint.longitude }
        : { latitude: 39.9042, longitude: 116.4074 }
    })
  },

  onMarkerTap(e) {
    const markerId = e.detail.markerId
    const index = markerId - 100 - 1
    const day = this.plan.days[this.data.activeDay]
    const pois = day.items.filter((item) => item.type === 'poi')
    const poi = pois[index]
    if (!poi) return
    wx.navigateTo({ url: `/pages/poi/poi?id=${encodeURIComponent(poi.poiId)}` })
  },

  navTo(e) {
    const index = Number(e.currentTarget.dataset.index)
    const leg = this.legs[index]
    if (!leg) return
    wx.openLocation({
      latitude: Number(leg.to.lat),
      longitude: Number(leg.to.lng),
      name: leg.toName,
      scale: 16
    })
  },

  async switchMode(e) {
    const index = Number(e.currentTarget.dataset.index)
    const mode = e.currentTarget.dataset.mode
    const leg = this.legs[index]
    if (!leg || leg.mode === mode) return
    if (!leg.from.lng || !leg.to.lng) {
      wx.showToast({ title: '缺少坐标，无法重算', icon: 'none' })
      return
    }

    wx.showLoading({ title: '重新计算路线', mask: true })
    try {
      const result = await mapService.routePlan({
        from: leg.from,
        to: leg.to,
        mode,
        city: (this.dest && this.dest.name) || '',
        cityd: (this.dest && this.dest.adcode) || ''
      })
      const day = this.plan.days[this.data.activeDay]
      const item = day.items[leg.itemIndex]
      if (item) {
        item.mode = mode
        item.modeText = mode
        item.modeLabel = format.modeText(mode)
        item.minutes = result.minutes
        item.distance = result.distance
        item.points = result.points
        item.estimated = !!result.estimated
        item.cost = result.costEstimate || item.cost || 0
      }
      storage.saveBundle(this.bundle)
      this.buildDay(this.data.activeDay)
      wx.hideLoading()
      wx.showToast({
        title: `${format.modeText(mode)}约 ${format.duration(result.minutes)}`,
        icon: 'none'
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '重算失败', icon: 'none' })
    }
  },

  goWeather() {
    wx.navigateTo({ url: '/pages/weather/weather' })
  },

  goPlan() {
    wx.navigateBack()
  }
})
