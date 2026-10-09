const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const DELIVERY = require('../../utils/delivery')
const SHOP_CONFIG = require('../../shop-config')
const app = getApp()
app.configLoadOK = () => {
  
}

Page({
  data: {
    cid: '',
    showCartPop: false,
    // 改造：自提 / 外送切换状态（简化版外送，仅记录选择，不含地址与运费）
    isDelivery: false,
    deliveryEnabled: false,
    deliveryReminder: '',
    // ===== 改造（2026-02-14 点单页交互与结算栏优化）=====
    // 购物车视图数据：由 shippingCarInfo() 的返回派生，供 wxml 直接渲染。
    // 说明：不是新的业务数据，只是后端 cartSummary 返回值的展示层映射
    //       （后端契约见 cloudfunctions/api/handlers.js:167-203）。
    cartItems: [],   // 每项：后端字段 + specText（规格文字）+ subtotal（小计）
    cartCount: 0,    // = res.data.number（总件数）
    cartPrice: 0     // = res.data.price（商品合计，后端已算好，前端不重算）
  },
  onLoad: function (options) {
    this.syncDeliveryMode()
    this.setData({
      shopInfo: wx.getStorageSync('shopInfo')
    })
    this.goodsCategory()
    this.getGoodsList()
  },
  onShow: function () {
    this.syncDeliveryMode()
    this.shippingCarInfo()
  },
  // 改造：同步配送方式到页面（供顶栏切换高亮）
  syncDeliveryMode() {
    const cfg = SHOP_CONFIG.delivery || {}
    this.setData({
      isDelivery: DELIVERY.isDelivery(),
      deliveryEnabled: DELIVERY.isDeliveryEnabled(),
      deliveryReminder: cfg.reminder || ''
    })
  },
  // 改造：切换自提 / 外送
  onModeChange(e) {
    const mode = e.currentTarget.dataset.mode
    const next = DELIVERY.setMode(mode)
    this.setData({
      isDelivery: next === DELIVERY.DELIVERY
    })
  },
  async goodsCategory() {
    // https://www.yuque.com/apifm/nu0f75/racmle
    const res = await API.goodsCategoryV2()
    if (res.code == 0) {
      this.setData({
        goodsCategory: res.data
      })
    }
  },
  onCategoryClick(e) {
    var id = e.target.dataset.id;
    if (!id || id == '0') {
      this.setData({
        cid: '',
      })
      return
    }
    this.setData({
      cid: id,
    })    
    this.getGoodsList()
  },
  async getGoodsList() {
    wx.showLoading({
      title: '加载中',
    })
    const shopInfo = wx.getStorageSync('shopInfo')
    // https://www.yuque.com/apifm/nu0f75/wg5t98
    const res = await API.goodsv2({
      categoryId: this.data.cid,
      shopId: shopInfo.id,
      page: 1,
      pageSize: 100000
    })
    wx.hideLoading()
    if (res.code == 700) {
      this.setData({
        goodsList: null
      });
      return
    }
    this.setData({
      goodsList: res.data.result
    });
  },

  // ==========================================================================
  // 购物车
  // ==========================================================================
  /**
   * 拉取购物车并派生展示层字段。
   *
   * 改造（2026-02-14）：
   *   1. 兼容云开发模式 —— 云开发身份由 OPENID 决定，storage 里从来没有 token
   *      （证据：utils/auth.js 的 login()/authorize() 只写 uid，从不写 token）。
   *      原实现 `if (!token) return` 会让整条结算栏永远不显示。
   *   2. 把货架返回的值映射成 wxml 好用的结构（规格文字、小计），
   *      金额仍然只用后端返回的 price / number，前端不重算业务金额。
   */
  async shippingCarInfo(){
    const token = wx.getStorageSync('token')
    // 单一数据源（阶段三）：__isCloudMode() 恒为 true，这里不需要 token。
    // 该判断保留为兜底：万一 useCloud 被误设为 false，也不会拿空购物车去请求。
    if (!API.__isCloudMode() && !token) {
      this.setData({ cartItems: [], cartCount: 0, cartPrice: 0, shippingCarInfo: null })
      return
    }
    // https://www.yuque.com/apifm/nu0f75/awql14
    const res = await API.shippingCarInfo(token)
    if (res.code == 0) {
      const cartItems = await this.buildCartView(res.data.items || [])
      this.setData({
        shippingCarInfo: res.data,
        cartItems,
        cartCount: Number(res.data.number) || 0,
        cartPrice: Number(res.data.price) || 0
      })
    } else {
      this.setData({
        shippingCarInfo: null,
        cartItems: [],
        cartCount: 0,
        cartPrice: 0
      })
    }
  },
  /**
   * 生成购物车列表的展示数据。
   * - subtotal 小计 = 后端单价 × 数量（纯展示乘法，不参与结算金额计算）
   * - specText 规格文字：由 cart.sku 的 optionId / optionValueId 去商品详情里映射成中文名
   *   映射来源：goodsDetail.properties[].name / .childsCurGoods[].name（既有字段，不新造）
   */
  async buildCartView(items) {
    const list = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      list.push(Object.assign({}, it, {
        subtotal: Math.round((Number(it.price) || 0) * (Number(it.number) || 0) * 100) / 100,
        specText: await this.buildSkuText(it)
      }))
    }
    return list
  },
  /**
   * 规格文字：
   * 优先用后端可能返回的规格文字字段（skuDetail），没有则用 sku 数组映射中文名。
   * 商品详情按 goodsId 缓存在 this._skuNameCache，避免重复请求。
   */
  async buildSkuText(item) {
    if (item.skuDetail) return item.skuDetail
    const sku = item.sku || []
    if (!sku.length) return ''
    const nameMap = await this.getSkuNameMap(item.goodsId)
    return sku.map((s) => {
      const groupName = nameMap.groups[String(s.optionId)] || ''
      const valueName = nameMap.values[String(s.optionId) + ':' + String(s.optionValueId)] || ''
      if (!valueName) return ''
      return groupName ? groupName + ':' + valueName : valueName
    }).filter((t) => t).join('、')
  },
  async getSkuNameMap(goodsId) {
    if (!this._skuNameCache) this._skuNameCache = {}
    if (this._skuNameCache[goodsId]) return this._skuNameCache[goodsId]
    const empty = { groups: {}, values: {} }
    const res = await API.goodsDetailV2({ id: goodsId, token: wx.getStorageSync('token') })
    if (!res || res.code != 0 || !res.data) {
      this._skuNameCache[goodsId] = empty
      return empty
    }
    const groups = {}
    const values = {}
    ;(res.data.properties || []).forEach((group) => {
      groups[String(group.id)] = group.name || ''
      ;(group.childsCurGoods || []).forEach((child) => {
        values[String(group.id) + ':' + String(child.id)] = child.name || ''
      })
    })
    const map = { groups, values }
    this._skuNameCache[goodsId] = map
    return map
  },
  showCartList() {
    this.setData({
      showCartPop: true
    })
  },
  hideCartList() {
    this.setData({
      showCartPop: false
    })
  },
  // 关闭购物车弹层（原 wxml 绑定了 bind:close="onClose" 但方法缺失）
  onClose() {
    this.setData({
      showCartPop: false
    })
  },
  async changeNumber(e) {
    const key = e.target.dataset.key
    const token = wx.getStorageSync('token')
    if (e.detail == 0) {
      // 删除（沿用现有规则：数量减到 0 即删除该项）
      wx.showLoading({
        title: '删除中...',
      })
      // https://www.yuque.com/apifm/nu0f75/pndgyc
      const res = await API.shippingCarInfoRemoveItem(token, key)
      wx.hideLoading()
      if (res.code != 0) {
        wx.showToast({
          title: res.msg,
          icon:'none'
        })
      } else {
        this.shippingCarInfo()
      }
    } else {
      // 修改数量
      wx.showLoading({
        title: '',
      })
      // https://www.yuque.com/apifm/nu0f75/kbi5b0
      await API.shippingCarInfoModifyNumber(token, key, e.detail)
      this.shippingCarInfo()
      wx.hideLoading()
    }
  },
  // 改造：购物车列表里的「删除」按钮（走同一个 RemoveItem 接口）
  async onRemoveItem(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    wx.showLoading({ title: '删除中...' })
    const res = await API.shippingCarInfoRemoveItem(wx.getStorageSync('token'), key)
    wx.hideLoading()
    if (res.code != 0) {
      wx.showToast({ title: res.msg || '删除失败', icon: 'none' })
      return
    }
    this.shippingCarInfo()
  },
  // 改造：清空购物车（复用 API.shippingCarInfoRemoveAll，需二次确认）
  onClearCart() {
    if (!this.data.cartCount) {
      wx.showToast({ title: '购物车已经是空的', icon: 'none' })
      return
    }
    wx.showModal({
      title: '清空购物车',
      content: '确定要清空购物车里的全部商品吗？',
      confirmColor: '#ff2d2d',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '清空中...' })
        const res = await API.shippingCarInfoRemoveAll(wx.getStorageSync('token'))
        wx.hideLoading()
        if (res.code != 0) {
          wx.showToast({ title: res.msg || '清空失败', icon: 'none' })
          return
        }
        this.shippingCarInfo()
      }
    })
  },

  // ==========================================================================
  // 商品卡片点击
  // ==========================================================================
  // 改造（2026-02-14）：商品卡片整块区域、以及卡片上的「＋」号，都进入商品详情/规格选择。
  // 原实现：只有图片能进详情（wxml 上 image 单独绑定）；「＋」直接静默加购（见下方 addCart）。
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: '/pages/goods-details/index?id=' + id,
    })
  },
  /**
   * 保留说明（2026-02-14）：
   *   本方法为「点单页加号直接加购」的旧实现，改造后 wxml 已不再绑定它
   *   （加号改为 goDetail，进入详情页选规格后再加购，与需求一致）。
   *   按项目约定不删除可复用逻辑，故保留；若将来需要「无规格商品一键加购」可重新绑定。
   */
  async addCart(e) {
    // 判断登陆状态
    const isLogined = await AUTH.checkHasLogined()
    if (!isLogined) {
      AUTH.authorize().then(res => {
        this.addCart(e)
      })
      return
    }
    const index = e.currentTarget.dataset.index
    const curGood = this.data.goodsList[index]
    if (!curGood) {
      return
    }
    // 2026-10-09：库存概念已整体删除，不再有「已售罄」拦截
    // https://www.yuque.com/apifm/nu0f75/et6m6m
    const res = await API.shippingCarInfoAddItemV2({
      token: wx.getStorageSync('token'),
      goodsId: curGood.id,
      number: 1,
      sku: []
    })
    if (res.code == 30002) {
      // 需要 sku
      wx.navigateTo({
        url: '/pages/goods-details/index?id=' + curGood.id,
      })
      return
    }
    if (res.code != 0) {
      wx.showToast({
        title: res.msg,
        icon: 'none'
      })
      return
    }
    this.shippingCarInfo()
    wx.showToast({
      title: '成功加入购物车',
      icon: 'success'
    })
  },
  // 改造：底部结算栏「去结算」
  // 复用现有结算页，不新建页面；空购物车给出提示而不是静默跳转
  onCheckout() {
    if (!this.data.cartCount) {
      wx.showToast({
        title: '请先选购商品',
        icon: 'none'
      })
      return
    }
    wx.navigateTo({
      url: '/pages/pay/index'
    })
  },
  tabbarChange(e) {
    app.tabbarChange(e)
  },
})
