const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const wxpay = require('../../utils/pay.js')
const SHOP_CONFIG = require('../../shop-config')
const DELIVERY = require('../../utils/delivery')
const ADDR = require('../../utils/address')
const DR = require('../../utils/delivery-range')
const app = getApp()
app.configLoadOK = () => {
  
}
Page({
  data: {
    purchaseNotes: undefined,
    mobile: '-',
    fetchTime: '请选择',
    remark: '未填写',
    // 配送方式
    isDelivery: false,
    deliveryEnabled: false,
    deliveryReminder: '',
    modeText: '自提',
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
    // 配送提示（如距离、超出范围原因）
    deliveryTip: '',
    // 购物车商品的规格快照，供蛋糕规则（6寸免配送费）判断
    // 必须声明在 data 中，否则 this.data 读取行为不可靠
    cartItemsForQuote: []
  },
  onLoad: function (options) {
    AUTH.login() // 这句不能省略
    // 改造：改用固定门店配置兜底，避免未经过首页时 shopInfo 为空导致
    //      this.data.shopInfo.name（下单处）报错。
    const shopInfo = wx.getStorageSync('shopInfo') || SHOP_CONFIG.shop
    this.setData({
      shopInfo
    })
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
    // 若没有选中过地址，则尝试带出默认地址
    if (!this.data.selectedAddress) {
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

    // 自提：无运费
    if (!this.data.isDelivery) {
      this.setData({
        quote: null,
        freight: 0,
        freightText: '自提免运费',
        payableAmount: goodsAmount,
        deliveryTip: ''
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
        deliveryTip: ''
      })
      return
    }

    // 组装商品信息用于蛋糕规则判断（购物车项需带商品快照）
    const items = (this.data.cartItemsForQuote || [])
    const quote = DR.calcQuote({ address, goodsAmount, items })

    // 应付金额：运费待确认(null)时先按商品金额计，最终以服务端返回为准
    const freightValue = quote.freight === null ? 0 : quote.freight
    const payableAmount = Math.round((goodsAmount + freightValue) * 100) / 100

    this.setData({
      quote,
      freight: quote.freight,
      freightText: quote.freightText,
      payableAmount,
      deliveryTip: quote.deliverable ? (quote.tip || '') : ''
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
      modeText: DELIVERY.getModeText()
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
    // 云开发身份由 OPENID 决定，storage 里从来没有 token（证据：utils/auth.js:89-94
    // 云模式下只写 uid 不写 token）。原实现无 token 即 navigateBack，
    // 会导致云模式下点「去结算」被立刻弹回点单页，结算流程完全不可用。
    if (!API.__isCloudMode() && !token) {
      wx.navigateBack()
      return
    }
    // https://www.yuque.com/apifm/nu0f75/awql14
    const res = await API.shippingCarInfo(token)
    if (res.code == 0) {
      let purchaseNotes = ''
      // ===== 改造：顺便收集商品快照，供配送规则（蛋糕识别、尺寸解析）使用 =====
      const cartItemsForQuote = []
      for (let index = 0; index < res.data.items.length; index++) {
        const element = res.data.items[index];
        const goodsId = element.goodsId
        // https://www.yuque.com/apifm/nu0f75/vuml8a
        const resGoods = await API.goodsDetailV2({
          id: goodsId,
          token: wx.getStorageSync('token')
        })
        if (resGoods.code == 0 && resGoods.data.basicInfo.purchaseNotes) {
          purchaseNotes += resGoods.data.basicInfo.purchaseNotes
        }
        if (resGoods.code == 0) {
          cartItemsForQuote.push({
            goods: {
              isCake: resGoods.data.basicInfo.isCake,
              properties: resGoods.data.properties || []
            },
            sku: element.sku || []
          })
        }
      }
      const goodsAmount = Number(res.data.price) || 0
      // ===== 改造：把商品快照写入 storage，供 select-time 判断是否含蛋糕 =====
      // 原因：select-time 是独立页面，需要知道购物车里有没有蛋糕，
      //      才能决定是否强制「提前3小时」。这里写入，形成明确的数据约定。
      wx.setStorageSync('checkoutItems', cartItemsForQuote)
      this.setData({
        purchaseNotes,
        shippingCarInfo: res.data,
        goodsAmount,
        cartItemsForQuote
      })
      // 商品金额变化会影响运费（是否满 35 元），需要重算
      this.recalcQuote()
    }
  },
  async userDetail() {
    // https://www.yuque.com/apifm/nu0f75/zgf8pu
    const res = await API.userDetail(wx.getStorageSync('token'))
    if (res.code == 0 && res.data.base.mobile) {
      this.setData({
        mobile: res.data.base.mobile
      })
    }
  },
  bindMobile() {
    this.setData({
      bindMobileShow: true
    })
  },
  bindMobileOk(e) {
    console.log(e.detail); // 这里是组件里data的数据
    this.setData({
      bindMobileShow: false
    })
    this.userDetail()
  },
  bindMobileCancel() {
    this.setData({
      bindMobileShow: false
    })
  },
  async createorder() {
    const token = wx.getStorageSync('token')

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
          content: this.data.quote.freightText || '超出配送范围',
          showCancel: false
        })
        return
      }
      // 期望时间再次校验（防止页面停留过久导致时间失效）
      const expectTime = wx.getStorageSync('expectTime')
      if (expectTime) {
        const check = DR.checkAdvanceTime({
          expectTime: new Date(String(expectTime).replace(/-/g, '/')),
          items: this.data.cartItemsForQuote || [],
          now: new Date(),
          openingHours: (SHOP_CONFIG.shop && SHOP_CONFIG.shop.openingHours) || ''
        })
        if (!check.valid) {
          wx.showToast({ title: check.tip, icon: 'none' })
          return
        }
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
    // 注意：订单详情页 order-view / scan-result 读取的键名必须与此处一致。
    //       当前键名保持「自取门店」「自取时间」不变（订单页仍按此读取），
    //       另加「配送方式」以区分；待云开发重构订单结构时统一改为 pickup/delivery 字段。
    const isDelivery = this.data.isDelivery
    const modeText = isDelivery ? '外送' : '自提'
    const extJsonStr = {}
    extJsonStr['配送方式'] = modeText
    extJsonStr['自取门店'] = this.data.shopInfo.name
    extJsonStr['联络电话'] = this.data.mobile
    extJsonStr['自取时间'] = this.data.fetchTime

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
      extJsonStr['期望送达时间'] = this.data.fetchTime
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
      isCanHx: true,
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
    wx.showToast({
      title: '下单成功！',
      icon: 'success'
    })
    // 2026-09-26 阶段二：已删除会员余额支付分支。
    // 删除内容：读取用户余额（API.userAmount）→ 计算 money = amountReal - balance
    //          → 余额足够时走 API.orderPayV2（"用余额支付"）的整段逻辑。
    // 原因：会员卡 / 积分 / 余额体系整体删除，orderPayV2 与云函数 orderPay action 已移除。
    // 现行为：下单成功后统一走微信支付统一下单（云开发支付接入前会提示"云开发支付尚未接入"）。
    wxpay.wxpay('order', res.data.amountReal, res.data.id, "/pages/current-order/index");
  },
})