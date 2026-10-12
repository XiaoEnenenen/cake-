/**
 * 关于我们
 * 改造：标题优先取本店配置（shop-config.js）。
 * 原实现仅读 storage.mallName，而该值会被 api工厂 后台的原店配置写入，
 * 导致标题显示原店名。
 */
const SHOP_CONFIG = require('../../shop-config')

Page({
  data: {
    // 版本文案（2026-10-12 阶段 5.7：不再在 wxml 里写死「Version 1.0 17:30:54」）
    versionText: ''
  },
  onLoad(e) {
    const name = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.name) || wx.getStorageSync('mallName') || ''
    wx.setNavigationBarTitle({
      title: '关于' + name,
    })
    this.setData({ versionText: this.buildVersionText() })
  },

  /**
   * 阶段 5.7（报告 §4.3）：关于页原来硬编码「Version 1.0 17:30:54」——
   * 那是模板遗留的假数据，发多少次版都不会变，等于没有信息，还会误导排查。
   * 改为读微信运行时给出的版本信息（`wx.getAccountInfoSync`）：
   *   开发版 → develop，体验版 → trial，正式版 → 线上版本号。
   * 老基础库没有该接口时返回空串，页面直接不显示这一行。
   */
  buildVersionText() {
    try {
      if (typeof wx.getAccountInfoSync !== 'function') return ''
      const info = (wx.getAccountInfoSync() || {}).miniProgram || {}
      const label = info.version && info.version !== 'develop'
        ? info.version
        : (info.envVersion || '')
      return label ? '版本 ' + label : ''
    } catch (err) {
      return ''
    }
  },
})
