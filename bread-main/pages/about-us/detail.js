// 2026-09-26 阶段一：数据来源改走统一数据层。
// 2026-10-09 阶段三：统一数据层只有云开发一条通道（api 工厂降级通道已删除）。
const API = require('../../utils/api-map')
const LOG = require('../../utils/log')
// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩（api 工厂时代遗留的启动回调，
// 本页内容由 cmsPage 直接拉取，不依赖启动配置）。
// 2026-10-14 审查修复：
//   ① 删除死导入 `const AUTH = require('../../utils/auth')`（本页从不用它）；
//   ② 加载失败时原来**什么都不做**：cmsPage 保持 null，而 wxml 直接写
//      `{{cmsPage.info.title}}` / `html="{{cmsPage.info.content}}"`（在 null 上取二级字段）
//      → 白屏、无提示、无重试，导航标题也空着。现在补 加载中 / 失败可重试 / 正常 三态。
Page({
  data: {
    // 内容单页数据（cmsPage 返回 { info: { title, content } }）
    // 2026-10-12 复核整改：wxml 读 cmsPage.info.*，按本项目约定显式声明。
    cmsPage: null,
    // 2026-10-14：区分"还没加载完"与"加载失败"
    loaded: false,
    loadError: false
  },
  onLoad: function (options) {
    // options.key = 'qa'
    this.pageKey = (options && options.key) || ''
    this.cmsPage(this.pageKey)
  },
  async cmsPage(key) {
    // https://www.yuque.com/apifm/nu0f75/utgp8i
    const res = await API.cmsPage(key)
    const info = res && res.code == 0 && res.data && res.data.info ? res.data.info : null
    if (!info) {
      // 失败（或返回体不完整）：明确提示 + 可重试，而不是白屏
      LOG.warn('[cmsPage] 内容页加载失败', { key: key, res: res })
      this.setData({ cmsPage: null, loaded: true, loadError: true })
      wx.setNavigationBarTitle({ title: '加载失败' })
      return
    }
    this.setData({
      cmsPage: res.data,
      loaded: true,
      loadError: false
    })
    wx.setNavigationBarTitle({
      title: info.title || '详情',
    })
  },
  // wxml 里的「点击重试」
  retry() {
    this.setData({ loaded: false, loadError: false })
    this.cmsPage(this.pageKey)
  }
})
