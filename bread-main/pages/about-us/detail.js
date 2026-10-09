// 2026-09-26 阶段一：数据来源改走统一数据层（云函数优先，api工厂仅作降级备用）
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const app = getApp()
// 2026-09-26 阶段二：已移除未使用的 @vant/weapp dialog 导入与 pay.js 引用（死引用清理）
app.configLoadOK = () => {
  
}
Page({
  data: {

  },
  onLoad: function (options) {
    // options.key = 'qa'
    this.cmsPage(options.key)
  },
  onShow: function () {

  },
  async cmsPage(key) {
    // https://www.yuque.com/apifm/nu0f75/utgp8i
    const res = await API.cmsPage(key)
    if (res.code == 0) {
      this.setData({
        cmsPage: res.data
      })
      wx.setNavigationBarTitle({
        title: res.data.info.title,
      })
    }
  },
})