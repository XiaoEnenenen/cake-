const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const FMT = require('../../utils/format')
// 2026-10-12：待支付订单「剩余 mm:ss 自动取消」倒计时（与订单列表页同一份实现）
const OS = require('../../utils/order-status')
const COUNTDOWN = require('../../utils/order-countdown')
// 2026-10-10：扫码核销下线，本页不再绘制核销二维码，wxbarcode 依赖已移除。
// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩与随之无用的 getApp()。
Page({
  data: {
    // 改造：订单详情页显示「本店位置」地图卡片（来自固定配置，不调用任何定位 API）
    // 2026-10-09：地图 / 门店标记 / 用户定位 / 距离 / 一键导航已收敛到
    //             components/shop-map 组件，本页不再自己拼 shopMarkers。
    shop: SHOP_CONFIG.shop,
    // 2026-10-12：模板里判断状态用统一常量（避免 WXML 里出现魔数）
    ST: OS.STATUS,
    // 待支付订单的倒计时文案（'' = 不显示）
    cancelRemainText: '',
    // 本机时钟相对服务端时钟的偏移（毫秒）
    serverOffset: 0,
    // ===== 阶段 5.6（缺陷 P-07 / P-08）：加载失败要有明确提示 =====
    // 原来接口失败（或云函数返回体缺 data.orderInfo）时什么都不做，
    // 页面只剩一堆空的标题行，顾客看到的是"白屏"，既不知道出了什么事也没法重试。
    loadError: false,
    // 阶段 5.6 复核整改：加载中也要与"已加载"区分，否则慢网下先看到的
    // 就是一屏空标题行（正是本次要消灭的现象）。
    loaded: false,
    // 2026-10-12 复核整改：wxml 读到的字段显式声明（本项目约定）
    orderDetail: null
  },
  onLoad: function (options) {
    // options.id = 516189
    this.setData({
      orderId: options.id
    })
    this.orderDetail()
  },
  onShow: function () {
    // 2026-10-12：从其他页面返回时刷新一次（onHide 已经停掉倒计时定时器）。
    // 首次进入时不重复请求：那时 onLoad 刚发过 orderDetail()，还没有数据。
    if (this.data.orderDetail) this.orderDetail()
  },
  // 2026-10-12：倒计时定时器必须随页面隐藏/卸载停掉，否则离开页面后仍在每秒 setData
  onHide: function () {
    this.stopCountdown()
  },
  onUnload: function () {
    this.stopCountdown()
  },
  async orderDetail() {
    // https://www.yuque.com/apifm/nu0f75/oamel8
    const res = await API.orderDetail(wx.getStorageSync('token'), this.data.orderId)
    // 阶段 5.6：原来只判断 res.code == 0 就往下取 res.data.orderInfo.*，
    // 后端返回体异常时会抛 TypeError（弱网/部署不完整时真机上就是这么白屏的）。
    if (res.code == 0 && res.data && res.data.orderInfo) {
      // 阶段 4.1：不再覆盖服务端返回的 statusStr（文案的唯一出处是云函数，
      // orderDetail 已按 status 现算，含 0/-1/1/3 四种）。
      // 2026-10-10 修复：dateAdd 是毫秒时间戳，直接渲染会显示 13 位数字
      res.data.orderInfo.dateAddText = FMT.formatDateTime(res.data.orderInfo.dateAdd, { placeholder: '—' })
      // 2026-10-10：外送订单的地图气泡显示订单快照里的「配送距离」（收货地址 → 门店），
      // 不再显示"当前用户位置到门店"的距离 —— 顾客或店主看这张单时人在哪里都可能。
      // 自提订单留空，由 shop-map 显示「距离您 X」（去店里取，这个距离才有意义）。
      const snapshot = res.data.extJson && res.data.extJson['配送距离']
      res.data.orderInfo.mapDistanceText =
        (res.data.orderInfo.deliveryMode === 'delivery' && snapshot)
          ? '配送距离 ' + snapshot
          : ''
      // 2026-10-10：核销二维码已下线（扫码核销不需要了），
      // 自提订单改为展示「取餐码」（= 订单号后 4 位，由云函数返回）。
      this.setData({
        orderDetail: res.data,
        loadError: false,
        loaded: true,
        // 2026-10-12：用服务端时间对齐倒计时
        serverOffset: COUNTDOWN.clockOffsetOf(res.data.serverNow, Date.now())
      })
      this.startCountdown()
      // 2026-09-26 阶段二：原此处会调 this.shopSubdetail(...)，多门店功能已删除
    } else {
      this.stopCountdown()
      this.setData({ orderDetail: null, loadError: true, loaded: true })
    }
  },
  /**
   * 阶段 5.6：错误态的重试入口（wxml 里的「点击重试」）。
   */
  retryLoad() {
    this.setData({ loadError: false, loaded: false })
    this.orderDetail()
  },
  // ===== 2026-10-12：待支付订单自动取消倒计时 =====
  // 与订单列表页同一套逻辑：只做展示，真正的取消在云函数（定时触发器 + 读取兜底）。
  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer)
      this._countdownTimer = null
    }
  },
  startCountdown() {
    this.stopCountdown()
    const info = this.data.orderDetail && this.data.orderDetail.orderInfo
    if (!COUNTDOWN.isPending(info)) {
      this.setData({ cancelRemainText: '' })
      return
    }
    this._countdownTimer = setInterval(() => this.tickCountdown(), 1000)
    this.tickCountdown()
  },
  tickCountdown() {
    const info = this.data.orderDetail && this.data.orderDetail.orderInfo
    if (!COUNTDOWN.isPending(info)) {
      this.stopCountdown()
      this.setData({ cancelRemainText: '' })
      return
    }
    const now = Date.now()
    const cd = COUNTDOWN.countdownOf(info, this.data.serverOffset, now)
    this.setData({ cancelRemainText: cd.remainText })
    // 到点：重新拉一次详情，服务端的读取兜底会把它置为「已取消」。
    // 3 秒节流 + 5 次上限，避免异常时钟导致无限刷新。
    if (cd.expired) {
      if (this._expireReloads >= 5) {
        this.stopCountdown()
        return
      }
      if (!this._lastExpireReloadAt || now - this._lastExpireReloadAt > 3000) {
        this._lastExpireReloadAt = now
        this._expireReloads = (this._expireReloads || 0) + 1
        this.orderDetail()
      }
    } else {
      this._expireReloads = 0
    }
  },
  // 2026-09-26 阶段二：已删除本页两段死代码
  //   1) shopSubdetail()：多门店门店详情，调用点早已注释
  //   2) getDistance()：原用于计算用户与门店距离，含不可达的 toRadians 调用（若执行必抛错）
  // 说明：api-map 的 shopSubdetail 与云函数兼容桩按约定保留，仅清理本页死代码。
})
