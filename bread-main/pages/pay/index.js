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
 *   参考图中的「会员卡 / 余额支付 / 储值卡」未实现：会员、积分、余额体系
 *   在阶段二已整体删除，不做假数据。
 *   （「优惠券」已于阶段 11 实现：结算页可选券、金额由服务端算，见文件下方
 *     "阶段 11：优惠券" 一节。）
 * ---------------------------------------------------------------------------
 */
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const wxpay = require('../../utils/pay.js')
// 2026-10-17 顾客反馈：退出登录后不允许下单/去支付（必须重新登录）
const LOGIN_GATE = require('../../utils/login-gate')
// 2026-10-19（上线清单 P0-4）：下单前的隐私同意门禁（合规硬要求，见 createorder）
const PRIVACY = require('../../utils/privacy')
const SHOP_CONFIG = require('../../shop-config')
const DELIVERY = require('../../utils/delivery')
const ADDR = require('../../utils/address')
const DR = require('../../utils/delivery-range')
// 区域外等提示文案统一取自**运行期规则**（见 recalcQuote 的 syncDeliveryRule）：
// 阶段 8 起 app_config.delivery_rule 可以覆盖文案，页面里不能再读静态副本。
const LOC = require('../../utils/location')

// 联络电话在本地持久化的键名（顾客手填后下次自动带出）
const CONTACT_PHONE_KEY = 'contactPhone'

/** 金额文案（去掉多余的 0：10.00 → '10'，10.50 → '10.5'；与服务端 moneyText 同口径） */
function formatMoney(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100)
}

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
    // 阶段 9：打包费合计（元，服务端 cartSummary 返回；默认 0 = 本店未收打包费）
    packingFee: 0,
    // 阶段 9：自提时的「合计」= 商品金额 + 打包费。
    // 在 JS 里算好并 round，不让 wxml 做浮点加法（178.1 + 2.2 在 wxml 里会渲染成 180.29999999999998）
    pickupTotal: 0,
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
    submitting: false,
    // ===== 阶段 11：优惠券 =====
    // couponList: 顾客可见的券（couponList，含"我的资格"；用于入口提示）
    couponList: [],
    couponCount: 0,
    // coupons: 当前购物车可用的券（couponUsableForCart；含服务端算好的 discount）
    coupons: [],
    couponsLoading: false,
    couponError: false,
    couponPopupShow: false,
    // 选中的券（'' = 不使用）
    selectedCouponId: '',
    selectedCouponName: '',
    couponRuleText: '',
    // 服务端算好的优惠金额（只展示，不自己算）
    couponDiscount: 0,
    couponSummaryText: '暂无可用优惠券'
  },
  // ===== 2026-10-14（backlog：幂等）：下单幂等键 clientOrderToken =====
  // 为什么需要：弱网下"请求其实已经到服务端、订单也写好了，只是响应丢了"时，
  //   顾客看到失败再点一次「去支付」就会生成第二张单。
  // 生命周期：同一个结算页实例内**始终复用同一个 token**（重试 = 同一笔下单意图）；
  //   重新进入结算页 = 新的一次下单意图，token 随之变化。
  // 服务端（orderCreate）用 (openid, token) 判重：重复提交直接把第一次那一单原样返回。
  _orderToken: '',
  orderToken() {
    if (!this._orderToken) {
      // 32 位随机串：服务端要求 8–64 位 A-Za-z0-9_-
      this._orderToken = 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    }
    return this._orderToken
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
    // 阶段 11：券入口提示（顾客能看到"有没有活动"；具体可用券在购物车加载后算）
    this.loadCouponList()
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
    // 阶段 8 复核（2026-10-14 真机复现）：
    //   「改完地址回到结算页，那行还是旧地址，退出重进才对」——原因是上面只在内存快照上
    //   重算文案，**没有回地址簿取最新内容**。现在统一交给 resolveAddress() 解析。
    this.resolveAddress()
    this.recalcQuote()
  },

  // ===== 改造：应用收货地址 =====
  applyAddress(addr) {
    this.setData({
      selectedAddress: addr,
      addressText: ADDR.formatFull(addr) || (addr.detail || '')
    })
  },

  /**
   * 解析「当前应显示的收货地址」（阶段 8 复核新增）
   * ---------------------------------------------------------------------------
   * 优先级：**选中地址（按 id 回地址簿取最新内容）** > 地址簿默认地址 > 无
   *
   * 为什么必须按 id 回查而不是直接用内存里的 selectedAddress：
   *   1) 顾客在地址簿里**编辑了当前选中的那条**（改了门牌/重新选点）后回到结算页，
   *      内存快照还是旧的 → 屏幕上显示旧地址、运费也按旧坐标算
   *      （2026-10-14 真机复现：必须退出小程序重进才刷新）；
   *   2) 顾客把选中的地址**删掉**了，快照还在 → 会照着一个不存在的地址下单。
   * 两种情况都在这里收口：每次 onShow 都重新解析一次。
   */
  resolveAddress() {
    const selected = this.data.selectedAddress

    // 1) 有选中地址且带 id：回地址簿取最新内容
    if (selected && selected.id) {
      const fresh = ADDR.getById(selected.id)
      if (fresh) {
        this.applyAddress(fresh)
        return
      }
      // 已被删除 → 清掉选中态，下面走默认地址
      this.setData({ selectedAddress: null })
    } else if (selected) {
      // 历史数据没有 id（早期版本存的地址）→ 无法回查，保留原快照，别把地址清空
      this.applyAddress(selected)
      return
    }

    // 2) 没有选中地址（或被删了）→ 用地址簿默认地址
    const def = ADDR.getDefault()
    if (def) {
      this.applyAddress(def)
      return
    }

    // 3) 一条地址都没有：明确清空，避免显示上一次的残留
    this.setData({ selectedAddress: null, addressText: '' })
  },

  // ===== 改造：跳转地址选择页 =====
  goSelectAddress() {
    wx.navigateTo({
      url: '/pages/address/index?select=1'
    })
  },

  // ===== 阶段 8：装入云库下发的配送规则 =====
  // app.js 启动时把 appConfig 返回的 delivery_rule（完整规则）写进 storage，
  // 这里每次重算前同步一次，保证**前端与云函数用的是同一份规则** ——
  // 否则会出现"屏显运费 5 元、服务端实收 8 元"这类审计 D-01 同族问题。
  // 取不到（首次启动、云函数不可用、老版本 storage）时回退代码默认值。
  syncDeliveryRule() {
    let rule = null
    try {
      rule = wx.getStorageSync('delivery_rule') || null
    } catch (e) {
      rule = null
    }
    DR.setDeliveryRule(rule)
  },

  // ===== 改造：重新计算运费报价 =====
  // 规则全部来自 utils/delivery-range（与云函数服务端同一套）
  recalcQuote() {
    // 阶段 8：先把云库规则装进来，再算（顺序不能反）
    this.syncDeliveryRule()

    const goodsAmount = Number(this.data.goodsAmount) || 0
    // 阶段 9：打包费（元，合计）= 服务端 cartSummary 按"每件打包费 × 件数"算好的，
    // 前端只负责显示与加总 —— 绝不自己乘一遍，避免出现第二种口径。
    const packingFee = Number(this.data.packingFee) || 0
    // 阶段 11：优惠券抵扣（服务端 couponUsableForCart 已经算好，前端只展示）。
    // 优惠只抵商品金额，且不允许把商品金额抵成负数（与服务端 orderCreate 同口径）。
    const couponDiscount = Math.min(Number(this.data.couponDiscount) || 0, goodsAmount)
    // 抵扣后的商品金额 + 打包费：不涉及运费的几个分支都直接用这个基数
    const goodsPlusPacking = Math.round(
      (Math.max(0, goodsAmount - couponDiscount) + packingFee) * 100
    ) / 100

    // 自提：无运费。距离气泡留空 → 由 shop-map 显示「距离您 X」（去店里取，这个距离才有意义）
    if (!this.data.isDelivery) {
      this.setData({
        quote: null,
        freight: 0,
        freightText: '自提免运费',
        payableAmount: goodsPlusPacking,
        // 自提时的合计（= 商品 - 优惠 + 打包费），底部栏与 shownAmount() 共用
        pickupTotal: goodsPlusPacking,
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
        payableAmount: goodsPlusPacking,
        pickupTotal: goodsPlusPacking,
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
        payableAmount: goodsPlusPacking,
        pickupTotal: goodsPlusPacking,
        deliveryTip: '',
        mapDistanceText: '待确认'
      })
      return
    }

    // 组装商品信息用于蛋糕规则判断（购物车项需带商品快照）
    const items = (this.data.cartItemsForQuote || [])
    const quote = DR.calcQuote({ address, goodsAmount, items })

    // 应付金额：运费待确认(null)时先按商品金额计，最终以服务端返回为准
    // 阶段 11：优惠只抵商品金额（不含运费），与服务端 orderCreate 同口径
    const freightValue = quote.freight === null ? 0 : quote.freight
    const payableAmount = Math.round(
      (Math.max(0, goodsAmount - couponDiscount) + packingFee + freightValue) * 100
    ) / 100

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
      // 底部栏在自提分支读 pickupTotal；外送分支读 payableAmount。
      // 两个值都把优惠算进去了，避免"切一次配送方式优惠就没了"。
      pickupTotal: goodsPlusPacking,
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
    // 阶段 9：切换配送方式会改变**运费**（距离/档位）与**单价**（自取立减 pickupDiscount），
    // 所以必须重新拉一次购物车 —— 否则页面还按上一个渠道的单价显示。
    this.shippingCarInfo()
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
        packingFee: 0,
        pickupTotal: 0,
        cartEmpty: false,
        cartLoadError: true,
        cartLoaded: true,
        priceChangedTip: '',
        cartUnavailableTip: '',
        // 阶段 11：购物车都没加载成功，券也就无从谈起（清掉旧的选用状态）
        coupons: [],
        couponsLoading: false,
        couponError: false,
        selectedCouponId: '',
        selectedCouponName: '',
        couponRuleText: '',
        couponDiscount: 0,
        couponSummaryText: '暂无可用优惠券'
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
        // 阶段 9：打包费合计（服务端算好的，前端只显示、不自己乘）
        packingFee: Number(res.data.packingFee) || 0,
        // 自提时的合计（商品 + 打包费），与底部栏、shownAmount 共用同一个值
        pickupTotal: Math.round(((Number(res.data.price) || 0) + (Number(res.data.packingFee) || 0)) * 100) / 100,
        cartItemsForQuote,
        priceChangedTip,
        cartUnavailableTip,
        quoteIncomplete,
        cartLoadError: false,
        cartLoaded: true
      })
      // 商品金额变化会影响运费（是否满 35 元），需要重算
      this.recalcQuote()
      // 阶段 11：商品金额变了 → 可用券与预估优惠也要按新金额重算（服务端唯一口径）
      this.refreshCoupons()
    }
  },

  // 阶段 5.6 复核整改：购物车加载失败的重试入口（wxml 里的「点击重试」）
  retryCart() {
    this.setData({ cartLoadError: false, cartLoaded: false })
    this.shippingCarInfo()
  },

  // =========================================================================
  // 阶段 11：优惠券
  // -------------------------------------------------------------------------
  // 三条原则：
  //   1) **金额不在前端算**：券能不能用、能减多少，全部来自服务端
  //      couponUsableForCart（下单时 orderCreate 会用同一套逻辑再校验一次）；
  //   2) 接口失败**不阻塞下单**：按"不使用优惠券"处理，页面金额与实付口径一致；
  //   3) 一单一张：弹层里选一张，选"不使用"即取消；未支付取消/超时后优惠券自动退回（弹层底部有文案）。
  // =========================================================================

  /** 顾客可见的券（券入口提示用；具体到购物车的可用性交给 refreshCoupons） */
  async loadCouponList() {
    let res = null
    try {
      res = await API.couponsAvailable()
    } catch (e) {
      // 券接口异常绝不能影响下单：入口如实显示"暂无可用优惠券"
      res = null
    }
    if (!res || res.code != 0 || !res.data || !Array.isArray(res.data.coupons)) {
      this.setData({ couponList: [], couponCount: 0 })
      this.refreshCouponSummary()
      return
    }
    const eligible = res.data.coupons.filter((c) => c && c.eligible)
    this.setData({
      couponList: res.data.coupons,
      couponCount: eligible.length
    })
    this.refreshCouponSummary()
  },

  /**
   * 拉取"当前购物车可用券 + 预估优惠"（服务端唯一口径）。
   * 触发时机：购物车加载完 / 切换自提外送 / 打开选券弹层。
   */
  async refreshCoupons() {
    if (!this.data.shippingCarInfo || this.data.cartEmpty) {
      this.setData({ coupons: [], couponsLoading: false, couponError: false })
      this.applySelectedCoupon(null)
      return
    }
    this.setData({ couponsLoading: true, couponError: false })
    let res = null
    try {
      res = await API.couponUsableForCart()
    } catch (e) {
      res = null
    }
    if (!res || res.code != 0 || !res.data || !Array.isArray(res.data.coupons)) {
      // 券接口失败不阻塞下单：按"不使用优惠券"处理（金额仍与下单口径一致）
      this.setData({ coupons: [], couponsLoading: false, couponError: true })
      this.applySelectedCoupon(null)
      return
    }
    const coupons = res.data.coupons
    // 之前选中的券如果还能用就保留；否则默认选服务端推荐的最优券。
    // 例外：顾客已经明确选了「不使用优惠券」→ 尊重选择，不再自动帮他选一张。
    let selected = coupons.filter((c) => c.id === this.data.selectedCouponId && c.usable)[0]
    if (!selected && !this._couponOptOut) {
      selected = coupons.filter((c) => c.id === res.data.bestCouponId && c.usable)[0] || null
    }
    this.setData({ coupons: coupons, couponsLoading: false, couponError: false })
    this.applySelectedCoupon(selected)
  },

  /** 应用 / 取消选中券：只保存服务端给的 discount，绝不用券面金额自己算 */
  applySelectedCoupon(coupon) {
    this.setData({
      selectedCouponId: coupon ? coupon.id : '',
      selectedCouponName: coupon ? coupon.name : '',
      couponRuleText: coupon ? coupon.ruleText || '' : '',
      couponDiscount: coupon ? Number(coupon.discount) || 0 : 0
    })
    this.refreshCouponSummary()
    // 实付金额随优惠变化（自提 / 外送两条分支都在 recalcQuote 里）
    this.recalcQuote()
  },

  /** 券行文案：选中时显示券名与抵扣额，否则按可用数量提示 */
  refreshCouponSummary() {
    let text = '暂无可用优惠券'
    if (this.data.selectedCouponId) {
      text = this.data.selectedCouponName +
        '（-' + formatMoney(this.data.couponDiscount) + ' 元）'
    } else if (this._couponOptOut) {
      // 顾客明确点了「不使用优惠券」：别在下次刷新时又自动帮他选一张
      text = '不使用优惠券'
    } else {
      const usableCount = (this.data.coupons || []).filter((c) => c.usable).length
      if (usableCount > 0) text = '有 ' + usableCount + ' 张可用'
      else if (this.data.couponCount > 0) text = '有 ' + this.data.couponCount + ' 张券（未满足使用条件）'
    }
    this.setData({ couponSummaryText: text })
  },

  openCouponPopup() {
    if (this.data.cartEmpty) {
      wx.showToast({ title: '购物车是空的', icon: 'none' })
      return
    }
    this.setData({ couponPopupShow: true })
    // 每次打开都按当前购物车重算一次（金额与资格可能已经变了）
    this.refreshCoupons()
  },

  closeCouponPopup() {
    this.setData({ couponPopupShow: false })
  },

  onCouponTap(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = String(ds.id || '')
    if (!id) {
      // 记住"顾客主动选择不使用"：后续刷新不再自动帮他选券
      this._couponOptOut = true
      this.applySelectedCoupon(null)
      this.closeCouponPopup()
      return
    }
    const usable = ds.usable === true || ds.usable === 'true'
    const coupon = (this.data.coupons || []).filter((c) => c.id === id)[0]
    // 不可用的券给出服务端的原因（"再买 ¥X 可用" / "仅限新顾客"…），不做"点了没反应"
    if (!usable) {
      wx.showToast({ title: ds.reason || (coupon && coupon.reason) || '这张券暂时不可用', icon: 'none' })
      return
    }
    if (coupon) {
      this._couponOptOut = false
      this.applySelectedCoupon(coupon)
    }
    this.closeCouponPopup()
  },

  /**
   * 阶段 5.1：页面上展示给顾客的合计金额。
   * 下单成功后会拿它与服务端返回的 amountReal 比对 —— 不一致说明下单那一刻
   * 商家改过价或运费被服务端重算过，必须先告知顾客再发起支付（见 _createOrder）。
   * 自提 = 商品金额 - 优惠 + 打包费；外送 = 商品金额 - 优惠 + 打包费 + 运费
   * （与 wxml 的展示口径一致；优惠金额来自服务端 couponUsableForCart）。
   */
  shownAmount() {
    if (this.data.isDelivery) return Number(this.data.payableAmount) || 0
    // 阶段 9：自提 = 商品金额 + 打包费；阶段 11：再减优惠（pickupTotal 与底部「合计」同值）
    return Number(this.data.pickupTotal) || 0
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
    // 2026-10-17 顾客反馈：退出登录后必须重新登录才能下单/支付。
    // 门禁放在最前面：连"提交中/已下单"的判断都不走，先弹登录层；登录成功后自动继续下单。
    if (LOGIN_GATE.isLoggedOut()) {
      LOGIN_GATE.requireLogin(this, () => this.createorder())
      return
    }
    // ===== 2026-10-19（上线清单 P0-4）：隐私同意门禁（合规硬要求）=====
    // 问题：此前结算页只校验手机号，**未同意隐私政策也能下单** —— 等于在未取得同意
    // 的情况下收集手机号/收货地址等个人信息。这里在**登录门禁之后、提交中防抖判断之前**
    // 与登录门禁同级拦截：未同意先让顾客明确同意（ensureAgreed 为 fail-closed：
    // 取消 / 弹窗失败 / 平台明确拒绝都返回 false），不同意则明确提示并直接 return，
    // **不发起下单**。注意顺序：门禁必须在 _submitting 判断之前（与登录门禁同级）；
    // 已同意时 hasAgreed() 直接为 true，不进入 await 分支，不影响"连点只发一次"。
    if (!PRIVACY.hasAgreed()) {
      const ok = await PRIVACY.ensureAgreed()
      if (!ok) {
        wx.showToast({ title: '需同意隐私政策后才能下单', icon: 'none' })
        return
      }
    }
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

  /** 登录弹层登录成功：继续刚才被拦下的下单动作；没有待继续动作就刷新购物车 */
  onLoginSuccess() {
    LOGIN_GATE.onLoginSuccess(this, () => this.shippingCarInfo())
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
          content: this.data.quote.freightText || DR.getDeliveryRule().area.outOfAreaTip,
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
      // ===== 2026-10-14（backlog：幂等）：幂等键 =====
      // 同一页实例内重试始终带同一个值；服务端据此保证"重复提交只落一张单"。
      clientOrderToken: this.orderToken(),
      // ===== 改造：传给云函数用于服务端重算运费 =====
      // 注意：freightAmount 仅用于服务端比对，服务端会用同一套规则重算并以其结果为准
      deliveryMode: isDelivery ? 'delivery' : 'pickup',
      // 2026-10-14 审查修复：把**绝对时间**也作为结构化字段交给服务端。
      //   原来期望时间只写在 extJson 的可读文案里（"今天 22:00"），服务端无法校验
      //   "营业时间 / 蛋糕提前 3 小时" 这条规则 —— 现在云函数会用它做权威校验。
      expectTime: expectTimeAbs || '',
      address: postAddress,
      freightAmount: this.data.freight === null ? null : this.data.freight,
      // ===== 阶段 11：优惠券 =====
      // 只传"想用哪张"；能不能用、减多少由 orderCreate 重新校验并重算（前端改不了金额）。
      couponId: this.data.selectedCouponId || ''
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
    // 2026-10-14（backlog：幂等）：**幂等重放时不重复清车**。
    //   res.data.duplicated = true 表示这一单在第一次请求时就已经建好（响应丢了、
    //   顾客重试）、购物车里的本单商品当时已由服务端清掉；再 RemoveAll 一次会把顾客
    //   在这期间新加的商品一起删掉。
    if (!(res.data && res.data.duplicated)) {
      await API.shippingCarInfoRemoveAll(token)
    }
    // 阶段 5.6：订单已生成（服务端也已清空购物车）→ 锁住本页的下单入口。
    // 支付弹窗走完之前顾客若再点一次「去支付」，原来会生成第二张重复订单。
    this._ordered = true

    // ===== 2026-10-19（P1-5）：运费待确认的订单不进入收银台 =====
    // 距离超出最后一档 / 地图没取到坐标时，服务端下单时运费按 0 记（amountReal 不含运费）。
    // 这时直接支付会漏收运费，所以先让顾客知道"订单已保存、等门店确认运费后再付"，
    // 而不是先拉起收银台、再被服务端拒绝。
    if (res.data && res.data.needsFreightConfirm) {
      wx.showModal({
        title: '订单已提交，运费待确认',
        content: '该地址的配送费需要门店电话确认。确认后可在「我的订单」里继续支付；' +
          '15 分钟内未支付订单会自动取消。',
        showCancel: false,
        confirmText: '查看订单',
        success: () => wx.reLaunch({ url: '/pages/current-order/index' })
      })
      return
    }

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
        content: '商品价格、运费或优惠券发生了变化：\n页面上显示 ' + shownTotal + ' 元，实际应付 ' + serverTotal +
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
    // 2026-10-19 P0-1：下单成功后统一走微信支付统一下单；支付成功后由 utils/pay.js
    // 调 orderPayConfirm 向服务端确认到账（未配置商户号时提示「线上支付暂未开通」）。
    wxpay.wxpay('order', serverTotal, res.data.id, "/pages/current-order/index");
  },
})