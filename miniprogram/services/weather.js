/**
 * 天气服务 + 穿衣建议
 *
 * 预报能力说明：
 *  - 高德天气：仅未来 4 天（无降水概率字段，按天气现象估算）
 *  - 和风天气：7 天（含降水概率，推荐）
 *  - 超出预报范围的日期：标注「暂无预报」，不使用气候常年代填，也不做穿衣推测
 */
const api = require('./api')
const storage = require('./storage')
const dateUtil = require('../utils/date')

function rainProbFromText(text) {
  const value = String(text || '')
  if (/暴雨|大雨|雷阵雨|中雨/.test(value)) return 85
  if (/小雨|阵雨|雨夹雪/.test(value)) return 65
  if (/雪/.test(value)) return 55
  if (/阴/.test(value)) return 32
  if (/多云/.test(value)) return 18
  if (/雾|霾/.test(value)) return 15
  return 6
}

function uvFromText(text, month) {
  const base = [2, 3, 4, 6, 7, 8, 9, 8, 6, 5, 3, 2][month] || 4
  if (/雨|阴/.test(String(text || ''))) return Math.max(1, base - 3)
  if (/多云/.test(String(text || ''))) return Math.max(2, base - 1)
  return base
}

function normalizeAmap(data) {
  if (data.status !== '1' || !data.forecasts || !data.forecasts[0]) {
    throw api.makeError('WEATHER_FAIL', data.info || '高德天气获取失败')
  }
  const casts = data.forecasts[0].casts || []
  return casts.map((item) => {
    const month = dateUtil.parseDate(item.date).getMonth()
    const rainProb = rainProbFromText(`${item.dayweather}${item.nightweather}`)
    return {
      date: item.date,
      weekday: dateUtil.weekdayCN(item.date),
      dayWeather: item.dayweather,
      nightWeather: item.nightweather,
      dayTemp: Number(item.daytemp),
      nightTemp: Number(item.nighttemp),
      windDir: item.daywind,
      windScale: item.daypower ? `${item.daypower}级` : '',
      rainProb,
      humidity: Math.round(35 + rainProb / 2),
      uvIndex: uvFromText(item.dayweather, month),
      source: 'amap',
      outOfRange: false,
      rainProbEstimated: true
    }
  })
}

function normalizeQweather(data) {
  if (!data || data.code !== '200' || !data.daily) {
    throw api.makeError('WEATHER_FAIL', `和风天气返回异常（code=${data && data.code}）`)
  }
  return data.daily.map((item) => {
    const month = dateUtil.parseDate(item.fxDate).getMonth()
    const rainProb = Number(item.pop) || rainProbFromText(`${item.textDay}${item.textNight}`)
    return {
      date: item.fxDate,
      weekday: dateUtil.weekdayCN(item.fxDate),
      dayWeather: item.textDay,
      nightWeather: item.textNight,
      dayTemp: Number(item.tempMax),
      nightTemp: Number(item.tempMin),
      windDir: item.windDirDay,
      windScale: item.windScaleDay ? `${item.windScaleDay}级` : '',
      rainProb,
      humidity: Number(item.humidity) || 55,
      uvIndex: Number(item.uvIndex) || uvFromText(item.textDay, month),
      source: 'qweather',
      outOfRange: false
    }
  })
}

function normalizeBaidu(data) {
  const result = (data && data.result) || {}
  const list = result.forecast_15d || result.forecast_24h || result.forecasts || []
  if (!list.length) throw api.makeError('WEATHER_FAIL', '百度天气暂无预报数据')
  return list.map((item) => {
    const dateStr = (item.date || '').replace(/\//g, '-')
    const month = dateUtil.parseDate(dateStr).getMonth()
    const textDay = item.text_day || item.textDay || item.weather || ''
    const textNight = item.text_night || item.textNight || textDay
    const rainProb = Number(item.pop) || rainProbFromText(`${textDay}${textNight}`)
    return {
      date: dateStr,
      weekday: dateUtil.weekdayCN(dateStr),
      dayWeather: textDay,
      nightWeather: textNight,
      dayTemp: Number(item.high || item.tempMax || 0),
      nightTemp: Number(item.low || item.tempMin || 0),
      windDir: item.wind_direction_day || item.windDir || '',
      windScale: item.wind_scale_day ? `${item.wind_scale_day}级` : '',
      rainProb,
      humidity: Number(item.humidity) || Math.round(35 + rainProb / 2),
      uvIndex: uvFromText(textDay, month),
      source: 'baidu',
      outOfRange: false
    }
  })
}

function missingDay(dateStr, fetchedAt) {
  // 超出现有预报范围时不做任何气候常年代填，明确标注为暂无数据
  return {
    date: dateStr,
    weekday: dateUtil.weekdayCN(dateStr),
    dayWeather: '暂无预报',
    nightWeather: '',
    dayTemp: null,
    nightTemp: null,
    windDir: '',
    windScale: '',
    rainProb: null,
    humidity: null,
    uvIndex: null,
    source: 'none',
    outOfRange: true,
    fetchedAt,
    note: '该日暂无实时预报'
  }
}

/**
 * 获取与行程日期对齐的天气
 * @returns { list, meta: { provider, fetchedAt, realCount, outOfRangeCount } }
 */
async function getForecast(options) {
  const { cityName, adcode, lat, lng, startDate, days, force } = options
  const settings = storage.getSettings()
  const dates = dateUtil.dateList(startDate, days)

  const coordinates = resolveCoords(lat, lng)
  let provider = ''
  let fetchedAt = 0
  let normalized = []

  let caps = null
  try {
    // 刷新实时数据时同步重新探测云端能力，避免沿用 10 分钟内的旧结果
    caps = await api.getCapabilities({ force })
  } catch (err) {
    caps = null
  }
  const qweatherReady = caps ? !!caps.qweather : !!settings.keys.qweather

  if (qweatherReady && coordinates) {
    try {
      const { data, meta } = await api.call(
        'weather7d',
        { lng: coordinates.lng, lat: coordinates.lat },
        { force }
      )
      normalized = normalizeQweather(data)
      provider = 'qweather'
      fetchedAt = meta.fetchedAt
    } catch (err) {
      console.warn('[weather] 7 天预报不可用，回退地图商天气', err.message)
    }
  }

  if (!normalized.length) {
    try {
      const { data, meta } = await api.call(
        'weather',
        { city: adcode || cityName },
        { force }
      )
      if (meta.provider === 'baidu') normalized = normalizeBaidu(data)
      else if (meta.provider === 'qweather') normalized = normalizeQweather(data)
      else normalized = normalizeAmap(data)
      provider = meta.provider
      fetchedAt = meta.fetchedAt
    } catch (err) {
      console.warn('[weather] 实时天气不可用', err.message)
    }
  }

  const map = {}
  normalized.forEach((item) => {
    if (!item.fetchedAt) item.fetchedAt = fetchedAt || Date.now()
    map[item.date] = item
  })

  const list = dates.map((date) => map[date] || missingDay(date, fetchedAt || Date.now()))
  const realCount = list.filter((item) => !item.outOfRange).length
  const missingCount = list.length - realCount

  return {
    list,
    meta: {
      provider: provider || 'none',
      fetchedAt: fetchedAt || Date.now(),
      realCount,
      outOfRangeCount: missingCount,
      note:
        realCount === 0
          ? '所选日期暂无实时预报，出行前请复核最新天气'
          : missingCount
            ? `${missingCount} 天暂无实时预报`
            : ''
    }
  }
}

/** 仅使用调用方给出的坐标；不再回退到任何预设城市中心点 */
function resolveCoords(lat, lng) {
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(lat) && Number(lng)) {
    return { lat: Number(lat), lng: Number(lng) }
  }
  return null
}

/**
 * 穿衣建议
 */
function clothingAdvice(day) {
  const known = Number.isFinite(Number(day.dayTemp)) && Number.isFinite(Number(day.nightTemp))
  if (!known) {
    return { level: '—', text: '该日暂无实时预报，不做穿衣建议', items: [], tips: ['出行前请复核最新天气预报'] }
  }
  const avg = (Number(day.dayTemp) + Number(day.nightTemp)) / 2
  const diff = Math.abs(Number(day.dayTemp) - Number(day.nightTemp))
  const items = []
  const tips = []
  let level = '舒适'
  let text = ''

  if (avg >= 29) {
    level = '炎热'
    items.push('速干短袖', '短裤/薄长裤', '透气运动鞋')
    text = '高温天气，轻薄透气为主，室内空调场所备一件薄外套'
  } else if (avg >= 24) {
    level = '偏热'
    items.push('短袖', '薄长裤', '透气鞋')
    text = '白天短袖即可，室内空调与早晚可加薄外套'
  } else if (avg >= 18) {
    level = '舒适'
    items.push('长袖/薄针织', '休闲长裤', '轻便外套')
    text = '早晚温差适中，长袖加一件轻外套最稳妥'
  } else if (avg >= 10) {
    level = '微凉'
    items.push('卫衣/毛衣', '长裤', '风衣或夹克')
    text = '体感偏凉，建议叠穿，方便随温度增减'
  } else if (avg >= 0) {
    level = '寒冷'
    items.push('保暖内衣', '厚外套/羽绒服', '围巾帽子')
    text = '注意保暖，户外久待建议加手套与厚袜'
  } else {
    level = '严寒'
    items.push('羽绒服', '保暖内衣', '手套围巾帽子')
    text = '严寒天气，减少长时间户外停留，做好防寒'
  }

  if (diff >= 9) tips.push(`昼夜温差约 ${diff}℃，随身带一件外套`)
  if ((Number(day.rainProb) || 0) >= 45) tips.push('降水概率较高，带折叠伞或轻便雨衣')
  if ((Number(day.uvIndex) || 0) >= 7) tips.push('紫外线较强，防晒霜、帽子、墨镜备齐')
  if (Number(String(day.windScale).replace('级', '')) >= 4) tips.push('风力较大，外套选防风款')
  if (day.outOfRange) tips.push('该日暂无实时预报，出行前请复核')

  return { level, text, items, tips }
}

/** 基于天气给出活动建议 */
function activityAdvice(day) {
  if (!Number.isFinite(Number(day.rainProb))) {
    return { level: '待定', text: '该日暂无实时预报，活动安排以现场天气为准' }
  }
  const rain = Number(day.rainProb) || 0
  if (rain >= 65) return { level: '室内优先', text: '降雨概率高，优先博物馆/商场等室内点位，户外行程留出弹性' }
  if (rain >= 40) return { level: '室内外搭配', text: '有阵雨可能，户外点位尽量安排在上午，随身带伞' }
  if ((Number(day.dayTemp) || 0) >= 33) return { level: '避开正午', text: '高温时段 12:00-15:00 减少户外暴晒，安排室内或休息' }
  return { level: '适合户外', text: '天气条件不错，可把观景与街区类点位放在主要时段' }
}

module.exports = {
  getForecast,
  clothingAdvice,
  activityAdvice,
  rainProbFromText
}
