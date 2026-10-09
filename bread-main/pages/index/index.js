const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()


Page({
  data: {
    wxlogin: false,
    curbanner: 0
  },  
  onLoad: function () {
    this.configLoadOK()
    this.banners()
    // 2026-09-26 阶段二：已删除多门店（定位找最近门店）遗留代码。
    // 删除内容：整段注释掉的 wx.getLocation 块、被 if(false) 守卫包裹的 fetchShops() 方法、
    //          以及 shop-config.js 的 enableMultiStore 开关。
    // 现门店信息唯一来源：shop-config.js → storage.shopInfo（单店固定配置）。
    const shop = wx.getStorageSync('shopInfo') || SHOP_CONFIG.shop
    if (!wx.getStorageSync('shopInfo')) {
      wx.setStorageSync('shopInfo', shop)
    }
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
    const configured = SHOP_CONFIG.shop && SHOP_CONFIG.shop.name
    const title = configured || wx.getStorageSync('mallName') || '卿欢蛋糕'
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
