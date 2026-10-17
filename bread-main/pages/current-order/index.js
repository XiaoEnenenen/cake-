const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const FMT = require('../../utils/format')
const ADMIN = require('../../utils/admin')
const OS = require('../../utils/order-status')
// 阶段 5.7：日志统一收敛到 utils/log.js
const LOG = require('../../utils/log')
// 2026-10-12：待支付订单「剩余 mm:ss 自动取消」倒计时（纯计算，见 utils/order-countdown.js）
const COUNTDOWN = require('../../utils/order-countdown')
// app 仅用于自定义 tabbar 的切换（app.tabbarChange）
const app = getApp()
const wxpay = require('../../utils/pay.js')
// 2026-10-17 顾客反馈：退出登录后不允许"再次支付"（必须重新登录）
const LOGIN_GATE = require('../../utils/login-gate')
// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩（api 工厂时代的启动回调）。
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
    filterTitle: '',
    // 2026-10-10：是否店主（决定「完成订单」按钮显不显示）。
    // 仅展示判断，真正的鉴权在云函数 orderFinish（白名单校验）。
    isShopAdmin: false,
    // 阶段 4.1：模板里判断状态用同一份常量（utils/order-status.js），
    // 避免 WXML 里散落 0/1/3/4 这些魔数。
    ST: OS.STATUS,
    // 2026-10-12：本机时钟相对服务端时钟的偏移（毫秒），倒计时用服务端时间为基准，
    // 顾客手机时钟不准也不会把「剩余多久自动取消」算错。
    serverOffset: 0,
    // ===== 阶段 5.6（缺陷 P-07）：空态与错误态必须能区分 =====
    // 原来只有一个 `!orderList` 判断，于是：
    //   · 「确实没有订单」时后端返回 []，`![]` 为 false → 既不渲染卡片也没提示，整页白屏；
    //   · 接口失败时也显示"暂无订单记录"，把"坏了"说成"没数据"。
    // 现在用 loadError（失败）+ loaded（已请求过）两个标志区分三种状态。
    loadError: false,
    loaded: false,
    // 2026-10-12 复核整改：wxml 读到的字段显式声明（本项目约定），
    // 首帧是"加载中"而不是空的订单列表。
    orderList: null,
    logisticsMap: {},
    goodsMap: {}
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
    // ===== 阶段 5.6 复核整改：前置鉴权失败也必须落到错误态 =====
    // AUTH.authorize() 在云函数不通时会 throw（见 utils/auth.js），原来这里没有 .catch →
    // orderList() 永不执行，loaded / loadError 都停在 false，页面既不显示"暂无订单记录"
    // 也不显示错误态（真正的白屏）。现在无论成败都去拉一次列表，由 orderList 给出失败态。
    AUTH.checkHasLogined().then(isLogined => {
      if (isLogined) {
        this.orderList()
      } else {
        AUTH.authorize().then(() => {
          this.orderList()
        }).catch(() => {
          this.orderList()
        })
      }
    }).catch(() => {
      this.orderList()
    })
    // 2026-10-10：判断当前用户是不是店主，决定「完成订单」按钮显不显示
    ADMIN.isShopAdmin().then(isShopAdmin => {
      this.setData({ isShopAdmin })
    }).catch(() => {
      this.setData({ isShopAdmin: false })
    })
  },
  // 2026-10-12：倒计时定时器必须随页面隐藏/卸载停掉，否则离开页面后仍在每秒 setData
  onHide: function () {
    this.stopCountdown()
  },
  onUnload: function () {
    this.stopCountdown()
  },
  async orderList() {
    let statusBatch = ''
    // ===== 改造：优先使用「我的」页传入的状态筛选 =====
    if (this.data.filterStatus !== '') {
      statusBatch = this.data.filterStatus === 'all' ? '' : this.data.filterStatus
    } else if (this.data.tabIndex == 0) {
      // 阶段 4.1：当前订单 = 待支付 + 制作中（原来的 '0, 1, 2' 带着幽灵状态 2）
      statusBatch = OS.statusBatch(OS.CURRENT_STATUS)
    } else {
      // 阶段 4.1：历史订单 = 已取消 + 交易成功（原来的 '-1, 3, 4' 带着幽灵状态 4）
      statusBatch = OS.statusBatch(OS.HISTORY_STATUS)
    }
    wx.showLoading({
      title: '...',
    })
    // ===== 阶段 5.6 复核整改：请求竞态保护 =====
    // 快速切 tab / 从「我的」带不同状态进入时，先发出的请求可能后返回，
    // 会把列表覆盖成上一个 tab 的数据（与点单页 5.4 同类，那边已用 _listSeq 修过）。
    this._listSeq = (this._listSeq || 0) + 1
    const seq = this._listSeq
    // https://www.yuque.com/apifm/nu0f75/uwggsm
    const res = await API.orderList({
      token: wx.getStorageSync('token'),
      statusBatch
    })
    if (seq !== this._listSeq) return // 已有更新的请求在途，丢弃这次过期结果
    wx.hideLoading()
    // 阶段 5.6：除 code 外还要确认返回体里真有 data（且 orderList 是数组），
    // 否则下面读 res.data.orderList 会抛 TypeError；缺字段也不能当成"暂无订单"。
    if (res.code == 0 && res.data && Array.isArray(res.data.orderList)) {
      const list = res.data.orderList
      list.forEach(ele => {
        // 阶段 4.1：不再覆盖服务端返回的 statusStr。
        // 状态文案的唯一出处是云函数（orderList 已按 status 现算），
        // 前端只补一个展示用的时间文案。
        // 2026-10-10：dateAdd 是云函数写入的 Date.now() 毫秒时间戳，
        // 直接渲染会显示成「1791623892357」，这里生成展示文案字段，
        // 原始 dateAdd 保持不动（排序、状态判断等逻辑仍基于原始值）。
        ele.dateAddText = FMT.formatDateTime(ele.dateAdd, { placeholder: '—' })
      })
      this.setData({
        orderList: list,
        logisticsMap: res.data.logisticsMap || {},
        goodsMap: res.data.goodsMap || {},
        loadError: false,
        loaded: true,
        // 2026-10-12：用服务端时间对齐倒计时（响应到达的这一刻记一次偏移）
        serverOffset: COUNTDOWN.clockOffsetOf(res.data.serverNow, Date.now())
      })
      this.startCountdown()
    } else {
      this.stopCountdown()
      // 阶段 5.6：接口失败（或返回体不完整）→ 显示"加载失败 + 重试"，
      // 不再伪装成"暂无订单记录"。
      this.setData({
        orderList: null,
        loadError: true,
        loaded: true
      })
    }
  },

  /**
   * 阶段 5.6：错误态的重试入口（wxml 里的「点击重试」）。
   */
  retryLoad() {
    this.orderList()
  },

  // ===== 2026-10-12：待支付订单自动取消倒计时 =====
  // 只做展示：真正的取消在云函数（定时触发器 + 读取兜底），前端到点后重新拉列表。
  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer)
      this._countdownTimer = null
    }
  },
  startCountdown() {
    this.stopCountdown()
    const hasUnpaid = (this.data.orderList || []).some((o) => COUNTDOWN.isPending(o))
    if (!hasUnpaid) return
    this._countdownTimer = setInterval(() => this.tickCountdown(), 1000)
    this.tickCountdown()
  },
  tickCountdown() {
    const list = this.data.orderList || []
    if (!list.length) {
      this.stopCountdown()
      return
    }
    const now = Date.now()
    const patched = COUNTDOWN.patchList(list, this.data.serverOffset, now)
    this.setData({ orderList: patched.list })
    if (!patched.hasActive) {
      this.stopCountdown()
      return
    }
    if (!patched.hasExpired) {
      // 一切正常：没有任何订单到点，重置重拉计数
      this._expireReloads = 0
      return
    }
    // 到点了：服务端在 orderList 里已有读取兜底（会把超时订单置为已取消），
    // 这里重新拉一次列表，让卡片立刻变成「已取消」/移出「待付款」。
    // 加 3 秒节流，避免服务端响应慢时反复请求；
    // 再加 5 次上限：真出现「服务端时间与本机时间长期对不上」这种异常时，
    // 宁可停掉倒计时，也不要一直打扰服务端。
    if (this._expireReloads >= 5) {
      this.stopCountdown()
      return
    }
    if (!this._lastExpireReloadAt || now - this._lastExpireReloadAt > 3000) {
      this._lastExpireReloadAt = now
      this._expireReloads = (this._expireReloads || 0) + 1
      this.orderList()
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
  // ===== 店主专用：完成订单（2026-10-10 取代原扫码核销）=====
  // 顾客取餐 / 外送送达后，店主点这里把订单从「制作中」推进到「交易成功」。
  // 前端按钮显不显示由 isShopAdmin 决定；云函数会再用 ctx.openid 校验白名单，
  // 所以顾客就算把按钮点出来也完不成别人的订单。
  finishOrderTap: function(e) {
    const that = this
    const orderId = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认完成订单？',
      content: '确认顾客已取餐 / 已送达，订单将标记为「交易成功」',
      confirmText: '确认完成',
      success: function(res) {
        if (!res.confirm) return
        API.orderFinish(wx.getStorageSync('token'), orderId).then(function(r) {
          if (r.code == 0) {
            wx.showToast({ title: '已完成', icon: 'success' })
            that.orderList()
          } else {
            wx.showModal({
              title: '无法完成该订单',
              content: r.msg || '操作失败',
              showCancel: false
            })
          }
        })
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
          LOG.error('[current-order] makePhoneCall 失败', err)
        }
      }
    })
  },
  toPayTap: function(e) {
    // 2026-10-17 顾客反馈：退出登录后点「再次支付」必须先重新登录（隐私勾选 + 微信登录）
    if (LOGIN_GATE.isLoggedOut()) {
      LOGIN_GATE.requireLogin(this, () => this.toPayTap(e))
      return
    }
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
    // 2026-10-12：待支付订单 15 分钟未支付会自动取消，确认支付时把剩余时间一并告知顾客
    const target = (this.data.orderList || []).find((o) => o.id === orderId)
    const cd = target ? COUNTDOWN.countdownOf(target, this.data.serverOffset, Date.now()) : null
    const content = (cd && cd.active)
      ? '订单金额: ' + money + ' 元\n剩余 ' + cd.remainText + ' 自动取消'
      : '订单金额: ' + money + ' 元'
    // 2026-09-26 阶段二：已删除会员积分/余额逻辑。
    // 删除内容：API.userAmount 查询余额、"积分不足"校验、"可用余额/扣除积分"提示、
    //           money = money - balance 的抵扣计算、余额足够时走 orderPayV2 的分支。
    // 原因：会员卡 / 积分 / 余额体系整体删除（orderPayV2 与云函数 orderPay action 已移除）。
    // 现行为：仍保留"请确认支付"确认弹窗（交互不变），确认后统一走微信支付。
    wx.showModal({
      title: '请确认支付',
      content: content,
      confirmText: "确认支付",
      cancelText: "取消支付",
      success: function (res) {
        if (res.confirm) {
          that._toPayTap(orderId, money)
        } else {
          // 阶段 5.7：改为受 DS.debug 开关控制的调试日志（原来是无条件 console.log）
          LOG.debug('[current-order] 用户取消支付')
        }
      }
    });
  },
  /** 登录弹层登录成功：继续刚才被拦下的支付动作；没有待继续动作就刷新订单列表 */
  onLoginSuccess: function () {
    LOGIN_GATE.onLoginSuccess(this, () => this.orderList())
  },
  _toPayTap: function (orderId, money){
    // 2026-09-26 阶段二：已删除余额支付分支（money <= 0 时走 orderPayV2）。
    // 现统一走微信支付统一下单；云开发支付接入前会提示"云开发支付尚未接入"。
    wxpay.wxpay('order', money, orderId, "/pages/current-order/index");
  },
})
