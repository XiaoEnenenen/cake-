/**
 * 店主中心（阶段 10 入口页）
 * ---------------------------------------------------------------------------
 * 这是什么：店主（张明静）自己的"商家端"入口 —— 她自己手机上改商品、看订单、
 *          调配送费，不用每次找开发者（R-07 / R-08）。
 *
 * 三条设计原则：
 *   1) **不进 tabBar**：普通顾客看不到入口，顾客端保持干净；
 *      入口在「我的」页，只有 utils/admin.js 的 isShopAdmin() 为真时才渲染。
 *   2) **前端只决定显不显示**：真正的鉴权在每个云函数 action 的 requireAdmin(ctx)
 *      （服务端用 ctx.openid 比对白名单）—— 改前端把入口点出来也调不通接口。
 *   3) 非店主即使直接跳转本页，onLoad 的闸门也会提示并返回（guardShopAdminPage）。
 *
 * 今日概况只调两个接口：
 *   · adminOrderList（pageSize=1）→ 拿各状态数量（statusCounts），不下载订单体；
 *   · adminGoodsList           → 在售 / 已下架数量。
 * ---------------------------------------------------------------------------
 */
const API = require('../../utils/api-map')
const ADMIN = require('../../utils/admin')
const LOC = require('../../utils/location')
const LOG = require('../../utils/log')

Page({
  data: {
    // 是否为店主（守卫结果；false 时页面只显示"无权限"分支）
    isAdminUser: false,
    loading: true,
    loadError: false,
    // 今日概况
    pendingCount: 0, // 待支付 + 制作中（要店主处理的）
    doingCount: 0, // 制作中（已付款待完成）
    doneCount: 0, // 已完成
    onSaleCount: 0, // 在售商品
    offSaleCount: 0, // 已下架商品
    // 仅开发版 / 体验版显示：把原始 openid 复制出来填白名单（正式版不显示）
    myOpenid: '',
    isDevEnv: false
  },

  async onLoad() {
    this.setData({ isDevEnv: LOC.isDevOrTrialEnv() })
    const allowed = await ADMIN.guardShopAdminPage()
    this.setData({ isAdminUser: allowed, loading: allowed })
    if (!allowed) return
    if (this.data.isDevEnv) {
      const openid = await ADMIN.getMyOpenid()
      this.setData({ myOpenid: openid })
    }
    // ★ 首屏必须自己拉一次：onLoad 在 await 闸门处让出事件循环，
    //   而 onShow 紧随 onLoad **同步**执行 —— 那时 isAdminUser 还是初始的 false，
    //   所以 onShow 里的 loadOverview() 在首次进入时根本不会跑（页面会永远停在"正在读取…"）。
    //   onShow 保留用于"从子页面返回后刷新"。
    this._loadedOnce = true
    this.loadOverview()
  },

  onShow() {
    // 首次进入由 onLoad 负责（见上），这里只处理"从子页面返回"的刷新
    if (this.data.isAdminUser && this._loadedOnce) this.loadOverview()
  },

  retryLoad() {
    this.setData({ loading: true })
    this.loadOverview()
  },

  /**
   * 今日概况。
   * ⚠️ 两个请求**都成功**才更新数字：任一个失败就整体落到错误态，
   *    避免出现"订单数是对的、商品数是 0"这种半截数据（店主会以为商品全下架了）。
   */
  async loadOverview() {
    const [orderRes, goodsRes] = await Promise.all([
      API.adminOrderList({ statusBatch: '0,1,3', page: 1, pageSize: 1 }),
      API.adminGoodsList({})
    ])
    const orderOk = orderRes && orderRes.code == 0 && orderRes.data
    const goodsOk = goodsRes && goodsRes.code == 0 && goodsRes.data
    if (!orderOk || !goodsOk) {
      LOG.error('[admin] 概况加载失败', (orderRes && orderRes.msg) || '', (goodsRes && goodsRes.msg) || '')
      this.setData({ loading: false, loadError: true })
      return
    }
    const counts = orderRes.data.statusCounts || {}
    const n = (k) => Number(counts[String(k)] || 0)
    this.setData({
      loading: false,
      loadError: false,
      pendingCount: n(0) + n(1),
      doingCount: n(1),
      doneCount: n(3),
      onSaleCount: Number(goodsRes.data.onSale || 0),
      offSaleCount: Number(goodsRes.data.offSale || 0)
    })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/admin/orders/index' })
  },

  goGoods() {
    wx.navigateTo({ url: '/pages/admin/goods/index' })
  },

  goDelivery() {
    wx.navigateTo({ url: '/pages/admin/delivery/index' })
  },

  goCoupons() {
    // 阶段 11：优惠券已上线，直接进券管理（列表 + 新建/编辑/停用）
    wx.navigateTo({ url: '/pages/admin/coupons/index' })
  },

  /** 复制原始 openid（仅开发版 / 体验版可见；填进 shop-config.js 的 adminOpenids） */
  copyMyOpenid() {
    if (!this.data.myOpenid) {
      wx.showToast({ title: '还没读到 openid，请稍后重试', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.myOpenid,
      success: () => wx.showToast({ title: '已复制，发给开发者即可', icon: 'none' })
    })
  }
})
