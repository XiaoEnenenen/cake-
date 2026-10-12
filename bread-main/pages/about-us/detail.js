// 2026-09-26 阶段一：数据来源改走统一数据层。
// 2026-10-09 阶段三：统一数据层只有云开发一条通道（api 工厂降级通道已删除）。
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩（api 工厂时代遗留的启动回调，
// 本页内容由 cmsPage 直接拉取，不依赖启动配置）。
Page({
  data: {
    // 内容单页数据（cmsPage 返回 { info: { title, content } }）
    // 2026-10-12 复核整改：wxml 读 cmsPage.info.*，按本项目约定显式声明。
    cmsPage: null
  },
  onLoad: function (options) {
    // options.key = 'qa'
    this.cmsPage(options.key)
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