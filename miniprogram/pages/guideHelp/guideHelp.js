/**
 * 项目介绍：说明这个小程序做什么、功能结构、技术方案与已知限制
 */
const storage = require('../../services/storage')
const config = require('../../config/index')

Page({
  data: {
    llmReady: false,
    mapReady: 0,
    hasAmap: false,
    hasBaidu: false,
    hasQweather: false,
    dataSource: 'cloud',
    guideFn: config.guideFn,
    model: storage.DEFAULT_LLM.model
  },

  onShow() {
    const settings = storage.getSettings()
    const keys = settings.keys || {}
    const llm = storage.getLlmConfig()
    this.setData({
      llmReady: storage.hasLlmConfig(),
      hasAmap: !!keys.amap,
      hasBaidu: !!keys.baidu,
      hasQweather: !!keys.qweather,
      mapReady: [keys.amap, keys.baidu, keys.qweather].filter(Boolean).length,
      dataSource: settings.dataSource,
      guideFn: settings.guideFn || config.guideFn,
      model: (llm && llm.model) || storage.DEFAULT_LLM.model
    })
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goGuide() {
    wx.switchTab({ url: '/pages/guide/guide' })
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' })
  }
})
