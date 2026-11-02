/**
 * 使用帮助：说明这个小程序做什么、按三步怎么用
 */
Page({
  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goGuide() {
    wx.switchTab({ url: '/pages/guide/guide' })
  }
})
