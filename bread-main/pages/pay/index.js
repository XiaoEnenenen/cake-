/**
 * 订单结算页
 * ---------------------------------------------------------------------------
 * 2026-10-09 改版（按店主提供的参考图重做布局与视觉）：
 *   1. 配送方式改为分段控件；新增门店卡片（地址 + 地图缩略图 + 距离 + 导航）。
 *   2. 联络电话由「自动填写（getPhoneNumber）」改为**顾客手填**：
 *      当前主体未开通「手机号快速验证」，原路径只会弹
 *      getPhoneNumber:fail no permission，顾客无法填写电话。
 *      现为输入框 + 11 位校验，成功后存 storage（contactPhone）供下次带出，
 *      下单时统一写入订单扩展字段「联络电话」。
 *   3. 门店地图的距离气泡（2026-10-10 修正）：
 *      - 外送：显示「配送距离 X」= **收货地址 → 门店**，与运费同源（同一个 calcQuote），
 *        由本页算好通过 distance-text 传给 shop-map 组件；
 *      - 自提：留空 → 组件自己定位后显示「距离您 X」（去店里取才有意义）。
 *      本页不再直接调用定位接口；定位授权与降级提示都在组件内部处理。
 *   4. 商品、费用与底部「合计 + 去支付」栏按参考图重排。
 *   参考图中的「会员卡 / 优惠券 / 余额支付 / 储值卡」未实现：会员、积分、余额体系
 *   在阶段二已整体删除，不做假数据。
 * ---------------------------------------------------------------------------
 */
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const wxpay = require('../../utils/pay.js')
const SHOP_CONFIG = require('../../shop-config')
const DELIVERY = require('../../utils/delivery')
const ADDR = require('../../utils/address')
const DR = require('../../utils/delivery-range')
// 区域外等提示文案统一从配置取，页面里不留旧文案
const DCFG = require('../../config/delivery')
const LOC = require('../../utils/location')

// 联络电话在本地持久化的键名（顾客手填后下次自动带出）
const CONTACT_PHONE_KEY = 'contactPhone'

// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩与随之无用的 getApp()。
Page({
  data: {
    purchaseNotes: undefined,
    // 门店信息（onLoad 里由 shop-config.js + storage 合并后写入）。
    // 必须声明在 data 中：WXML 直接读取 shopInfo.*，未声明时首次渲染读不到。
    // 2026-10-12 复核整改：原来这里和下面「门店卡片」处各写了一次 shopInfo（重复键），
    // 只保留这一处声明。
    shopInfo: {},
    // ===== 2026-10-09 改版：联络电话改为顾客手填 =====
    // 原实现为「自动填写」按钮 → 弹 bind-mobile 组件 → open-type="getPhoneNumber"。
    // 当前主体未开通「手机号快速验证」，点开会直接弹 getPhoneNumber:fail no permission，
    // 顾客根本填不进电话。现改为输入框手填，并做 11 位校验。
    mobile: '',
    mobileError: '',
    fetchTime: '请选择',
    remark: '未填写',
    // 购物车是否为空（由 shippingCarInfo 写入，避免在 WXML 里做 .length 判断）
    cartEmpty: false,
    // 购物车原始返回（wxml 的件数/金额都读它）。
    // 2026-10-12 复核整改：按本项目约定显式声明 —— 未声明时首帧 `{{shippingCarInfo.price}}`
    // 会渲染成空的「¥」，配合 cartLoaded 一起避免"看起来像 ¥0"的错觉。
    shippingCarInfo: null,
    // ===== 阶段 5.6 复核整改：购物车的加载状态 =====
    // 原来只有「空 / 非空」两种，接口失败时页面永远停在「购物车加载中…」。
    cartLoaded: false,     // 是否已经拿到过结果（区分"还没加载"与"确实为空"）
    cartLoadError: false,  // 接口失败 / 返回体不完整
    // 配送方式
    isDelivery: false,
    deliveryEnabled: false,
    deliveryReminder: '',
    // ===== 改造：收货地址与运费 =====
    // 选中的收货地址（外送用）；来自地址簿，通过 pages/address/index?select=1 选择
    selectedAddress: null,
    addressText: '',
    // 运费报价结果（含是否可配送、距离、运费文案、原因）
    quote: null,
    // 商品金额（不含运费）
    goodsAmount: 0,
    // 应付总价（商品 + 运费）；运费待确认时等于商品金额
    payableAmount: 0,
    // 运费展示文案
    freightText: '免配送费',
    // 运费金额（null 表示待确认）
    freight: 0,
    // 阶段 5.1：是否有商品详情没拉到（无法判断蛋糕免运费规则）→ 运费按"待确认"处理而不猜
    quoteIncomplete: false,
    // 配送提示（如距离、超出范围原因）
    deliveryTip: '',
    // 门店地图气泡的距离文案（2026-10-10）：
    //   外送 = '配送距离 X'（收货地址 → 门店，与运费同源）
    //   自提 = ''（由 shop-map 组件显示「距离您 X」，去店里取才有意义）
    // 必须声明在 data 中，WXML 直接读取
    mapDistanceText: '',
    // 购物车商品的规格快照，供蛋糕规则（6寸免配送费）判断
    // 必须声明在 data 中，否则 this.data 读取行为不可靠
    cartItemsForQuote: [],
    // ===== 阶段 5.1：商品价格变动提示（缺陷 D-01）=====
    // 购物车展示与下单金额现在都以**商品现价**为准（云函数 cartSummary 重算），
    // 商家在顾客加购后改过价时，这里给出一句明确提示，
    // 避免顾客以为"看到的 108 元"就是实付金额。
    priceChangedTip: '',
    // ===== 阶段 5.1 复核整改：有商品无法下单（已下架 / 规格被改动）=====
    // 购物车会显示一个正常金额，但下单必被拒（且结算页没有改规格入口）。
    // 这里提前说清原因并禁止提交，避免顾客填完地址电话才被拒。
    cartUnavailableTip: '',
    // 阶段 5.6（缺陷 P-10）：是否正在提交订单（防抖 + 按钮文案）
    submitting: false
  },
  onLoad: function (options) {
    AUTH.login() // 这句不能省略
    // 改造：改用固定门店配置兜底，避免未经过首页时 shopInfo 为空导致
    //      this.data.shopInfo.name（下单处）报错。
    // ===== 2026-10-09 改版：门店卡片 =====
    // 合并 shop-config.js 与 storage 里的门店信息（storage 里可能是旧版本写入的、缺坐标）
    const shopInfo = Object.assign({}, SHOP_CONFIG.shop, wx.getStorageSync('shopInfo') || {})
    shopInfo.openHoursText = shopInfo.openingHours || '09:00-22:00'
    shopInfo.latitude = Number(shopInfo.latitude) || Number(SHOP_CONFIG.shop.latitude) || 0
    shopInfo.longitude = Number(shopInfo.longitude) || Number(SHOP_CONFIG.shop.longitude) || 0
    this.setData({ shopInfo })
    // 联络电话：先用本地保存的（顾客上次填过的）
    const savedPhone = wx.getStorageSync(CONTACT_PHONE_KEY)
    if (savedPhone) {
      this.setData({ mobile: savedPhone })
    }
    this.syncDeliveryMode()
    this.shippingCarInfo()
  },
  onShow: function () {
    this.syncDeliveryMode()
    AUTH.wxaCode().then(code => {
      this.data.code = code
    })
    this.userDetail()
    const fetchTime = wx.getStorageSync('fetchTime')
    if (fetchTime) {
      this.setData({
        fetchTime
      })
    }
    const remark = wx.getStorageSync('remark')
    if (remark) {
      this.setData({
        remark
      })
    }
    // ===== 改造：从地址选择页返回时，selectedAddress 已由该页 setData 注入 =====
    // 阶段 5.3（缺陷 P-02）修复：
    //   原实现只在「还没有选中地址」时才 applyAddress()；地址选择页又只注入
    //   selectedAddress、不注入 addressText（wxml 渲染的正是 addressText）→
    //   顾客选完地址回到结算页，**屏幕上那一行还是上一个地址**（订单快照是对的，
    //   但顾客核对的那一行是错的，最容易造成"送到错地址"）。
    //   现在每次 onShow 都以 selectedAddress 为准重新生成展示文案，两处数据不再可能脱节。
    const selected = this.data.selectedAddress
    if (selected) {
      this.applyAddress(selected)
    } else {
      const def = ADDR.getDefault()
      if (def) {
        this.applyAddress(def)
      }
    }
    this.recalcQuote()
  },

  // ===== 改造：应用收货地址 =====
  applyAddress(addr) {
    this.setData({
      selectedAddress: addr,
      addressText: ADDR.formatFull(addr) || (addr.detail || '')
    })
  },

  // ===== 改造：跳转地址选择页 =====
  goSelectAddress() {
    wx.navigateTo({
      url: '/pages/address/index?select=1'
    })
  },

  // ===== 改造：重新计算运费报价 =====
  // 规则全部来自 utils/delivery-range（与云函数服务端同一套）
  recalcQuote() {
    const goodsAmount = Number(this.data.goodsAmount) || 0

    // 自提：无运费。距离气泡留空 → 由 shop-map 显示「距离您 X」（去店里取，这个距离才有意义）
    if (!this.data.isDelivery) {
      this.setData({
        quote: null,
        freight: 0,
        freightText: '自提免运费',
        payableAmount: goodsAmount,
        deliveryTip: '',
        mapDistanceText: ''
      })
      return
    }

    const address = this.data.selectedAddress
    if (!address) {
      this.setData({
        quote: null,
        freight: null,
        freightText: '请先选择收货地址',
        payableAmount: goodsAmount,
        deliveryTip: '',
        // 外送但还没选地址：明确提示，避免又退回显示"当前位置到门店"的误导距离
        mapDistanceText: '待选择收货地址'
      })
      return
    }

    // ===== 阶段 5.1 复核整改：商品快照不全时不猜运费 =====
    // 蛋糕「免配送费」规则依赖每个商品的 isCake 快照；只要有一条商品详情没拉到，
    // 前端算出的运费就可能与服务端重算结果不同（实测：前端 5 元 / 服务端 0 元 →
    // 屏显 25 元、实付 20 元）。此时按既有的"运费待确认"语义处理：
    // 应付先按商品金额计，最终以服务端返回为准，并在下单时做金额二次确认。
    if (this.data.quoteIncomplete) {
      this.setData({
        quote: null,
        freight: null,
        freightText: '运费待确认',
        payableAmount: goodsAmount,
        deliveryTip: '',
        mapDistanceText: '待确认'
      })
      return
    }

    // 组装商品信息用于蛋糕规则判断（购物车项需带商品快照）
    const items = (this.data.cartItemsForQuote || [])
    const quote = DR.calcQuote({ address, goodsAmount, items })

    // 应付金额：运费待确认(null)时先按商品金额计，最终以服务端返回为准
    const freightValue = quote.freight === null ? 0 : quote.freight
    const payableAmount = Math.round((goodsAmount + freightValue) * 100) / 100

    // 2026-10-10：外送场景的气泡显示「收货地址 → 门店」的距离，
    // 不再显示"用户当前位置到门店"（人在外面下单时那个数字与配送距离无关）。
    // 该距离与运费同源（同一个 calcQuote），订单详情页的「配送距离」快照也用它。
    const km = quote.distanceKm
    const mapDistanceText = (km === null || km === undefined)
      ? '待选择收货地址'
      : '配送距离 ' + LOC.formatDistance(km)

    this.setData({
      quote,
      freight: quote.freight,
      freightText: quote.freightText,
      payableAmount,
      deliveryTip: quote.deliverable ? (quote.tip || '') : '',
      mapDistanceText
    })
  },
  // 改造：同步配送方式到页面（与点单页共用 storage.deliveryMode）
  syncDeliveryMode() {
    const cfg = SHOP_CONFIG.delivery || {}
    const isDelivery = DELIVERY.isDelivery()
    this.setData({
      isDelivery,
      deliveryEnabled: DELIVERY.isDeliveryEnabled(),
      deliveryReminder: cfg.reminder || '',
      // 首次渲染前就把气泡文案定下来：外送给占位文案（稍后 recalcQuote 换成真实距离），
      // 这样 shop-map 组件一挂载就知道"不需要定位"，不会平白弹一次定位授权。
      mapDistanceText: isDelivery ? '待选择收货地址' : ''
    })
  },
  // 改造：切换自提 / 外送
  onModeChange(e) {
    const mode = e.currentTarget.dataset.mode
    DELIVERY.setMode(mode)
    this.syncDeliveryMode()
    // 切换配送方式会改变运费，需要重算
    this.recalcQuote()
  },
  async shippingCarInfo(){
    const token = wx.getStorageSync('token')
    // 改造（2026-02-14）：兼容云开发模式。
    // 云开发身份由 OPENID 决定，storage 里从来没有 token
    // （证据：utils/auth.js 的 login()/authorize() 只写 uid，从不写 token）。原实现无 token 即 navigateBack，
    // 会导致云模式下点「去结算」被立刻弹回点单页，结算流程完全不可用。
    // 单一数据源（阶段三）：__isCloudMode() 恒为 true，这里不需要 token。
    // 该判断保留为兜底：万一 useCloud 被误设为 false，结算页也不会静默空转。
    if (!API.__isCloudMode() && !token) {
      wx.navigateBack()
      return
    }
    // https://www.yuque.com/apifm/nu0f75/awql14
    const res = await API.shippingCarInfo(token)
    // ===== 阶段 5.6 复核整改：接口失败 / 返回体不完整也要有明确状态 =====
    // 原来只有 code == 0 分支：失败时什么都不做，页面永远停在「购物车加载中…」，
    // 既没有提示也没有重试；而且 code == 0 但缺 data.items 时下面会直接抛 TypeError。
    if (res.code != 0 || !res.data || !Array.isArray(res.data.items)) {
      this.setData({
        shippingCarInfo: null,
        cartItemsForQuote: [],
        cartCount: 0,
        cartPrice: 0,
        cartEmpty: false,
        cartLoadError: true,
        cartLoaded: true,
        priceChangedTip: '',
        cartUnavailableTip: ''
      })
      this.recalcQuote()
      return
    }
    {
      let purchaseNotes = ''
      // ===== 改造：顺便收集商品快照，供配送规则（蛋糕识别、尺寸解析）使用 =====
      const cartItemsForQuote = []
      // 阶段 5.1：有任何一项商品详情没拉到 → 无法判断"是否含蛋糕"（免运费规则），
      // 此时**不猜运费**（见 recalcQuote 的 quoteIncomplete 分支），
      // 避免出现屏幕显示 25 元、服务端重算 20 元的"屏显≠实付"。
      let quoteIncomplete = false
      for (let index = 0; index < res.data.items.length; index++) {
        const element = res.data.items[index];
        const goodsId = element.goodsId
        // https://www.yuque.com/apifm/nu0f75/vuml8a
        const resGoods = await API.goodsDetailV2({
          id: goodsId,
          token: wx.getStorageSync('token')
        })
        if (resGoods.code == 0 && resGoods.data && resGoods.data.basicInfo) {
          if (resGoods.data.basicInfo.purchaseNotes) {
            purchaseNotes += resGoods.data.basicInfo.purchaseNotes
          }
          cartItemsForQuote.push({
            goods: {
              isCake: resGoods.data.basicInfo.isCake,
              properties: resGoods.data.properties || []
            },
            sku: element.sku || []
          })
        } else {
          quoteIncomplete = true
        }
      }
      const goodsAmount = Number(res.data.price) || 0
      // ===== 阶段 5.1：价格变动提示 =====
      // res.data.price 已是**现价**合计（与下单实付同源）；priceChanged 为 true 时
      // 说明商家的价格在加购之后被改过，明确告诉顾客"现在看到的就是最新价格"。
      const names = res.data.priceChangedNames || []
      const priceChangedTip = res.data.priceChanged
        ? '以下为最新价格（' + (names.length ? names.join('、') : '部分商品') + ' 的价格已更新）'
        : ''
      // ===== 阶段 5.1：购物车里有"不可能下单成功"的项 =====
      // 复核发现：商品下架 / 规格被商家改动时，购物车会显示一个正常金额，
      // 顾客填完地址电话点「去支付」才被拒（且结算页没有改规格入口 = 死路）。
      // 这里提前、明确地告诉顾客原因，并禁止提交。
      const unNames = res.data.unavailableNames || []
      const cartUnavailableTip = res.data.unavailable
        ? '以下商品暂时无法下单，请到点单页重新选择：' + (unNames.length ? unNames.join('、') : '部分商品')
        : ''
      // ===== 改造：把商品快照写入 storage，供 select-time 判断是否含蛋糕 =====
      // 原因：select-time 是独立页面，需要知道购物车里有没有蛋糕，
      //      才能决定是否强制「提前3小时」。这里写入，形成明确的数据约定。
      wx.setStorageSync('checkoutItems', cartItemsForQuote)
      this.setData({
        purchaseNotes,
        shippingCarInfo: res.data,
        cartEmpty: !(res.data.items && res.data.items.length),
        goodsAmount,
        cartItemsForQuote,
        priceChangedTip,
        cartUnavailableTip,
        quoteIncomplete,
        cartLoadError: false,
        cartLoaded: true
      })
      // 商品金额变化会影响运费（是否满 35 元），需要重算
      this.recalcQuote()
    }
  },

  // 阶段 5.6 复核整改：购物车加载失败的重试入口（wxml 里的「点击重试」）
  retryCart() {
    this.setData({ cartLoadError: false, cartLoaded: false })
    this.shippingCarInfo()
  },

  /**
   * 阶段 5.1：页面上展示给顾客的合计金额。
   * 下单成功后会拿它与服务端返回的 amountReal 比对 —— 不一致说明下单那一刻
   * 商家改过价或运费被服务端重算过，必须先告知顾客再发起支付（见 _createOrder）。
   * 自提 = 商品金额；外送 = 商品金额 + 运费（与 wxml 的展示口径一致）。
   */
  shownAmount() {
    if (this.data.isDelivery) return Number(this.data.payableAmount) || 0
    const info = this.data.shippingCarInfo
    return Number(info && info.price) || 0
  },
  async userDetail() {
    // https://www.yuque.com/apifm/nu0f75/zgf8pu
    const res = await API.userDetail(wx.getStorageSync('token'))
    const remote = res && res.code == 0 && res.data && res.data.base
      ? (res.data.base.mobile || '')
      : ''
    // 仅在顾客尚未填写（也没有本地保存值）时带出档案里的手机号，
    // 否则 onShow 返回页面时会把顾客刚输入的内容覆盖掉。
    if (remote && !this.data.mobile) {
      this.setData({ mobile: remote })
      wx.setStorageSync(CONTACT_PHONE_KEY, remote)
    }
  },

  // ===== 2026-10-09 改版：联络电话改为手填 =====
  // 输入时只保留数字并限制 11 位（type="number" 仍可能带出非数字字符）
  onMobileInput(e) {
    const value = String((e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 11)
    this.setData({ mobile: value, mobileError: '' })
    return value
  },
  // 失焦时校验并落地到 storage，便于下次自动带出
  onMobileBlur() {
    const value = String(this.data.mobile || '').trim()
    if (!value) {
      this.setData({ mobileError: '' })
      wx.removeStorageSync(CONTACT_PHONE_KEY)
      return
    }
    if (!ADDR.isValidPhone(value)) {
      this.setData({ mobileError: '手机号格式不正确，请检查后重填' })
      return
    }
    this.setData({ mobileError: '' })
    wx.setStorageSync(CONTACT_PHONE_KEY, value)
  },

  // ===== 2026-10-09 改版：门店地图与距离 =====
  // 地图 / 门店标记 / 用户定位 / 距离 / 圆形导航按钮都由 components/shop-map 负责，
  // 这里只保留「点整张门店卡片 = 一键导航到店」这一条入口。
  async openShopLocation() {
    await LOC.openNavigation(this.data.shopInfo)
  },
  // ===== 阶段 5.6（缺陷 P-10）：结算按钮防抖 =====
  // 原来没有防抖：连点「去支付」会重复调用 orderCreate，生成多张订单。
  // 现在有三重保护：
  //   ① 提交中（_submitting）：连点只会得到一句提示，不再发请求；
  //   ② 已成功下单（_ordered）：订单已生成且服务端已清空购物车，本页实例**永不再下单**
  //      （否则支付弹窗还没走完时再点一次，就是第二张重复订单）；
  //   ③ 按钮提交态（data.submitting）：wxml 据此置灰并换文案。
  // （订单列表页的「再次支付」本来就有 3 秒防抖，这里补齐。）
  async createorder() {
    if (this._submitting) {
      wx.showToast({ title: '正在提交，请稍候', icon: 'none' })
      return
    }
    if (this._ordered) {
      wx.showToast({ title: '订单已提交，请勿重复下单', icon: 'none' })
      return
    }
    this._submitting = true
    this.setData({ submitting: true })
    try {
      await this._createOrder()
    } finally {
      this._submitting = false
      this.setData({ submitting: false })
    }
  },

  async _createOrder() {
    const token = wx.getStorageSync('token')

    // 商品未加载成功时按钮会抛 TypeError（弱网下点「结算」直接报错），先拦住。
    if (!this.data.shippingCarInfo || !this.data.shippingCarInfo.items) {
      // 阶段 5.6 复核整改：区分"还在加载"与"加载失败"，后者要引导顾客重试
      if (this.data.cartLoadError) {
        wx.showModal({
          title: '购物车加载失败',
          content: '请检查网络后重试；若一直失败，可返回点单页重进结算页。',
          confirmText: '重试',
          success: (r) => {
            if (r.confirm) this.retryCart()
          }
        })
        return
      }
      wx.showToast({ title: '商品信息还没加载好，请稍候', icon: 'none' })
      return
    }

    // 阶段 5.1 复核整改：购物车里有"不可能下单成功"的项时，不要等顾客填完再拒
    if (this.data.cartUnavailableTip) {
      wx.showModal({
        title: '无法下单',
        content: this.data.cartUnavailableTip,
        showCancel: false
      })
      return
    }

    // ===== 2026-10-09 改版：联络电话改为手填，下单前统一校验 =====
    // 外送要靠它确认地址，自提要靠它联系顾客，故两种方式都必填。
    const contactPhone = String(this.data.mobile || '').trim()
    if (!ADDR.isValidPhone(contactPhone)) {
      this.setData({ mobileError: '请填写正确的手机号' })
      wx.showToast({ title: '请填写正确的联络电话', icon: 'none' })
      return
    }
    wx.setStorageSync(CONTACT_PHONE_KEY, contactPhone)

    // ===== 改造：外送下单前的校验 =====
    if (this.data.isDelivery) {
      if (!this.data.selectedAddress) {
        wx.showToast({ title: '请先选择收货地址', icon: 'none' })
        return
      }
      if (!this.data.fetchTime || this.data.fetchTime === '请选择') {
        wx.showToast({ title: '请选择期望送达时间', icon: 'none' })
        return
      }
      // 配送范围校验：不允许下单到区域外
      if (this.data.quote && this.data.quote.deliverable === false) {
        wx.showModal({
          title: '无法配送',
          content: this.data.quote.freightText || DCFG.area.outOfAreaTip,
          showCancel: false
        })
        return
      }
    } else {
      // ===== 阶段 4.7：自提（默认场景）同样要求先选时间 =====
      if (!this.data.fetchTime || this.data.fetchTime === '请选择') {
        wx.showToast({ title: '请选择自取时间', icon: 'none' })
        return
      }
    }

    // ===== 阶段 4.7：时间"提前量"二次校验，自提与外送都要走 =====
    // 规则在 utils/delivery-range.js 的 checkAdvanceTime（含蛋糕才要求提前 3 小时），
    // 这里只做"页面停留过久导致所选时间失效"的兜底。
    // 注意：用 storage 里的**绝对时间** expectTime（YYYY-MM-DD HH:mm），
    //      不能用 data.fetchTime（"今天 15:00"这种相对文案）。
    const expectTimeAbs = wx.getStorageSync('expectTime')
    if (expectTimeAbs) {
      const check = DR.checkAdvanceTime({
        expectTime: new Date(String(expectTimeAbs).replace(/-/g, '/')),
        items: this.data.cartItemsForQuote || [],
        now: new Date(),
        openingHours: (SHOP_CONFIG.shop && SHOP_CONFIG.shop.openingHours) || ''
      })
      if (!check.valid) {
        wx.showToast({ title: check.tip, icon: 'none' })
        return
      }
    }

    // 创建订单
    const goodsJson = []
    this.data.shippingCarInfo.items.forEach(ele => {
      const _ele = {
        goodsId: ele.goodsId,
        number: ele.number,
        propertyChildIds: '',
      }
      if (ele.sku) {
        // 改造：原实现只拼第一组规格（sku[0]），多规格会丢规格。
        //       现拼接全部规格，与 goods-details 的 buildSku 保持一致。
        _ele.propertyChildIds = ele.sku
          .map((s) => s.optionId + ':' + s.optionValueId)
          .join(',')
      }
      goodsJson.push(_ele)
    })
    // ===== 改造：订单扩展字段随配送方式变化 =====
    // 原为固定写入「自取门店 / 自取时间」，无法区分外送订单。
    // 注意：订单详情页 order-view 读取的键名必须与此处一致。
    //       当前键名保持「自取门店」「自取时间」不变（订单页仍按此读取），
    //       另加「配送方式」以区分；待云开发重构订单结构时统一改为 pickup/delivery 字段。
    const isDelivery = this.data.isDelivery
    const modeText = isDelivery ? '外送' : '自提'
    const extJsonStr = {}
    extJsonStr['配送方式'] = modeText
    extJsonStr['自取门店'] = this.data.shopInfo.name
    extJsonStr['联络电话'] = contactPhone
    // ===== 阶段 4.8：订单里存**绝对时间** =====
    // data.fetchTime 是给顾客看的相对文案（"今天 15:00"），商家隔天根本没法核对；
    // select-time 选时间时已把绝对值写进 storage.expectTime（YYYY-MM-DD HH:mm），
    // 这里优先存绝对值，只有老数据/异常情况下才回退到文案。
    // expectTimeAbs 在创建订单前的校验里已经读取过（同一函数作用域），直接复用。
    const timeForOrder = expectTimeAbs || this.data.fetchTime
    extJsonStr['自取时间'] = timeForOrder

    // ===== 改造：外送订单写入完整收货地址快照与运费信息 =====
    // 说明：这些字段同时写入 extJson（便于订单详情展示）与 postData 顶层
    //      （供云函数重算运费与保存结构化字段）。
    let postAddress = null
    if (isDelivery) {
      const addr = this.data.selectedAddress || {}
      postAddress = {
        name: addr.name || '',
        phone: addr.phone || '',
        province: addr.province || '',
        city: addr.city || '',
        district: addr.district || '',
        detail: addr.detail || '',
        latitude: addr.latitude || 0,
        longitude: addr.longitude || 0,
        tag: addr.tag || ''
      }
      extJsonStr['收货人'] = postAddress.name
      extJsonStr['收货电话'] = postAddress.phone
      extJsonStr['收货地址'] = ADDR.formatFull(addr) || postAddress.detail
      extJsonStr['期望送达时间'] = timeForOrder
      if (this.data.quote && this.data.quote.distanceKm !== null && this.data.quote.distanceKm !== undefined) {
        extJsonStr['配送距离'] = this.data.quote.distanceKm + '公里'
      }
      extJsonStr['运费'] = this.data.freight === null
        ? this.data.freightText
        : (Number(this.data.freight) === 0 ? '免配送费' : '¥' + this.data.freight)
      // 保留原配送说明（供商家参考）
      extJsonStr['配送说明'] = (SHOP_CONFIG.delivery && SHOP_CONFIG.delivery.reminder) || ''
    }

    const postData = {
      token,
      goodsJsonStr: JSON.stringify(goodsJson),
      // 2026-10-10：isCanHx 已随扫码核销下线一起移除（云函数不再生成核销码）
      remark: this.data.remark,
      extJsonStr: JSON.stringify(extJsonStr),
      shopIdZt: this.data.shopInfo.id,
      shopNameZt: this.data.shopInfo.name,
      // ===== 改造：传给云函数用于服务端重算运费 =====
      // 注意：freightAmount 仅用于服务端比对，服务端会用同一套规则重算并以其结果为准
      deliveryMode: isDelivery ? 'delivery' : 'pickup',
      address: postAddress,
      freightAmount: this.data.freight === null ? null : this.data.freight
    }
    // https://www.yuque.com/apifm/nu0f75/qx4w98
    const res = await API.orderCreate(postData)
    if (res.code != 0) {
      wx.showToast({
        title: res.msg,
        icon: 'none'
      })
      return;
    }
    // https://www.yuque.com/apifm/nu0f75/ps2q28
    await API.shippingCarInfoRemoveAll(token)
    // 阶段 5.6：订单已生成（服务端也已清空购物车）→ 锁住本页的下单入口。
    // 支付弹窗走完之前顾客若再点一次「去支付」，原来会生成第二张重复订单。
    this._ordered = true

    // ===== 阶段 5.1 复核整改：下单金额与页面展示金额不一致时先告知顾客 =====
    // 场景：顾客在结算页停留期间商家改了价（或运费被服务端重算）。
    // 服务端返回的 amountReal 是**权威金额**，但顾客看到的是页面上的 88 元，
    // 直接发起支付就等于"未经告知扣了另一个金额"。这里明确二次确认。
    const serverTotal = Number(res.data.amountReal)
    const shownTotal = this.shownAmount()
    const amountDiffers = Number.isFinite(serverTotal) && Number.isFinite(shownTotal) &&
      Math.round(serverTotal * 100) !== Math.round(shownTotal * 100)

    if (amountDiffers) {
      wx.showModal({
        title: '金额已更新',
        content: '商品价格或运费发生了变化：\n页面上显示 ' + shownTotal + ' 元，实际应付 ' + serverTotal +
          ' 元。\n确认按 ' + serverTotal + ' 元支付吗？',
        confirmText: '确认支付',
        cancelText: '暂不支付',
        success: (r) => {
          if (r.confirm) {
            wxpay.wxpay('order', serverTotal, res.data.id, '/pages/current-order/index')
          } else {
            // 订单已生成（未支付），15 分钟后会自动取消；带顾客去订单页看这笔单
            wx.reLaunch({ url: '/pages/current-order/index' })
          }
        }
      })
      return
    }

    wx.showToast({
      title: '下单成功！',
      icon: 'success'
    })
    // 2026-09-26 阶段二：已删除会员余额支付分支。
    // 删除内容：读取用户余额（API.userAmount）→ 计算 money = amountReal - balance
    //          → 余额足够时走 API.orderPayV2（"用余额支付"）的整段逻辑。
    // 原因：会员卡 / 积分 / 余额体系整体删除，orderPayV2 与云函数 orderPay action 已移除。
    // 现行为：下单成功后统一走微信支付统一下单（云开发支付接入前会提示"云开发支付尚未接入"）。
    wxpay.wxpay('order', serverTotal, res.data.id, "/pages/current-order/index");
  },
})