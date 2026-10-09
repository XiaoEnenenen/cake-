/**
 * 关于我们
 * 改造：标题优先取本店配置（shop-config.js）。
 * 原实现仅读 storage.mallName，而该值会被 api工厂 后台的原店配置写入，
 * 导致标题显示原店名。
 */
const SHOP_CONFIG = require('../../shop-config')

Page({
  data: {

  },
  onLoad(e) {
    const name = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.name) || wx.getStorageSync('mallName') || ''
    wx.setNavigationBarTitle({
      title: '关于' + name,
    })
  },
  onShow() {

  },
})
