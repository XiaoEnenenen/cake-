const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()


Page({
  data: {
    wxlogin: false,
    curbanner: 0,
    // 2026-10-12 复核整改：wxml 读 banners / shop，按本项目约定显式声明
    banners: [],
    shop: {}
  },  
  onLoad: function () {
    this.configLoadOK()
    this.banners()
    // 2026-09-26 阶段二：已删除多门店（定位找最近门店）遗留代码。
    // 删除内容：整段注释掉的 wx.getLocation 块、被 if(false) 守卫包裹的 fetchShops() 方法、
    //          以及 shop-config.js 的 enableMultiStore 开关。
    // 现门店信息唯一来源：shop-config.js → storage.shopInfo（单店固定配置）。
    // 2026-10-12 复核整改（D-06 同族）：storage 里可能是旧版本写入的、缺字段的值，
    // 合并后再保证展示字段一定有值 —— 这样 wxml 里就不需要
    // `|| '08:00-20:00'` / `|| '卿欢蛋糕'` 这类与配置不同步的兜底字面量。
    const stored = wx.getStorageSync('shopInfo') || null
    const shop = Object.assign({}, SHOP_CONFIG.shop, stored || {})
    shop.name = shop.name || SHOP_CONFIG.shop.name || ''
    shop.openingHours = shop.openingHours || SHOP_CONFIG.shop.openingHours || ''
    wx.setStorageSync('shopInfo', shop)
    this.setData({
      shop
    })
    getApp().configLoadOK = () => {
      this.configLoadOK()
    }
  },
  configLoadOK() {
    // 改造：门店名优先取本店配置（shop-config.js），storage 仅作兜底。
    // 原因：storage.mallName 可能被后台的原店配置写入，导致标题显示原店名。
    // 2026-10-12 复核整改（D-06 同族）：去掉最后的 '卿欢蛋糕' 字面量兜底 ——
    // shop-config.js 的 shop.name 是唯一出处，tests/test-stage5.js 会断言它非空，
    // 所以"配置里没店名"这种情况不该用页面里的第二个字面量来掩盖。
    const configured = SHOP_CONFIG.shop && SHOP_CONFIG.shop.name
    const title = configured || wx.getStorageSync('mallName') || ''
    wx.setNavigationBarTitle({
      title
    })
  },
  onShow() {
    AUTH.checkHasLogined().then(isLogined => {
      this.setData({
        wxlogin: isLogined
      })
    })
  },
  // 2026-09-26 阶段二：下拉刷新保持原有交互（无业务动作）。
  // 原实现会在刷新完成后跳到「会员卡」页；会员体系删除后不再跳转。
  onPullDownRefresh() {
    wx.stopPullDownRefresh()
  },
  async banners() {
    // https://www.yuque.com/apifm/nu0f75/ms21ki
    const res = await API.banners()
    if (res.code == 0) {
      this.setData({
        banners: res.data
      })
    }
  },
  bannerChange(e) {
    this.setData({
      curbanner: e.detail.current
    })
  },
  // 2026-09-26 阶段二：已删除 fetchShops()（多门店遗留死代码，原被 if(false) 守卫包裹）
  tabbarChange(e) {
    app.tabbarChange(e)
  },
})
