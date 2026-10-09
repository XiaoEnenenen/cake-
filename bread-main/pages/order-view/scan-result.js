const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()
app.configLoadOK = () => {
  
}
Page({
  data: {
    // 改造：核销结果页同样显示「本店位置」地图卡片（来自固定配置，不调用定位 API）
    shop: SHOP_CONFIG.shop,
    shopMarkers: [{
      id: 1,
      latitude: SHOP_CONFIG.shop.latitude,
      longitude: SHOP_CONFIG.shop.longitude,
      width: 32,
      height: 32,
      callout: {
        content: SHOP_CONFIG.shop.name,
        color: '#333333',
        fontSize: 12,
        borderRadius: 6,
        padding: 6,
        bgColor: '#ffffff',
        display: 'ALWAYS'
      }
    }]
  },
  onLoad: function (options) {
    // options.hxNumber = '2005200818567533'
    this.setData({
      hxNumber: options.hxNumber
    });
    this.orderDetail()
  },
  onShow: function () {

  },
  async orderDetail() {
    // https://www.yuque.com/apifm/nu0f75/oamel8
    const res = await API.orderDetail(wx.getStorageSync('token'), '', this.data.hxNumber)
    if (res.code == 0) {
      this.setData({
        orderDetail: res.data
      })
      // 2026-09-26 阶段二：原此处会调 this.shopSubdetail(...)，多门店功能已删除
    }
  },
  // 2026-09-26 阶段二：已删除本页两段死代码
  //   1) shopSubdetail()：多门店门店详情，调用点早已注释
  //   2) getDistance()：原用于计算用户与门店距离，含不可达的 toRadians 调用（若执行必抛错）
  // 说明：api-map 的 shopSubdetail 与云函数兼容桩按约定保留，仅清理本页死代码。
  async doneHx(){
    wx.showLoading({
      title: '处理中...',
    })
    // https://www.yuque.com/apifm/nu0f75/sq4sma
    const res = await API.orderHXV2({
      token: wx.getStorageSync('token'),
      hxNumber: this.data.hxNumber
    })
    wx.hideLoading()
    if (res.code != 0) {
      wx.showModal({
        title: '错误',
        content: res.msg,
        showCancel: false
      })
    } else {
      wx.showModal({
        title: '核销完成',
        content: '当前订单核销成功',
        showCancel: false
      })
      this.orderDetail()
    }
  },
})
