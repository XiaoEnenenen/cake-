/**
 * 店主端 · 订单管理（阶段 10）
 * ---------------------------------------------------------------------------
 * 对应店主的两句原话：
 *   · R-04「我有时间就是自己配送，没有时间就是叫跑腿」→ 所以这一页必须把
 *     **收货人 / 电话 / 地址（含经纬度）/ 期望时间 / 备注** 一次给全，
 *     并提供「拨打电话」与「一键导航」两个动作；
 *   · R-08「有用户端跟商家端吧」→ 这就是商家端看订单的地方。
 *
 * 数据来源：云函数 `orderAdminList`（跨顾客查询 + 服务端 requireAdmin 鉴权）。
 *   · 缺省只返回**未完成**的订单（0 待支付 / 1 制作中）；看历史要显式传 statusBatch；
 *   · 服务端不返回顾客 _openid（店主不需要，少一份可泄露的标识）；
 *   · 店主打开列表时，服务端会顺带把**所有顾客**超时未支付的单自动取消
 *     （等同定时触发器，避免挂着"永远待支付"的单）。
 *
 * 「运费待确认」的订单：距离超过最后一档或地址没有经纬度时，下单的运费是 null，
 *   店主电话谈好后用本页的「确认运费」补录 —— 金额由服务端重算
 *   （amountReal = goodsAmount + packingFee + freight），前端只传一个运费数字。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const LOC = require('../../../utils/location')
const FMT = require('../../../utils/format')
const LOG = require('../../../utils/log')

// 状态分组与云函数 orderAdminList 的 statusBatch 一一对应
const TABS = [
  { key: 'pending', label: '待处理', batch: '0,1', count: 0 },
  { key: 'done', label: '已完成', batch: '3', count: 0 },
  { key: 'all', label: '全部', batch: '0,1,3', count: 0 }
]

Page({
  data: {
    isAdminUser: false,
    tabs: TABS,
    tabIndex: 0,
    orderList: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: true,
    loaded: false,
    loadError: false,
    loadingMore: false,
    // 正在"完成订单"的订单 id（防止连点两次）
    finishingId: '',
    // 运费补录弹层
    freightOrder: null,
    freightInput: '',
    freightSaving: false
  },

  async onLoad() {
    const allowed = await ADMIN.guardShopAdminPage()
    this.setData({ isAdminUser: allowed })
    if (!allowed) {
      this.setData({ loading: false, loaded: true })
      return
    }
    this.loadList(true)
  },

  onPullDownRefresh() {
    Promise.resolve(this.loadList(true)).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadList(false)
  },

  retryLoad() {
    this.loadList(true)
  },

  switchTab(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (index === this.data.tabIndex || isNaN(index)) return
    this.setData({ tabIndex: index, orderList: [] })
    this.loadList(true)
  },

  /**
   * 拉取订单。
   * ★ 竞态保护（_seq）：切筛选项后，慢的旧请求返回时不能覆盖新结果
   *   —— 与点单页购物车 `_cartSeq`、订单列表页同一套做法。
   */
  async loadList(reset) {
    if (reset) {
      this._seq = (this._seq || 0) + 1
    }
    const seq = this._seq || 0
    const tab = this.data.tabs[this.data.tabIndex] || TABS[0]
    const page = reset ? 1 : this.data.page + 1

    this.setData(reset ? { loading: true, loadError: false } : { loadingMore: true })

    const res = await API.adminOrderList({
      statusBatch: tab.batch,
      page,
      pageSize: this.data.pageSize
    })
    if (seq !== (this._seq || 0)) {
      // 已有更新的一次请求（例如刚切了筛选项）→ 丢弃这次结果；
      // 但必须把"加载更多"的标志复位，否则底部会永远停在"正在加载更多…"
      this.setData({ loadingMore: false })
      return
    }

    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-orders] 加载失败', res && res.msg)
      this.setData({
        loading: false,
        loadingMore: false,
        loadError: true,
        loaded: true,
        orderList: reset ? [] : this.data.orderList,
        hasMore: false
      })
      wx.showToast({ title: (res && res.msg) || '订单加载失败', icon: 'none' })
      return
    }

    const batch = Array.isArray(res.data.orderList) ? res.data.orderList : []
    const list = (reset ? [] : this.data.orderList).concat(batch.map(viewOf))
    const total = Number(res.data.total || 0)
    const counts = res.data.statusCounts || {}
    const n = (k) => Number(counts[String(k)] || 0)
    const tabs = this.data.tabs.map((t, i) => {
      let count = 0
      if (i === 0) count = n(0) + n(1)
      else if (i === 1) count = n(3)
      else count = Object.keys(counts).reduce((sum, k) => sum + Number(counts[k] || 0), 0)
      return Object.assign({}, t, { count })
    })

    this.setData({
      orderList: list,
      total,
      page,
      tabs,
      hasMore: list.length < total,
      loading: false,
      loadingMore: false,
      loadError: false,
      loaded: true
    })
  },

  // ===== 接单动作 =====

  /** 拨打电话：优先收货电话；自提单回退联络电话 */
  callCustomer(e) {
    const index = Number(e.currentTarget.dataset.index)
    const o = this.data.orderList[index]
    const phone = (o && o.contactPhone) || ''
    if (!phone) {
      wx.showToast({ title: '这一单没有留电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({
      phoneNumber: String(phone),
      fail: (err) => {
        // 用户主动取消不提示
        if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
          LOG.error('[admin-orders] makePhoneCall 失败', err)
        }
      }
    })
  },

  /** 一键导航到收货地址（复用 utils/location.openNavigation，与门店导航同一套） */
  navToCustomer(e) {
    const index = Number(e.currentTarget.dataset.index)
    const o = this.data.orderList[index]
    const addr = (o && o.address) || null
    const lat = addr && Number(addr.latitude)
    const lng = addr && Number(addr.longitude)
    if (!addr || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
      wx.showToast({ title: '这一单没有定位坐标，可复制地址手动导航', icon: 'none' })
      return
    }
    LOC.openNavigation({
      name: (o.contactName || '收货地址') + ' ' + (o.contactPhone || ''),
      address: o.addressText || '',
      latitude: lat,
      longitude: lng
    }).catch(() => {
      wx.showToast({ title: '无法唤起地图，请复制地址手动导航', icon: 'none' })
    })
  },

  /** 复制收货地址（没有经纬度时的兜底：店主可以直接粘到高德/微信里搜） */
  copyAddress(e) {
    const index = Number(e.currentTarget.dataset.index)
    const o = this.data.orderList[index]
    const text = ((o && o.contactName) || '') + ' ' + ((o && o.contactPhone) || '') +
      '\n' + ((o && o.addressText) || '')
    if (!text.trim()) {
      wx.showToast({ title: '没有可复制的地址', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text.trim(),
      success: () => wx.showToast({ title: '已复制，可粘到地图里搜', icon: 'none' })
    })
  },

  /** 完成订单（服务端只允许 制作中(1) → 已完成(3)，这里先二次确认） */
  finishOrder(e) {
    const index = Number(e.currentTarget.dataset.index)
    const o = this.data.orderList[index]
    if (!o || this.data.finishingId) return
    wx.showModal({
      title: '完成订单',
      content: '确认这一单（取餐码 ' + (o.pickupCode || '—') + '）已交付？完成后顾客端会显示「交易成功」。',
      confirmText: '确认完成',
      cancelText: '再等等',
      success: (r) => {
        if (r.confirm) this.doFinish(o)
      }
    })
  },

  async doFinish(o) {
    this.setData({ finishingId: o.id })
    try {
      const res = await API.orderFinish(null, o.id)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '完成失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已完成', icon: 'success' })
      await this.loadList(true)
    } finally {
      this.setData({ finishingId: '' })
    }
  },

  // ===== 运费补录（「运费待确认」的订单）=====

  openFreight(e) {
    const index = Number(e.currentTarget.dataset.index)
    const o = this.data.orderList[index]
    if (!o) return
    this.setData({
      freightOrder: o,
      freightInput: o.freight > 0 ? String(o.freight) : ''
    })
  },

  closeFreight() {
    this.setData({ freightOrder: null, freightInput: '', freightSaving: false })
  },

  // 弹层本体的点击不该关掉弹层（只有点遮罩才关）：wxml 用 catchtap 绑到这里
  noop() {},

  onFreightInput(e) {
    this.setData({ freightInput: String((e.detail && e.detail.value) || '') })
  },

  async confirmFreight() {
    const o = this.data.freightOrder
    if (!o || this.data.freightSaving) return
    const raw = String(this.data.freightInput || '').trim()
    const fee = Number(raw)
    if (raw === '' || !isFinite(fee) || fee < 0) {
      wx.showToast({ title: '请填写不小于 0 的配送费', icon: 'none' })
      return
    }
    if (fee > 999) {
      wx.showToast({ title: '配送费最大 999 元', icon: 'none' })
      return
    }
    // ★ 已经确认过的单再改一次（例如电话里谈崩了要改金额）→ 必须让店主看清"从多少改到多少"，
    //   否则一次误触就把顾客的实付金额改了（服务端只放行一次一个数字，前端这道确认是唯一提示）。
    const wasConfirmed = !!(o.deliveryQuote && o.deliveryQuote.freightConfirmed)
    if (wasConfirmed) {
      const okToChange = await new Promise((resolve) => {
        wx.showModal({
          title: '修改已确认的配送费',
          content: '这一单的配送费已经确认过：¥' + (Number(o.freight) || 0) +
            '（实付 ' + o.amountText + '）→ 现在改成 ¥' + fee +
            '（实付 ¥' + (Number(o.amountReal || 0) - Number(o.freight || 0) + fee) + '）。确认修改？',
          confirmText: '确认修改',
          cancelText: '取消',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        })
      })
      if (!okToChange) return
    }
    this.setData({ freightSaving: true })
    try {
      const res = await API.adminOrderFreightConfirm(o.id, fee)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '实付已更新为 ¥' + res.data.amountReal, icon: 'none' })
      this.setData({ freightOrder: null, freightInput: '' })
      await this.loadList(true)
    } finally {
      this.setData({ freightSaving: false })
    }
  }
})

/**
 * 列表展示用的视图（全部在 JS 里算好，wxml 不拼字符串）
 * @param {object} o 云函数 orderAdminView 的返回
 */
function viewOf(o) {
  const quote = o.deliveryQuote || null
  const isDelivery = o.deliveryMode === 'delivery'
  // 「运费待确认」：下单时运费是 null（超最后一档 / 地址没有经纬度）且还没补录
  const needFreight = !!(
    isDelivery &&
    !(quote && quote.freightConfirmed) &&
    quote &&
    (quote.reason === 'beyond' || quote.reason === 'unknown_distance')
  )
  return Object.assign({}, o, {
    isDelivery: isDelivery,
    dateText: FMT.formatDateTime(o.dateAdd, { placeholder: '' }),
    amountText: '¥' + (Number(o.amountReal) || 0),
    goodsAmountText: '¥' + (Number(o.goodsAmount) || 0),
    packingFeeText: '¥' + (Number(o.packingFee) || 0),
    freightText: o.freight > 0 ? '¥' + o.freight : ((quote && quote.freightText) || '免配送费'),
    needFreight: needFreight,
    canFinish: Number(o.status) === 1,
    // 取餐码：自提单最显眼（叫号用）；外送单显示"外送"
    badgeText: isDelivery ? '外送' : '自提 ' + (o.pickupCode || ''),
    hasAddress: !!(o.address && isFinite(Number(o.address.latitude)) && isFinite(Number(o.address.longitude))),
    // 状态说明（**必须让店主看懂"为什么这一单完不成"**）：
    //   支付还没接入（阶段 7），所以订单只会停在「待支付」并在 15 分钟后自动取消 ——
    //   不写这句，店主会以为是 App 坏了（"完成订单"按钮永远不出现）。
    statusHint: Number(o.status) === 0
      ? '顾客还没付款（支付未接入：15 分钟未付会自动取消；可先电话沟通并补录运费）'
      : ''
  })
}
