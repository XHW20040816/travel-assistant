const config = require('./config/index')
const storage = require('./services/storage')

App({
  globalData: {
    config,
    settings: null,
    systemInfo: null
  },

  onLaunch() {
    this.globalData.systemInfo = wx.getSystemInfoSync()
    this.globalData.settings = storage.getSettings()
    this.initCloud()
  },

  initCloud() {
    const settings = this.globalData.settings
    if (!wx.cloud) return
    const env = settings.cloudEnv || config.cloudEnv
    try {
      wx.cloud.init({
        env: env || undefined,
        traceUser: true
      })
      this.globalData.cloudReady = true
    } catch (err) {
      this.globalData.cloudReady = false
      console.warn('[cloud] init failed', err)
    }
  },

  onShow() {
    this.globalData.settings = storage.getSettings()
  }
})
