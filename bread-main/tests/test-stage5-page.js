/**
 * 阶段 5 页面层回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 覆盖《实施步骤清单》阶段 5 的三条**页面级**缺陷：
 *
 *   5.3 结算页地址不同步（报告 P-02）
 *       选完收货地址后，结算页 wxml 渲染的 `addressText` 仍是旧地址
 *       （订单快照是对的，但**顾客核对的那一行是错的** → 最容易"送到错地址"）。
 *
 *   5.5 「我的」页登录态（报告 P-06 / P-12）
 *       `wx.getUserProfile` 已匿名化 → 永远显示"点击登录"；
 *       改用 open-type="chooseAvatar" + <input type="nickname">；
 *       同时不再把原始 OPENID 展示给顾客。
 *
 *   5.6 空态 / 错误态 / 防抖（报告 P-07 / P-08 / P-10）
 *       列表为空与接口失败必须能区分；加载失败要有重试；
 *       未加载成功时点按钮不能抛 TypeError；结算按钮要防重复下单。
 *
 * 做法（与 tests/test-order-countdown.js 一致）：
 *   能拿真实行为验证的（地址同步、防抖、错误态数据流）就把页面文件放进沙箱
 *   真跑一遍；跑不了的（wxml 结构、wx.getUserProfile 之类无法在 node 里调的 API）
 *   用源码级断言，两者都写在同一个文件里，避免"只测了字符串"。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const OS = require('../utils/order-status')
const FMT = require('../utils/format')
const CD = require('../utils/order-countdown')
const REAL_ADDR = require('../utils/address')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  OK   ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
  }
}

/**
 * 通用沙箱加载器。
 * @param {string} rel 页面文件（相对 bread-main）
 * @param {object} opts { api, requires, wx, extra }
 */
function loadPage(rel, opts) {
  const o = opts || {}
  const toasts = []
  const wxBase = Object.assign({
    showLoading() {}, hideLoading() {},
    showToast(t) { toasts.push(t && t.title) },
    showModal() {},
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    navigateBack() {},
    navigateTo() {},
    reLaunch() {},
    setNavigationBarTitle() {},
    makePhoneCall() {},
    login(o2) { if (o2 && o2.success) o2.success({ code: 'c' }) },
    getUpdateManager() { return { onUpdateReady() {}, applyUpdate() {} } },
    getAccountInfoSync() { return { miniProgram: {} } },
    createMapContext() { return { getCenterLocation() {} } },
    chooseLocation() {},
    openLocation() {},
    requestPayment() {},
    getSetting(o2) { if (o2 && o2.success) o2.success({ authSetting: {} }) },
    authorize(o2) { if (o2 && o2.success) o2.success() },
    openSetting() {}
  }, o.wx || {})
  const wx = new Proxy(wxBase, {
    get(t, k) { return k in t ? t[k] : () => {} }
  })

  const extraReq = o.requires || {}
  let pageObj = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Page: (obj) => { pageObj = obj },
    getApp: () => o.app || ({ tabbarChange() {}, globalData: {} }),
    getCurrentPages: o.getCurrentPages || (() => []),
    require: (p) => {
      for (const key of Object.keys(extraReq)) {
        if (new RegExp(key).test(p)) return extraReq[key]
      }
      if (/order-status$/.test(p)) return OS
      if (/order-countdown$/.test(p)) return CD
      if (/utils\/format$/.test(p)) return FMT
      if (/utils\/address$/.test(p)) return REAL_ADDR
      return {}
    },
    wx
  }
  vm.runInNewContext(src(rel), vm.createContext(sandbox), { filename: rel })
  if (!pageObj) throw new Error('Page() 没有被调用：' + rel)
  const inst = Object.create(pageObj)
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (d, cb) {
    Object.assign(this.data, d)
    if (cb) cb()
  }
  inst.__toasts = toasts
  return inst
}

/**
 * 临时给 Node 全局挂一个 wx 桩。
 * 为什么需要：utils/address.js 这类"真实依赖"里直接引用全局 `wx`（小程序里本来就有），
 * 在 Node 里 require 它时不会报错，但一调用就会 ReferenceError。
 */
function withGlobalWx(obj, fn) {
  const prev = global.wx
  global.wx = obj
  try {
    return fn()
  } finally {
    global.wx = prev
  }
}

// ===========================================================================
// 桩：api-map
// ===========================================================================
function makeApi(overrides) {
  return Object.assign({
    __isCloudMode: () => true,
    __dataSource: () => 'cloud',
    shippingCarInfo: async () => ({ code: 0, data: { items: [], number: 0, price: 0 } }),
    goodsDetailV2: async () => ({ code: 0, data: { basicInfo: {}, properties: [] } }),
    userDetail: async () => ({ code: 0, data: { base: {} } }),
    orderCreate: async () => ({ code: 0, data: { id: 'o1', amountReal: 0 } }),
    orderList: async () => ({ code: 0, data: { orderList: [] } }),
    orderDetail: async () => ({ code: 0, data: null }),
    shippingCarInfoRemoveAll: async () => ({ code: 0 }),
    modifyUserInfoV2: async () => ({ code: 0, data: {} }),
    uploadFile: async () => ({ code: 0, fileID: 'cloud://x/avatar.png' }),
    // 阶段 11：优惠券（默认没有券 → 金额与阶段 10 完全一致，不干扰既有断言）
    couponsAvailable: async () => ({ code: 0, data: { coupons: [] } }),
    couponUsableForCart: async () => ({
      code: 0,
      data: { goodsAmount: 0, packingFee: 0, coupons: [], bestCouponId: '', bestDiscount: 0 }
    })
  }, overrides || {})
}

const SHOP_STUB = { shop: { id: 0, name: '卿欢蛋糕', phone: '18725136710', openingHours: '09:00-22:00', latitude: 1, longitude: 2 }, delivery: { enabled: true, reminder: '' } }

async function main() {
  // =========================================================================
  console.log('=== 5.1 价格变动提示的前端接线 ===')
  // =========================================================================
  {
    const ordersJs = src('pages/orders/index.js')
    const ordersWxml = src('pages/orders/index.wxml')
    const payWxml = src('pages/pay/index.wxml')
    check('购物车弹层渲染「价格已更新」标记（读后端下发的 priceChanged）',
      /item\.priceChanged/.test(ordersWxml))
    check('buildCartView 用 Object.assign 透传后端字段（priceChanged 不会被丢掉）',
      /Object\.assign\(\{\},\s*it,/.test(ordersJs))
    check('结算页提示条读 priceChangedTip', /\{\{\s*priceChangedTip\s*\}\}/.test(payWxml))
    check('结算页提示条有 wx:if（价格没变时不占位）',
      /wx:if="\{\{\s*priceChangedTip\s*\}\}"/.test(payWxml))
    check('金额一律取后端 cartSummary 的 price/number（前端不自己算业务金额）',
      /const goodsAmount = Number\(res\.data\.price\) \|\| 0/.test(src('pages/pay/index.js')) &&
      /const goodsAmount = Number\(res\.data\.price\) \|\| 0/.test(src('pages/orders/index.js')))
    // 阶段 9：打包费也只从后端取（前端不自己乘件数），两个页面口径相同
    check('★ 打包费同样只取后端 cartSummary 的 packingFee（前端不重算）',
      /Number\(res\.data\.packingFee\) \|\| 0/.test(src('pages/pay/index.js')) &&
      /Number\(res\.data\.packingFee\) \|\| 0/.test(src('pages/orders/index.js')))
    check('价格变动标记样式已定义', /\.price-updated-tag\s*\{/.test(src('pages/orders/index.wxss')))
    check('★ 无法下单的项在购物车弹层也有标记', /item\.unavailable/.test(ordersWxml) &&
      /\.unavailable-tag\s*\{/.test(src('pages/orders/index.wxss')))
    check('★ 结算页有「无法下单」提示条', /cartUnavailableTip/.test(payWxml))
  }

  // =========================================================================
  console.log('\n=== 5.3 结算页地址同步（缺陷 P-02）===')
  // =========================================================================
  {
    const ADDR_A = { name: '张三', phone: '13800138000', province: '云南省', city: '昆明市', district: '安宁市', detail: '太平新城1号' }
    const page = loadPage('pages/pay/index.js', {
      requires: {
        'api-map$': makeApi(),
        'utils/auth$': { login() {}, wxaCode: async () => 'c', checkHasLogined: async () => true, authorize: async () => ({}) },
        'utils/pay': { wxpay() {} },
        'shop-config$': SHOP_STUB,
        'utils/delivery$': { isDelivery: () => false, isDeliveryEnabled: () => true, setMode: () => 'pickup', DELIVERY: 'delivery' },
        'delivery-range$': { calcQuote: () => ({ freight: 0, freightText: '', deliverable: true, distanceKm: null }), checkAdvanceTime: () => ({ valid: true }), setDeliveryRule: () => ({}), getDeliveryRule: () => ({ area: { outOfAreaTip: '超出配送范围' } }) },
        'config/delivery$': { area: { outOfAreaTip: '超出配送范围' } },
        'utils/location$': { formatDistance: () => '', openNavigation: async () => {} }
      }
    })
    // 复现缺陷：地址选择页只注入了 selectedAddress，addressText 还是上一个地址
    page.data.selectedAddress = ADDR_A
    page.data.addressText = '李四 13900000000 的旧地址'
    await page.onShow()
    check('★ onShow 后 addressText 已按 selectedAddress 重新生成（不再是旧地址）',
      page.data.addressText === REAL_ADDR.formatFull(ADDR_A), page.data.addressText)
    check('生成的就是完整地址文案', page.data.addressText === '云南省昆明市安宁市太平新城1号', page.data.addressText)

    // 没选过地址时仍然带出默认地址（原行为不能丢）
    // 2026-10-14 阶段 8 复核：地址解析逻辑搬进 resolveAddress()，
    //   这里改为断言「按 id 回查 + 无选中时用默认地址」两件事都在。
    const payJs = src('pages/pay/index.js')
    check('结算页会按 id 回地址簿取最新内容（编辑地址后立即生效的根）',
      /ADDR\.getById\(selected\.id\)/.test(payJs))
    check('没有选中地址时仍然回退到默认地址',
      /const def = ADDR\.getDefault\(\)/.test(payJs))
    check('不再只在「没有选中地址」时才 applyAddress（缺陷根源）',
      !/if \(!this\.data\.selectedAddress\) \{\s*const def = ADDR\.getDefault\(\)/.test(payJs))
  }

  // =========================================================================
  console.log('\n=== 5.3 续（2026-10-14 阶段 8 复核）：编辑过的地址必须立即刷新 ===')
  // 真机现象：在地址簿里改完地址回到结算页，那一行还是旧地址，退出小程序重进才对。
  // 根因：结算页只拿内存里的 selectedAddress 重算文案，没回地址簿取最新内容。
  // =========================================================================
  {
    const ADDR_OLD = {
      id: 'a_edit', name: '肖恩', phone: '13608878371',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城旧门牌1号', latitude: 24.95, longitude: 102.58, isDefault: true
    }
    // 地址簿里已经是"改过之后"的那条（同 id）
    const ADDR_NEW = Object.assign({}, ADDR_OLD, { detail: '太平新城新门牌99号', latitude: 24.96, longitude: 102.59 })
    const storageStub = (list) => ({
      getStorageSync(k) { return k === 'addressList' ? list : '' },
      setStorageSync() {}
    })

    const mkPay = (list) => loadPage('pages/pay/index.js', {
      requires: {
        'api-map$': makeApi(),
        'utils/auth$': { login() {}, wxaCode: async () => 'c', checkHasLogined: async () => true, authorize: async () => ({}) },
        'utils/pay': { wxpay() {} },
        'shop-config$': SHOP_STUB,
        'utils/delivery$': { isDelivery: () => false, isDeliveryEnabled: () => true, setMode: () => 'pickup', DELIVERY: 'delivery' },
        'delivery-range$': { calcQuote: () => ({ freight: 0, freightText: '', deliverable: true, distanceKm: null }), checkAdvanceTime: () => ({ valid: true }), setDeliveryRule: () => ({}), getDeliveryRule: () => ({ area: { outOfAreaTip: '超出配送范围' } }) },
        'config/delivery$': { area: { outOfAreaTip: '超出配送范围' } },
        'utils/location$': { formatDistance: () => '', openNavigation: async () => {} }
      },
      wx: storageStub(list)
    })

    // ① 编辑了当前选中的地址 → onShow 立即显示新内容
    const page1 = mkPay([ADDR_NEW])
    page1.data.selectedAddress = Object.assign({}, ADDR_OLD)   // 内存里的旧快照
    page1.data.addressText = REAL_ADDR.formatFull(ADDR_OLD)
    withGlobalWx(storageStub([ADDR_NEW]), () => { page1.onShow() })
    check('★ 编辑当前选中地址后，结算页 onShow 立即显示新内容（不用退出重进）',
      page1.data.addressText === REAL_ADDR.formatFull(ADDR_NEW), page1.data.addressText)
    check('  选中地址对象也换成了最新内容（下单快照不会用旧地址）',
      !!page1.data.selectedAddress && page1.data.selectedAddress.detail === ADDR_NEW.detail,
      page1.data.selectedAddress)
    check('  运费按新地址重算（用的是刷新后的坐标）',
      Math.abs(Number(page1.data.selectedAddress.latitude) - ADDR_NEW.latitude) < 1e-9,
      page1.data.selectedAddress.latitude)

    // ② 选中的地址被删除 → 回退到地址簿默认地址
    const OTHER = {
      id: 'a_other', name: '张三', phone: '13800138000',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城别的门牌2号', latitude: 24.94, longitude: 102.57, isDefault: true
    }
    const page2 = mkPay([OTHER])
    page2.data.selectedAddress = Object.assign({}, ADDR_OLD)   // 这条在地址簿里已经没有 id 了
    page2.data.addressText = REAL_ADDR.formatFull(ADDR_OLD)
    withGlobalWx(storageStub([OTHER]), () => { page2.onShow() })
    check('★ 选中地址被删除 → 回退到地址簿默认地址（不会照不存在的地址下单）',
      page2.data.addressText === REAL_ADDR.formatFull(OTHER), page2.data.addressText)

    // ③ 地址簿空 + 选中地址也没了 → 清空，不留上一单的残留
    const page3 = mkPay([])
    page3.data.selectedAddress = Object.assign({}, ADDR_OLD)
    page3.data.addressText = REAL_ADDR.formatFull(ADDR_OLD)
    withGlobalWx(storageStub([]), () => { page3.onShow() })
    check('★ 地址簿为空且选中地址已删 → 清空显示（不残留上一次的地址）',
      page3.data.selectedAddress === null && page3.data.addressText === '',
      { selected: page3.data.selectedAddress, text: page3.data.addressText })
  }
  {
    // 地址选择页：一次 setData 同时注入 selectedAddress 与 addressText（真实跑一遍）
    const ADDR_B = { id: 'a1', name: '李四', phone: '13900139000', province: '云南省', city: '昆明市', district: '安宁市', detail: '太平新城2号', isDefault: true, createdAt: 1 }
    let injected = null
    let wentBack = 0
    const prev = { setData: (d) => { injected = d } }
    const page = loadPage('pages/address/index.js', {
      requires: { 'utils/address$': REAL_ADDR },
      wx: {
        getStorageSync(k) { return k === 'addressList' ? [ADDR_B] : '' },
        navigateBack() { wentBack++ }
      },
      getCurrentPages: () => [prev, { setData() {} }]
    })
    page.data.selectMode = true
    withGlobalWx({ getStorageSync: (k) => (k === 'addressList' ? [ADDR_B] : '') }, () => {
      page.onCardTap({ currentTarget: { dataset: { id: 'a1' } } })
    })
    check('★ onCardTap 同时注入 selectedAddress 与 addressText（不再只注入前者）',
      !!injected && !!injected.selectedAddress && injected.addressText === '云南省昆明市安宁市太平新城2号',
      injected)
    check('注入后返回上一页', wentBack === 1)

    // 管理模式（非选择模式）下点卡片不应注入任何数据
    injected = null
    page.data.selectMode = false
    withGlobalWx({ getStorageSync: (k) => (k === 'addressList' ? [ADDR_B] : '') }, () => {
      page.onCardTap({ currentTarget: { dataset: { id: 'a1' } } })
    })
    check('管理模式点卡片不注入（与既有行为一致）', injected === null)

    check('onCardTap 仍在 selectMode 下才注入',
      /if \(!this\.data\.selectMode\) return/.test(src('pages/address/index.js')))
  }

  // =========================================================================
  console.log('\n=== 5.5 「我的」页登录态（缺陷 P-06 / P-12；阶段 12 起编辑资料独立成页）===')
  // =========================================================================
  {
    const myJs = src('pages/my/index.js')
    const myWxml = src('pages/my/index.wxml')
    // 注释里允许出现（用来解释"原来为什么不行"），先剥掉注释再查代码
    const myCode = myJs
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    check('★ 代码里不再使用已匿名化的 wx.getUserProfile', !/wx\.getUserProfile/.test(myCode))
    check('★ wxml 不再直接展示原始 openid（userInfo.id）',
      !/\{\{\s*userInfo\.id\s*\}\}/.test(myWxml))
    check('wxml 展示派生短编号 userNo', /\{\{\s*userNo\s*\}\}/.test(myWxml))
    check('js 用 FMT.shortUserNo 生成短编号', /FMT\.shortUserNo\(/.test(myJs))
    // 阶段 12：头像/昵称编辑搬到「编辑资料」页（入口在用户卡与常用功能里）
    const profileJs = src('pages/profile-edit/index.js')
    const profileWxml = src('pages/profile-edit/index.wxml')
    check('★ 头像选择能力在「编辑资料」页（open-type=chooseAvatar）',
      /open-type="chooseAvatar"/.test(profileWxml) &&
      /bind:chooseavatar="onChooseAvatar"/.test(profileWxml))
    check('★ 昵称填写能力在「编辑资料」页（<input type="nickname">）',
      /type="nickname"/.test(profileWxml))
    check('头像上传走 api-map 的唯一出口（uploadFile）',
      /API\.uploadFile\(/.test(profileJs) && /uploadFile:\s*uploadFile/.test(src('utils/api-map.js')))
    check('页面里不直接调用 wx.cloud.uploadFile（保持单一出口）',
      !/wx\.cloud\.uploadFile/.test(profileJs) && !/wx\.cloud/.test(profileJs))
    check('保存前拦住"头像还没上传成功"的情况',
      /avatarIsLocal[\s\S]{0,200}请重新选择/.test(profileJs))
    check('「我的」页点用户卡整行进入编辑资料', /onTapUserCard/.test(myWxml) && /goProfileEdit/.test(myJs))
    check('「我的」页不再内联编辑（旧编辑态字段已删除）',
      !/profileEditing/.test(myJs) && !/draftNick/.test(myJs))
  }
  {
    // 真实行为：点用户卡进入编辑资料页 / 短编号
    const navigations = []
    const api = makeApi({
      userDetail: async () => ({ code: 0, data: { base: { id: 'oABC123456', nick: '小明', avatarUrl: 'cloud://a.png' } } })
    })
    const page = loadPage('pages/my/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}), loginOut() {} },
        'shop-config$': SHOP_STUB,
        'utils/location$': { isDevOrTrialEnv: () => false, openNavigation: async () => {} },
        'utils/privacy$': { hasAgreed: () => true, resetAgreed() {} },
        'utils/log$': { debug() {}, warn() {}, error() {} }
      },
      wx: {
        navigateTo(o) { navigations.push(o && o.url) },
        getStorageSync(k) { return k === 'loggedOut' ? '' : '' },
        setStorageSync() {}, removeStorageSync() {}
      }
    })
    page.data.loggedOut = false
    page.data.userInfo = { id: 'oABC123456', nick: '小明', avatarUrl: 'cloud://a.png' }
    page.onTapUserCard()
    check('★ 点用户卡 → 进入「编辑资料」页',
      navigations[0] === '/pages/profile-edit/index', navigations)

    // 短编号：稳定、不可反推
    const no1 = FMT.shortUserNo('oABC123456')
    const no2 = FMT.shortUserNo('oABC123456')
    check('短编号稳定（同一 openid 结果一致）', no1 === no2 && no1.length > 0, no1)
    check('短编号格式 = QH + 6 位大写字母数字',
      /^QH[0-9A-Z]{6}$/.test(no1), no1)
    check('★ 短编号不等于也不包含原始 openid（不是换汤不换药）',
      no1 !== 'oABC123456' && no1.replace(/^QH/, '') !== 'ABC123456', no1)
    check('短编号对空入参返回空串', FMT.shortUserNo('') === '' && FMT.shortUserNo(undefined) === '')
    check('不同 openid 得到不同编号', FMT.shortUserNo('oa') !== FMT.shortUserNo('ob'))
  }

  // =========================================================================
  console.log('\n=== 5.6 空态 / 错误态 / 防抖（缺陷 P-07 / P-08 / P-10）===')
  // =========================================================================
  {
    // --- 订单列表页：失败 ≠ 空 ---
    let mode = 'fail'
    const api = makeApi({
      orderList: async () => (mode === 'fail'
        ? { code: 500, msg: '云函数调用失败' }
        : { code: 0, data: { orderList: [], serverNow: Date.now() } })
    })
    const page = loadPage('pages/current-order/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB,
        'utils/admin$': { isShopAdmin: async () => false },
        'utils/log$': { debug() {}, warn() {}, error() {} },
        'utils/pay': { wxpay() {} }
      }
    })
    await page.orderList()
    check('★ 接口失败 → loadError = true（不再谎称"暂无订单记录"）', page.data.loadError === true, page.data)
    check('接口失败时 orderList 为空', page.data.orderList === null)
    check('已请求过（loaded = true）', page.data.loaded === true)
    check('提供重试入口 retryLoad', typeof page.retryLoad === 'function')

    mode = 'empty'
    await page.orderList()
    check('★ 后端返回空数组 → loadError = false（是"确实没有"，不是"坏了"）', page.data.loadError === false)
    check('空数组被保留为 []（wxml 据此显示"暂无订单记录"）',
      Array.isArray(page.data.orderList) && page.data.orderList.length === 0, page.data.orderList)

    // 返回体缺 data 时不能抛 TypeError（原来会直接 .forEach）
    const badApi = makeApi({ orderList: async () => ({ code: 0 }) })
    const page2 = loadPage('pages/current-order/index.js', {
      requires: {
        'api-map$': badApi,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB,
        'utils/admin$': { isShopAdmin: async () => false },
        'utils/log$': { debug() {}, warn() {}, error() {} },
        'utils/pay': { wxpay() {} }
      }
    })
    let threw = null
    try { await page2.orderList() } catch (e) { threw = e }
    check('★ 云函数返回体缺 data 时不抛 TypeError', threw === null, threw && threw.message)
    check('缺 data 视为加载失败', page2.data.loadError === true)

    const listWxml = src('pages/current-order/index.wxml')
    check('wxml 有错误态分支（wx:if loadError）', /wx:if="\{\{\s*loadError\s*\}\}"/.test(listWxml))
    check('wxml 空态判断含 orderList.length == 0（空数组也要提示）',
      /orderList\.length\s*==\s*0/.test(listWxml))
    check('wxml 错误态带重试按钮', /bindtap="retryLoad"/.test(listWxml))
  }
  {
    // --- 订单详情页：加载失败要有提示，不能只剩空标题 ---
    const api = makeApi({ orderDetail: async () => ({ code: 0 }) })
    const page = loadPage('pages/order-view/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB
      }
    })
    page.data.orderId = 'o1'
    let threw = null
    try { await page.orderDetail() } catch (e) { threw = e }
    check('★ 详情返回体缺 data.orderInfo 时不抛 TypeError', threw === null, threw && threw.message)
    check('详情加载失败 → loadError = true', page.data.loadError === true)
    check('失败时清空 orderDetail（避免渲染半截数据）', page.data.orderDetail === null)
    check('详情页提供重试入口', typeof page.retryLoad === 'function')

    const okApi = makeApi({
      orderDetail: async () => ({
        code: 0,
        data: { orderInfo: { orderNumber: 'QH261012-0001', status: 1, extJson: {} }, extJson: {}, goods: [], serverNow: Date.now() }
      })
    })
    const page2 = loadPage('pages/order-view/index.js', {
      requires: {
        'api-map$': okApi,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB
      }
    })
    page2.data.orderId = 'o1'
    await page2.orderDetail()
    check('详情正常返回 → loadError = false', page2.data.loadError === false)
    check('订单详情已写入', !!(page2.data.orderDetail && page2.data.orderDetail.orderInfo))

    const viewWxml = src('pages/order-view/index.wxml')
    check('详情 wxml 有错误态节点（.order-error）', /class="order-error"/.test(viewWxml))
    check('详情 wxss 定义了错误态样式', /\.order-error\s*\{/.test(src('pages/order-view/index.wxss')))
    // 加强（原来只断言"存在 block wx:else"，几乎任何 wxml 都满足）：
    // 错误分支必须在正文之前，且正文整段被 block 包住（文件以 </block> 收尾）。
    // 阶段 12：文件末尾追加了全局 <privacy-popup />，判断"收尾"时先把它剥掉。
    const errIdx = viewWxml.indexOf('loadError')
    const blockIdx = viewWxml.indexOf('<block wx:else>')
    const viewWxmlCore = viewWxml
      .replace(/<privacy-popup\s*\/>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
    check('★ 错误态在正文之前，正文被 <block wx:else> 整段包住',
      errIdx >= 0 && blockIdx > errIdx && viewWxmlCore.endsWith('</block>'),
      { errIdx, blockIdx, tail: viewWxmlCore.slice(-20) })
    check('★ 详情页有「加载中」分支（慢网不闪空标题）',
      /wx:elif="\{\{\s*!loaded\s*\}\}"/.test(viewWxml))
    check('详情页 data 里有 loaded 字段', /loaded:\s*false/.test(src('pages/order-view/index.js')))
  }
  {
    // --- 商品详情：未加载成功时点「加入购物车」不能抛 TypeError ---
    const page = loadPage('pages/goods-details/index.js', {
      requires: {
        'api-map$': makeApi(),
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) }
      }
    })
    page.data.goodsDetail = null
    let threw = null
    try { await page.addCart() } catch (e) { threw = e }
    check('★ 详情未加载时点加购不抛 TypeError', threw === null, threw && threw.message)
    check('给出明确提示而不是静默失败', page.__toasts.some((t) => /还没加载好/.test(String(t))), page.__toasts)
    check('detail 失败分支会置 loadError', /goodsDetail: null, loadError: true/.test(src('pages/goods-details/index.js')))
    check('★ wxml 失败或加载中都先不展开规格弹层（避免半截空页面）',
      /show="\{\{\s*!loadError\s*&&\s*loaded\s*\}\}"/.test(src('pages/goods-details/index.wxml')))
    check('wxml 有「商品加载中」状态', /商品加载中/.test(src('pages/goods-details/index.wxml')))
  }
  {
    // --- 结算按钮防抖：连点不能重复下单 ---
    let orderCreateCalls = 0
    let release = null
    const api = makeApi({
      orderCreate: () => new Promise((resolve) => {
        orderCreateCalls++
        release = () => resolve({ code: 0, data: { id: 'o1', amountReal: 468 } })
      })
    })
    const page = loadPage('pages/pay/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { login() {}, wxaCode: async () => 'c', checkHasLogined: async () => true, authorize: async () => ({}) },
        'utils/pay': { wxpay() {} },
        'shop-config$': SHOP_STUB,
        'utils/delivery$': { isDelivery: () => false, isDeliveryEnabled: () => true, setMode: () => 'pickup', DELIVERY: 'delivery' },
        'delivery-range$': { calcQuote: () => ({ freight: 0, freightText: '', deliverable: true, distanceKm: null }), checkAdvanceTime: () => ({ valid: true }), setDeliveryRule: () => ({}), getDeliveryRule: () => ({ area: { outOfAreaTip: '超出配送范围' } }) },
        'config/delivery$': { area: { outOfAreaTip: '超出配送范围' } },
        'utils/location$': { formatDistance: () => '', openNavigation: async () => {} }
      }
    })
    page.data.mobile = '13800138000'
    page.data.fetchTime = '今天 15:00'
    page.data.isDelivery = false
    page.data.shippingCarInfo = { items: [{ goodsId: 'g_cake', number: 2, sku: [] }], number: 2, price: 468 }
    page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
    page.data.cartItemsForQuote = []

    const p1 = page.createorder()          // 真正提交
    const p2 = page.createorder()          // 连点第 2 次 → 应被拦下
    const p3 = page.createorder()          // 连点第 3 次 → 应被拦下
    await p2
    await p3
    check('★ 提交中连点只发一次下单请求', orderCreateCalls === 1, orderCreateCalls)
    check('连点给出提示「正在提交，请稍候」',
      page.__toasts.filter((t) => t === '正在提交，请稍候').length === 2, page.__toasts)
    check('提交中按钮进入提交态（wxml 据此置灰换文案）', page.data.submitting === true)
    release()
    await p1
    check('提交完成后 submitting 复位', page.data.submitting === false)
    check('★ 下单成功后锁定本页入口：再点不会再生成重复订单', (() => {
      const before = orderCreateCalls
      page.createorder()
      return orderCreateCalls === before
    })())
    check('重复下单时给出明确提示',
      page.__toasts.indexOf('订单已提交，请勿重复下单') >= 0, page.__toasts)

    const payJs2 = src('pages/pay/index.js')
    check('成功分支会置 _ordered（源码保证）', /this\._ordered = true/.test(payJs2))

    const payJs = src('pages/pay/index.js')
    check('源码里 createorder 先判 _submitting 再提交', /_submitting[\s\S]{0,200}_createOrder/.test(payJs))
    check('wxml 绑定提交态文案', /submitting \? '提交中…' : '去支付'/.test(src('pages/pay/index.wxml')))
    check('wxss 定义提交中置灰样式', /\.pay-byn-disabled\s*\{/.test(src('pages/pay/index.wxss')))
  }

  // =========================================================================
  console.log('\n=== 5.6 复核整改：每个缺陷都补一条回归 ===')
  // =========================================================================
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const PAY_REQUIRES = (api, payStub) => ({
    'api-map$': api,
    'utils/auth$': { login() {}, wxaCode: async () => 'c', checkHasLogined: async () => true, authorize: async () => ({}) },
    'utils/pay': payStub || { wxpay() {} },
    'shop-config$': SHOP_STUB,
    'utils/delivery$': { isDelivery: () => false, isDeliveryEnabled: () => true, setMode: () => 'pickup', DELIVERY: 'delivery' },
    'delivery-range$': { calcQuote: () => ({ freight: 0, freightText: '', deliverable: true, distanceKm: null }), checkAdvanceTime: () => ({ valid: true }), setDeliveryRule: () => ({}), getDeliveryRule: () => ({ area: { outOfAreaTip: '超出配送范围' } }) },
    'config/delivery$': { area: { outOfAreaTip: '超出配送范围' } },
    'utils/location$': { formatDistance: () => '', openNavigation: async () => {} }
  })

  {
    // ① 结算页：购物车加载失败不能永远停在「购物车加载中…」
    let mode = 'fail'
    const api = makeApi({
      shippingCarInfo: async () => (mode === 'fail'
        ? { code: 500, msg: '云函数调用失败' }
        : { code: 0, data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 88 }], number: 1, price: 88 } })
    })
    const page = loadPage('pages/pay/index.js', { requires: PAY_REQUIRES(api) })
    await page.shippingCarInfo()
    check('★ 结算页购物车加载失败 → cartLoadError=true（不再永远"加载中"）',
      page.data.cartLoadError === true && page.data.cartLoaded === true, page.data)
    check('失败时 shippingCarInfo 为空（不会误渲染半截数据）', !page.data.shippingCarInfo)
    mode = 'ok'
    page.retryCart()
    await flush()
    check('★ 重试后恢复正常', page.data.cartLoadError === false && !!page.data.shippingCarInfo,
      { err: page.data.cartLoadError, info: !!page.data.shippingCarInfo })
    check('wxml 有重试按钮', /bindtap="retryCart"/.test(src('pages/pay/index.wxml')))
    check('wxss 定义了重试按钮样式', /\.cart-retry\s*\{/.test(src('pages/pay/index.wxss')))

    // 返回体缺 items 也不能抛 TypeError
    const badApi = makeApi({ shippingCarInfo: async () => ({ code: 0, data: {} }) })
    const page2 = loadPage('pages/pay/index.js', { requires: PAY_REQUIRES(badApi) })
    let threw = null
    try { await page2.shippingCarInfo() } catch (e) { threw = e }
    check('★ code=0 但缺 data.items 时不抛 TypeError', threw === null, threw && threw.message)
    check('缺 items 视为加载失败', page2.data.cartLoadError === true)
  }

  {
    // ② 结算页：下单金额与页面展示不一致时必须二次确认（D-01 的另一半）
    const modals = []
    let paidMoney = null
    let relaunched = null
    const api = makeApi({
      shippingCarInfo: async () => ({ code: 0, data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 88 }], number: 1, price: 88 } }),
      goodsDetailV2: async () => ({ code: 0, data: { basicInfo: { isCake: false, minPrice: 88 }, properties: [] } }),
      orderCreate: async () => ({ code: 0, data: { id: 'o1', amountReal: 234 } }),
      shippingCarInfoRemoveAll: async () => ({ code: 0 })
    })
    const page = loadPage('pages/pay/index.js', {
      requires: PAY_REQUIRES(api, { wxpay(type, money) { paidMoney = money } }),
      wx: {
        showModal(o) {
          modals.push(o)
          if (o && o.success) o.success({ confirm: true })
        },
        reLaunch(o) { relaunched = o && o.url }
      }
    })
    await page.shippingCarInfo()
    page.data.mobile = '13800138000'
    page.data.fetchTime = '今天 15:00'
    page.data.isDelivery = false
    page.data.remark = '未填写'
    page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
    await page.createorder()

    const amountModal = modals.find((m) => m.title === '金额已更新')
    check('★ 屏显 88 / 服务端 234 → 弹出金额二次确认', !!amountModal, modals.map((m) => m.title))
    check('确认框里两个金额都写清楚了',
      !!amountModal && amountModal.content.indexOf('88') >= 0 && amountModal.content.indexOf('234') >= 0,
      amountModal && amountModal.content)
    check('★ 按服务端权威金额发起支付（不是页面上的旧金额）', paidMoney === 234, paidMoney)
    check('金额不一致时不会静默扣款', paidMoney !== 88)
  }

  {
    // ②b 金额一致时仍然直接支付（不能因为加了确认就多一次打扰）
    const modals = []
    let paidMoney = null
    const api = makeApi({
      shippingCarInfo: async () => ({ code: 0, data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 88 }], number: 1, price: 88 } }),
      goodsDetailV2: async () => ({ code: 0, data: { basicInfo: { isCake: false, minPrice: 88 }, properties: [] } }),
      orderCreate: async () => ({ code: 0, data: { id: 'o1', amountReal: 88 } })
    })
    const page = loadPage('pages/pay/index.js', {
      requires: PAY_REQUIRES(api, { wxpay(type, money) { paidMoney = money } }),
      wx: { showModal(o) { modals.push(o); if (o && o.success) o.success({ confirm: true }) } }
    })
    await page.shippingCarInfo()
    page.data.mobile = '13800138000'
    page.data.fetchTime = '今天 15:00'
    page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
    page.data.cartItemsForQuote = []
    await page.createorder()
    check('金额一致时不多弹确认框', modals.length === 0, modals.map((m) => m.title))
    check('金额一致时直接按 88 支付', paidMoney === 88, paidMoney)
  }

  {
    // ②c 2026-10-14（backlog：幂等）：弱网重试必须带**同一个** clientOrderToken
    //     —— 服务端据此判重，弱网"响应丢了再点一次"不会生成第二张单。
    const tokens = []
    let attempts = 0
    const api = makeApi({
      shippingCarInfo: async () => ({ code: 0, data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 88 }], number: 1, price: 88 } }),
      goodsDetailV2: async () => ({ code: 0, data: { basicInfo: { isCake: false, minPrice: 88 }, properties: [] } }),
      orderCreate: async (d) => {
        tokens.push(d && d.clientOrderToken)
        attempts++
        // 第一次模拟弱网失败，第二次成功
        return attempts === 1 ? { code: 500, msg: '云函数调用失败' } : { code: 0, data: { id: 'o1', amountReal: 88 } }
      }
    })
    const page = loadPage('pages/pay/index.js', { requires: PAY_REQUIRES(api) })
    await page.shippingCarInfo()
    page.data.mobile = '13800138000'
    page.data.fetchTime = '今天 15:00'
    page.data.isDelivery = false
    page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
    page.data.cartItemsForQuote = []
    await page.createorder()
    await page.createorder()
    check('★ 下单失败后可以重试（不能被防抖/已下单标志锁死）', tokens.length === 2, tokens)
    check('★ 弱网重试带同一个幂等键（服务端才能判重、不出第二张单）',
      !!tokens[0] && tokens[0] === tokens[1], tokens)
    check('幂等键符合服务端规则（8–64 位 A-Za-z0-9_-）',
      /^[A-Za-z0-9_-]{8,64}$/.test(String(tokens[0])), tokens[0])
    check('结算页源码里下单请求带幂等键',
      /clientOrderToken:\s*this\.orderToken\(\)/.test(src('pages/pay/index.js')))
  }

  {
    // ②d 2026-10-14（backlog：幂等）：重放（duplicated=true）时不重复清购物车；
    //     正常首次下单仍要清（不能把原有行为改掉）。
    const mkApi = (duplicated, counter) => makeApi({
      shippingCarInfo: async () => ({ code: 0, data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 88 }], number: 1, price: 88 } }),
      goodsDetailV2: async () => ({ code: 0, data: { basicInfo: { isCake: false, minPrice: 88 }, properties: [] } }),
      orderCreate: async () => ({ code: 0, data: { id: 'o1', amountReal: 88, duplicated } }),
      shippingCarInfoRemoveAll: async () => { counter.n++; return { code: 0 } }
    })
    const prep = async (api) => {
      const page = loadPage('pages/pay/index.js', { requires: PAY_REQUIRES(api) })
      await page.shippingCarInfo()
      page.data.mobile = '13800138000'
      page.data.fetchTime = '今天 15:00'
      page.data.isDelivery = false
      page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
      page.data.cartItemsForQuote = []
      await page.createorder()
    }
    const replayCounter = { n: 0 }
    await prep(mkApi(true, replayCounter))
    check('★ 幂等重放（duplicated=true）不再清购物车（不误删顾客后来加的商品）',
      replayCounter.n === 0, replayCounter.n)
    const firstCounter = { n: 0 }
    await prep(mkApi(false, firstCounter))
    check('首次下单（duplicated=false）仍然清购物车（原行为不变）',
      firstCounter.n === 1, firstCounter.n)
  }

  {
    // ③ 商品快照拉取失败时不猜运费（避免屏显 25 元、实付 20 元）
    const api = makeApi({
      shippingCarInfo: async () => ({
        code: 0,
        data: { items: [{ goodsId: 'g1', number: 1, sku: [], price: 20 }], number: 1, price: 20 }
      }),
      // 商品详情失败 → 拿不到 isCake，蛋糕免运费规则无法判断
      goodsDetailV2: async () => ({ code: 500, msg: '云函数调用失败' })
    })
    const page = loadPage('pages/pay/index.js', { requires: PAY_REQUIRES(api) })
    await page.shippingCarInfo()
    check('★ 有商品详情没拉到 → 标记 quoteIncomplete', page.data.quoteIncomplete === true)
    page.data.isDelivery = true
    page.data.selectedAddress = { detail: '太平新城1号', province: '云南省', city: '昆明市', district: '安宁市' }
    page.recalcQuote()
    check('★ 快照不全时运费按「待确认」处理，不猜一个可能错的值',
      page.data.freight === null && page.data.freightText === '运费待确认',
      { freight: page.data.freight, text: page.data.freightText })
    check('应付先按商品金额计（服务端为权威）', page.data.payableAmount === 20, page.data.payableAmount)
  }

  {
    // ④ 「我的」页头像并发上传的回归已随「编辑资料」独立页迁移到 tests/test-profile.js
    check('头像并发上传回归已迁移到 test-profile.js（本文件不再重复）', true)
  }

  {
    // ⑤ 订单列表：前置鉴权失败也不能白屏
    const api = makeApi({ orderList: async () => ({ code: 500, msg: '云函数调用失败' }) })
    const page = loadPage('pages/current-order/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': {
          checkHasLogined: async () => false,
          authorize: async () => { throw new Error('云函数调用失败') }
        },
        'shop-config$': SHOP_STUB,
        'utils/admin$': { isShopAdmin: async () => false },
        'utils/log$': { debug() {}, warn() {}, error() {} },
        'utils/pay': { wxpay() {} }
      }
    })
    await page.onShow()
    await flush()
    await flush()
    check('★ checkHasLogined=false 且 authorize 抛错时仍会去拉列表（原来永久白屏）',
      page.data.loaded === true, { loaded: page.data.loaded, loadError: page.data.loadError })
    check('★ 鉴权失败 → 落到错误态而不是空白', page.data.loadError === true)
  }

  {
    // ⑥ 订单列表：慢的旧请求不能覆盖新 tab
    let releaseSlow = null
    const api = makeApi({
      orderList: (params) => {
        if (params.statusBatch === OS.statusBatch(OS.CURRENT_STATUS)) {
          return new Promise((res) => {
            releaseSlow = () => res({ code: 0, data: { orderList: [{ id: 'u1' }], serverNow: Date.now() } })
          })
        }
        return Promise.resolve({ code: 0, data: { orderList: [{ id: 'h1' }], serverNow: Date.now() } })
      }
    })
    const page = loadPage('pages/current-order/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB,
        'utils/admin$': { isShopAdmin: async () => false },
        'utils/log$': { debug() {}, warn() {}, error() {} },
        'utils/pay': { wxpay() {} }
      }
    })
    page.data.tabIndex = 0
    const pSlow = page.orderList()
    page.data.tabIndex = 1
    await page.orderList()
    check('新 tab 的结果已生效', page.data.orderList[0].id === 'h1')
    releaseSlow()
    await pSlow
    check('★ 慢的旧请求返回后不覆盖新 tab 的结果', page.data.orderList[0].id === 'h1', page.data.orderList)
  }

  {
    // ⑦ 订单详情：首帧要有 loading 状态（不能先闪一屏空标题）
    const api = makeApi({
      orderDetail: async () => ({
        code: 0,
        data: { orderInfo: { orderNumber: 'QH1', status: 1 }, extJson: {}, goods: [], serverNow: Date.now() }
      })
    })
    const page = loadPage('pages/order-view/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB
      }
    })
    check('★ 详情页首帧 loaded=false（模板显示"订单加载中…"）', page.data.loaded === false)
    page.data.orderId = 'o1'
    await page.orderDetail()
    check('加载完成后 loaded=true', page.data.loaded === true)
    page.retryLoad()
    check('重试时回到 loading 态（不会先渲染半截数据）', page.data.loaded === false)
    await flush()
    check('重试后再次完成', page.data.loaded === true && page.data.loadError === false)
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
