const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()
const wxpay = require('../../utils/pay.js')
app.configLoadOK = () => {
  
}
Page({
  data: {
    tabIndex: 0,
    // ===== 改造：支持从「我的」页带状态参数进入 =====
    // filterStatus 由 onLoad 的 options.status 决定：
    //   '0'    待付款
    //   '1'    待取货（自提场景，对应后端「制作中」）
    //   '3'    已完成
    //   'all'  全部订单
    //   空     不筛选（走原有 tab 逻辑，保持向后兼容）
    filterStatus: '',
    filterTitle: ''
  },
  onLoad: function (options) {
    const status = options && options.status
    const TITLES = {
      '0': '待付款',
      '1': '待取货',
      '3': '已完成',
      'all': '全部订单'
    }
    if (status !== undefined && status !== null && status !== '') {
      this.setData({
        filterStatus: String(status),
        filterTitle: TITLES[String(status)] || '我的订单'
      })
      wx.setNavigationBarTitle({
        title: TITLES[String(status)] || '我的订单'
      })
    }
  },
  onShow: function () {
    AUTH.checkHasLogined().then(isLogined => {
      if (isLogined) {
        this.orderList()
      } else {
        AUTH.authorize().then(res => {
          this.orderList()
        })
      }
    })
  },
  async orderList() {
    let statusBatch = ''
    // ===== 改造：优先使用「我的」页传入的状态筛选 =====
    if (this.data.filterStatus !== '') {
      statusBatch = this.data.filterStatus === 'all' ? '' : this.data.filterStatus
    } else if (this.data.tabIndex == 0) {
      // 原有逻辑：当前订单
      statusBatch = '0, 1, 2'
    } else {
      // 原有逻辑：历史订单
      statusBatch = '-1, 3, 4'
    }
    wx.showLoading({
      title: '...',
    })
    // https://www.yuque.com/apifm/nu0f75/uwggsm
    const res = await API.orderList({
      token: wx.getStorageSync('token'),
      statusBatch
    })
    wx.hideLoading()
    if (res.code == 0) {
      res.data.orderList.forEach(ele => {
        if (ele.status == 1) {
          ele.statusStr = '制作中'
        }
        if (ele.status == 3) {
          ele.statusStr = '交易成功'
        }
      })
      this.setData({
        orderList: res.data.orderList,
        logisticsMap: res.data.logisticsMap,
        goodsMap: res.data.goodsMap
      })
    } else {
      this.setData({
        orderList: null
      })
    }
  },
  changeTab(e) {
    const tabIndex = e.currentTarget.dataset.index
    // 改造：用户手动点 tab 时清除外部传入的状态筛选，
    //       否则「待付款」筛选会覆盖 tab 的「当前订单/历史订单」逻辑。
    this.setData({
      tabIndex,
      filterStatus: '',
      filterTitle: ''
    })
    wx.setNavigationBarTitle({ title: '我的订单' })
    this.orderList()
  },
  tabbarChange(e) {
    app.tabbarChange(e)
  },
  cancelOrderTap: function(e) {
    const that = this;
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确定要取消该订单吗？',
      content: '',
      success: function(res) {
        if (res.confirm) {
          // https://www.yuque.com/apifm/nu0f75/wh4rrs
          API.orderClose(wx.getStorageSync('token'), orderId).then(function(res) {
            if (res.code == 0) {
              that.orderList();
            }
          })
        }
      }
    })
  },
  deleteorder: function(e) {
    const that = this;
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确定要删除该订单吗？',
      content: '',
      success: function(res) {
        if (res.confirm) {
          // https://www.yuque.com/apifm/nu0f75/eex4bb
          API.orderDelete(wx.getStorageSync('token'), orderId).then(function(res) {
            if (res.code == 0) {
              that.orderList();
            }
          })
        }
      }
    })
  },
  // 联系门店：直接使用 shop-config.js 的固定门店电话
  // 2026-09-26 阶段二改造：原实现是 API.shopSubdetail(id) -> res.data.info.linkPhone，
  //   而单店模式下云函数的 shopSubdetail 是「固定返回失败」的兼容桩（按钮点了必然报错）。
  //   现改为读本店固定配置（与 pages/my 的 callShop 行为一致），交互不变、功能真正可用。
  callShop(e) {
    const phone = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.phone) || ''
    if (!phone) {
      wx.showToast({
        title: '暂未设置门店电话',
        icon: 'none'
      })
      return
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: (err) => {
        // 用户主动取消不提示
        if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
          console.error(err)
        }
      }
    })
  },
  toPayTap: function(e) {
    // 防止连续点击--开始
    if (this.data.payButtonClicked) {
      wx.showToast({
        title: '休息一下~',
        icon: 'none'
      })
      return
    }
    this.data.payButtonClicked = true
    setTimeout(() => {
      this.data.payButtonClicked = false
    }, 3000)  // 可自行修改时间间隔（目前是3秒内只能点击一次支付按钮）
    // 防止连续点击--结束
    const that = this;
    const orderId = e.currentTarget.dataset.id;
    const money = e.currentTarget.dataset.money;
    // 2026-09-26 阶段二：已删除会员积分/余额逻辑。
    // 删除内容：API.userAmount 查询余额、"积分不足"校验、"可用余额/扣除积分"提示、
    //           money = money - balance 的抵扣计算、余额足够时走 orderPayV2 的分支。
    // 原因：会员卡 / 积分 / 余额体系整体删除（orderPayV2 与云函数 orderPay action 已移除）。
    // 现行为：仍保留"请确认支付"确认弹窗（交互不变），确认后统一走微信支付。
    wx.showModal({
      title: '请确认支付',
      content: '订单金额: ' + money + ' 元',
      confirmText: "确认支付",
      cancelText: "取消支付",
      success: function (res) {
        if (res.confirm) {
          that._toPayTap(orderId, money)
        } else {
          console.log('用户点击取消支付')
        }
      }
    });
  },
  _toPayTap: function (orderId, money){
    // 2026-09-26 阶段二：已删除余额支付分支（money <= 0 时走 orderPayV2）。
    // 现统一走微信支付统一下单；云开发支付接入前会提示"云开发支付尚未接入"。
    wxpay.wxpay('order', money, orderId, "/pages/current-order/index");
  },
})
