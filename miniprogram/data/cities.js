/**
 * 目的地城市：不内置任何预设城市与坐标
 *
 * 目的地、行政区划码与中心坐标全部来自高德 / 百度的实时检索结果（见 services/plan.js）。
 * 保留 getCity 仅为兼容旧调用，未命中时返回 null。
 */
const CITIES = []
const CITY_INDEX = {}

function getCity() {
  return null
}

module.exports = {
  CITIES,
  CITY_INDEX,
  getCity
}
