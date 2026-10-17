const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
// 2026-10-17 顾客反馈：退出登录后不允许加购（必须重新登录）
const LOGIN_GATE = require('../../utils/login-gate')
// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩与随之无用的 getApp()。
Page({
  data: {
    curbanner: 0,
    // ===== 改造：支持多组规格 =====
    // 原实现只有一个 kouwei 数组 + 一个 kouweiIndex，即「只能选一组规格」。
    // 现改为 specGroups（每组一组标签）+ selectedIndices（每组的选中项）。
    specGroups: [],
    selectedIndices: [],
    // ===== 改造（2026-02-14 按用户截图重做详情页）=====
    // 1. selectedText：底部「已选规格」汇总行，如「400克、马路爆爆珠、马路爆爆珠」
    // 2. basePrice：商品基础价（后端 basicInfo.minPrice），按用户确认的既有价格规则
    //    「最终价 = 基础价 + 各选中项 priceDelta 之和」计算，与云函数 calcPrice 同规则
    //    （证据：cloudfunctions/api/handlers.js:36-61；cloud-data/02-schema-goods.js:44-45）
    // 3. 划线原价 /「新客价」：数据层不存在该字段，故不做假数据；
    //    待 goods 集合补充字段后再渲染（见文件末尾注释说明）。
    selectedText: '',
    basePrice: 0,
    // 底部价格区显示的「当前合计」= 基础价 + 各选中项 priceDelta 之和
    displayPrice: 0,
    buyedNumber: 0,
    key: undefined, // 购物车的key
    // 阶段 5.6（缺陷 P-07/P-08）：详情加载失败时页面要有明确提示，
    // 而且此时点「加入购物车」不能再抛 TypeError（见 addCart 的守卫）。
    loadError: false,
    // 阶段 5.6 复核整改：区分"加载中"与"已加载"，否则慢网下规格弹层里
    // 会先渲染一屏空的商品名 / 规格行。
    loaded: false,
    // 2026-10-12 复核整改：wxml 读到的字段显式声明（本项目约定）
    goodsDetail: null,
    // 阶段 9：价格相关提示（自取立减 / 打包费 / 起购量）。
    // 由云函数 goodsDetail 下发的三个字段拼出来，没配置的商品数组为空 → wxml 不渲染。
    priceTips: []
  },
  onLoad: function (options) {
    // options.id = 427682
    this.setData({
      goodsId: options.id
    })
    this.goodsDetail()
  },
  // ===== 改造：把后端返回的规格组转换成前端可直接渲染的结构 =====
  // 每组形如：{ pid, pname, options: [{ cid, cname, priceDelta }] }
  buildPropertyGroups(properties) {
    if (!properties || !properties.length) return []
    return properties.map((group, gi) => {
      // 沿用原代码访问方式：规格组用 id，选项用 childsCurGoods
      const pid = group.id !== undefined ? group.id : gi
      const options = (group.childsCurGoods || []).map((child, ci) => ({
        cid: child.id !== undefined ? child.id : ci,
        cname: child.name,
        priceDelta: typeof child.priceDelta === 'number' ? child.priceDelta : 0
      }))
      return {
        pid,
        pname: group.name,
        options
      }
    }).filter((g) => g.options.length > 0)
  },
  async goodsDetail() {
    // https://www.yuque.com/apifm/nu0f75/vuml8a
    const res = await API.goodsDetailV2({
      token: wx.getStorageSync('token'),
      id: this.data.goodsId,
    })
    // 阶段 5.6（缺陷 P-08）：res.code == 0 但返回体缺 data/basicInfo 时，
    // 下面几行会抛 TypeError（弱网/部署不完整时真机上就是这样白屏的）。
    if (res.code == 0 && res.data && res.data.basicInfo) {
      // ===== 改造：原来只取 properties[0]，现在构建全部规格组 =====
      const specGroups = this.buildPropertyGroups(res.data.properties)
      const bi = res.data.basicInfo
      this.setData({
        specGroups,
        // 默认每组选中第 1 项（与截图一致：进入即有默认选中，规格底色为黄色）
        selectedIndices: specGroups.map(() => 0),
        goodsDetail: res.data,
        basePrice: Number(bi.minPrice) || 0,
        // 阶段 9：把服务端下发的三个价格相关字段变成人话提示（都没配置时为空数组）
        priceTips: this.buildPriceTips(bi),
        loadError: false,
        loaded: true
      })
      this.updateSelectedText()
      this.checkBuyedNumber(bi.id)
    } else {
      this.setData({ goodsDetail: null, loadError: true, loaded: true })
    }
  },

  /**
   * 阶段 9：价格相关提示（只做展示，不参与算钱）
   * 数据来自云函数 goodsDetail 的 basicInfo：
   *   pickupDiscount 自取立减（元/件）、packingFee 打包费（元/件）、minBuyNumber 最少购买份数
   * 为什么不在详情页改价格：算钱的唯一口径在服务端（cartSummary / orderCreate），
   * 详情页再算一遍就会出现"两个口径"——于是这里只提示，金额以结算页为准。
   */
  buildPriceTips(basicInfo) {
    const bi = basicInfo || {}
    const tips = []
    const discount = Number(bi.pickupDiscount) || 0
    const packing = Number(bi.packingFee) || 0
    const minBuy = Number(bi.minBuyNumber) || 1
    if (discount > 0) tips.push('自取立减 ¥' + discount)
    if (packing > 0) tips.push('打包费 ¥' + packing + '/件')
    if (minBuy > 1) tips.push(minBuy + ' 份起购')
    return tips
  },
  bannerChange(e) {
    this.setData({
      curbanner: e.detail.current
    })
  },
  // ===== 改造（2026-02-14）：标签式规格选择，替代原来的下拉 picker =====
  // wxml 里通过 data-gi（第几组）/ data-oi（第几项）传入
  onSelectOption(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    if (isNaN(gi) || isNaN(oi)) return
    const selectedIndices = this.data.selectedIndices.slice()
    if (selectedIndices[gi] === oi) return
    selectedIndices[gi] = oi
    this.setData({
      selectedIndices
    })
    this.updateSelectedText()
    this.checkBuyedNumber(this.data.goodsDetail.basicInfo.id)
  },
  /**
   * 更新底部「已选规格」文字与当前合计价。
   * 服务端规格组是单选语义（picker 单选 + 云函数按每组的唯一选中项计价），
   * 故此处按每组取当前选中项拼接，与截图「400克、马路爆爆珠、马路爆爆珠」一致。
   * 价格规则与云函数 calcPrice 完全一致：基础价 + 各选中项 priceDelta 之和
   * （证据：cloudfunctions/api/handlers.js:36-61）。
   */
  updateSelectedText() {
    const names = []
    let price = Number(this.data.basePrice) || 0
    this.data.specGroups.forEach((group, gi) => {
      const opt = group.options[this.data.selectedIndices[gi]]
      if (!opt) return
      if (opt.cname) names.push(opt.cname)
      price += Number(opt.priceDelta) || 0
    })
    this.setData({
      selectedText: names.join('、'),
      displayPrice: Math.round(price * 100) / 100
    })
  },
  // ===== 改造：把各组选中项汇总成一个 sku 数组 =====
  buildSku() {
    const sku = []
    this.data.specGroups.forEach((group, gi) => {
      const opt = group.options[this.data.selectedIndices[gi]]
      if (opt) {
        sku.push({
          optionId: group.pid,
          optionValueId: opt.cid
        })
      }
    })
    return sku
  },
  // 两组 sku 是否等价（用于匹配购物车里已有的项）
  isSameSku(a, b) {
    const norm = (arr) => (arr || [])
      .map((s) => String(s.optionId) + ':' + String(s.optionValueId))
      .sort()
      .join(',')
    return norm(a) === norm(b)
  },
  async addCart() {
    // 2026-10-17 顾客反馈：退出登录后加购必须先重新登录（隐私勾选 + 手机号/微信登录）
    if (LOGIN_GATE.isLoggedOut()) {
      LOGIN_GATE.requireLogin(this, () => this.addCart())
      return
    }
    // 判断登陆状态
    const isLogined = await AUTH.checkHasLogined()
    if (!isLogined) {
      // 修复（2026-02-14）：原实现回调里调用 this.addCart(e)，而 addCart() 无参数、
      // e 不在作用域内，未登录用户加购会抛 ReferenceError: e is not defined。
      AUTH.authorize().then(() => {
        this.addCart()
      }).catch(() => {})
      return
    }
    // 2026-10-09：库存概念已整体删除，不再有「已售罄」拦截，直接加购
    // ===== 改造：原来只 push 第一组规格，现汇总全部组 =====
    // 阶段 5.6（缺陷 P-08）：商品详情还没加载成功（或加载失败）时，
    // 下面几行会读 this.data.goodsDetail.basicInfo.id → 抛 TypeError（弱网下真机报错且无提示）。
    if (!this.data.goodsDetail || !this.data.goodsDetail.basicInfo) {
      wx.showToast({ title: '商品信息还没加载好，请稍候', icon: 'none' })
      return
    }
    const sku = this.buildSku()
    // ===== 2026-10-14 审查修复（P1）：按「最少购买份数」一次加够 =====
    // 原来固定 number: 1，而服务端 cartAdd 会拒绝"少于起购量"的加购 →
    // 起购量 > 1 的商品会陷入"点了只弹一句'最少购买 X 份'、永远加不进去"的死路
    // （详情页没有数量控件，购物车的 stepper 只作用于已在购物车里的行）。
    // 这里按起购量作为初始数量加购；顾客仍可在购物车弹层里用 stepper 调整（服务端会校验下限）。
    const minBuy = Number(this.data.goodsDetail.basicInfo.minBuyNumber) || 1
    const buyNumber = minBuy > 1 ? minBuy : 1
    // https://www.yuque.com/apifm/nu0f75/et6m6m
    const res = await API.shippingCarInfoAddItemV2({
      token: wx.getStorageSync('token'),
      goodsId: this.data.goodsDetail.basicInfo.id,
      number: buyNumber,
      sku
    })
    if (res.code != 0) {
      wx.showToast({
        title: res.msg,
        icon: 'none'
      })
      return
    }
    this.checkBuyedNumber(this.data.goodsDetail.basicInfo.id)
    // ===== 改造（2026-02-14，用户 Q3 选 b）=====
    // 加购成功后自动返回点单页；先让 Toast 显示 600ms 再返回，体验更柔和。
    // 返回后点单页 onShow 会重新拉购物车（pages/orders/index.js:34），
    // 因此底部结算栏的数量/金额会自动刷新。
    wx.showToast({
      title: buyNumber > 1 ? '已按 ' + buyNumber + ' 份起购加入' : '已加入购物车',
      icon: 'success',
      duration: 600
    })
    setTimeout(() => {
      wx.navigateBack({
        fail: () => {
          // 极端情况（无上级页面）下兜底回点单页，避免停在空白详情页
          wx.redirectTo({ url: '/pages/orders/index' })
        }
      })
    }, 600)
  },
  /** 登录弹层登录成功：继续刚才被拦下的加购动作 */
  onLoginSuccess() {
    LOGIN_GATE.onLoginSuccess(this)
  },
  async checkBuyedNumber (goodsId) {
    // ===== 改造：原来只比对 sku[0]（多规格会串位），现按整组比对 =====
    // 阶段 5.6：详情未加载成功时不比对（否则读 goodsDetail.basicInfo 会抛 TypeError）
    if (!this.data.goodsDetail || !this.data.goodsDetail.basicInfo) return
    const currentSku = this.buildSku()
    const token = wx.getStorageSync('token')
    // https://www.yuque.com/apifm/nu0f75/awql14
    const res = await API.shippingCarInfo(token)
    if (!res || res.code != 0 || !res.data) {
      this.setData({
        buyedNumber: 0,
        key: null
      })
      return
    }
    const _goods = (res.data.items || []).find(ele => {
      if (ele.goodsId != this.data.goodsDetail.basicInfo.id) {
        return false
      }
      return this.isSameSku(ele.sku, currentSku)
    })
    if (!_goods) {
      this.setData({
        buyedNumber: 0,
        key: null
      })
      return
    }
    this.setData({
      buyedNumber: _goods.number,
      key: _goods.key
    })
  },
  async changeNumber(e) {
    const key = this.data.key
    const token = wx.getStorageSync('token')
    if (e.detail == 0) {
      // 删除
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
        this.checkBuyedNumber(this.data.goodsDetail.basicInfo.id)
      }
    } else {
      // 修改数量
      wx.showLoading({
        title: '',
      })
      // https://www.yuque.com/apifm/nu0f75/kbi5b0
      await API.shippingCarInfoModifyNumber(token, key, e.detail)
      this.checkBuyedNumber(this.data.goodsDetail.basicInfo.id)
      wx.hideLoading()
    }
  },
  // 改造（2026-02-14）：修复 wxml 绑定了 bind:close="onClose" 但方法缺失的问题。
  // 本页由点单页 navigateTo 进入，关闭即返回上一页；无上级页面时兜底回点单页。
  onClose() {
    if (!this.data.goodsDetail) {
      wx.redirectTo({ url: '/pages/orders/index' })
      return
    }
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({ url: '/pages/orders/index' })
      }
    })
  },
})

/* ===========================================================================
 * 关于截图里的「¥54 划线原价」与「新客价」（2026-02-14 说明，未实现）
 * ---------------------------------------------------------------------------
 * 现状（已全项目只读核实）：
 *   goods 集合 / 云函数返回里【没有】原价或新客价字段。
 *   检索 originPrice / marketPrice / newPrice / 划线 / 新客 均零命中；
 *   handlers.js 的 goodsDetail 只返回
 *     basicInfo{ id,name,minPrice,unit,purchaseNotes,isCake } + pics/content/properties。
 *     （2026-10-09 起 stores 字段已随库存概念一并删除）
 * 因此本页不做假数据，底部价格区只显示真实存在的：
 *   当前合计 = basicInfo.minPrice + 各选中项 priceDelta（与云函数 calcPrice 同规则）
 *   起价     = basicInfo.minPrice
 * 若将来要显示划线价与新客价，需要按顺序做两件事（本次未做，等你确认）：
 *   1. goods 集合补字段，例如：
 *        originPrice: 68      // 划线原价
 *        newCustomerPrice: 48 // 新客价（是否仅新客可见由业务决定）
 *   2. handlers.js 的 goodsDetail 把这两个字段加进 basicInfo 返回，
 *      前端再在 .detail-price-bar 里渲染。
 * =========================================================================== */
