const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()
import wxbarcode from 'wxbarcode'
app.configLoadOK = () => {
  
}
Page({
  data: {
    // 改造：订单详情页显示「本店位置」地图卡片（来自固定配置，不调用任何定位 API）
    // 2026-10-09：地图 / 门店标记 / 用户定位 / 距离 / 一键导航已收敛到
    //             components/shop-map 组件，本页不再自己拼 shopMarkers。
    shop: SHOP_CONFIG.shop
  },
  onLoad: function (options) {
    // options.id = 516189
    this.setData({
      orderId: options.id
    })
    this.orderDetail()
  },
  onShow: function () {

  },
  async orderDetail() {
    // https://www.yuque.com/apifm/nu0f75/oamel8
    const res = await API.orderDetail(wx.getStorageSync('token'), this.data.orderId)
    if (res.code == 0) {
      if (res.data.orderInfo.status == 1) {
        res.data.orderInfo.statusStr = '制作中'
      }
      if (res.data.orderInfo.status == 3) {
        res.data.orderInfo.statusStr = '交易成功'
      }
      // 绘制核销码
      if (res.data.orderInfo.hxNumber && res.data.orderInfo.status > 0 && res.data.orderInfo.status < 3) {
        wxbarcode.qrcode('qrcode', res.data.orderInfo.hxNumber, 650, 650);
      }  
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
})
