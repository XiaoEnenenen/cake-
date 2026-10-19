/**
 * 2026-10-17 第二轮顾客反馈：登录门禁 + 退出后重新弹隐私
 * ---------------------------------------------------------------------------
 * 顾客原话：
 *   ① “我没登录怎么还能点餐啊？”——退出登录后仍能加购、进结算、下单；
 *   ② “应该是要我退出登录后退出小程序、再次打开后弹出隐私政策”；
 *   ③ “在点餐支付前要确保登录才能进行支付”。
 *
 * 本文件覆盖：
 *   1) utils/login-gate 的状态机（isLoggedOut / requireLogin / onLoginSuccess）；
 *   2) 四个真实入口都被拦住：商品详情「加入购物车」、点单页「去结算」、
 *      结算页「去支付」、订单列表「再次支付」；
 *   3) 登录成功后自动继续刚才被拦下的动作（不用顾客再点一次）；
 *   4) 退出登录清掉本机隐私状态 → 下次冷启动 shouldShowOnLaunch 重新为 true
 *      （隐私弹窗重新出现）；重新登录时登录弹层仍强制重新勾选（tests/test-profile.js 守着）。
 *
 * 运行：node tests/test-login-gate.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

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

// ===== 真实 utils/login-gate（它直接读全局 wx）=====
const LG = require('../utils/login-gate')

/**
 * 给 Node 全局挂一个 storage 桩（login-gate / 隐私模块在 Node 里只认全局 wx）。
 * 返回同一个桩，页面沙箱也用它，保证两边看到同一份 storage。
 */
function useStore(store) {
  const stub = {
    getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
    setStorageSync(k, v) { store[k] = v },
    removeStorageSync(k) { delete store[k] },
    showToast() {},
    showModal() {}
  }
  global.wx = stub
  return stub
}

/** 页面沙箱（与 test-profile.js / test-coupon.js 同一套，额外支持 selectComponent） */
function loadPage(rel, opts) {
  const o = opts || {}
  const toasts = []
  const modals = []
  const navigations = []
  const store = o.store || {}
  const wxBase = Object.assign({
    showLoading() {}, hideLoading() {},
    showToast(t) { toasts.push(t && t.title) },
    showModal(m) { modals.push(m) },
    getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
    setStorageSync(k, v) { store[k] = v },
    removeStorageSync(k) { delete store[k] },
    navigateBack() {}, navigateTo(args) { navigations.push(args && args.url) },
    reLaunch() {}, setNavigationBarTitle() {},
    makePhoneCall() {}, stopPullDownRefresh() {}, setClipboardData() {},
    previewImage() {}, chooseMedia() {}, chooseImage() {}
  }, o.wx || {})
  const wx = new Proxy(wxBase, { get(t, k) { return k in t ? t[k] : () => {} } })
  const extraReq = o.requires || {}
  const pageAbs = path.join(ROOT, rel)
  const nodeRequire = createRequire(pageAbs)
  let pageObj = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Page: (obj) => { pageObj = obj },
    getApp: () => ({ tabbarChange() {}, globalData: {} }),
    getCurrentPages: () => [],
    require: (p) => {
      if (!/^\./.test(p)) return {}
      const resolved = nodeRequire.resolve(p).replace(/\.js$/, '').replace(/\\/g, '/')
      for (const key of Object.keys(extraReq)) {
        if (new RegExp(key).test(resolved)) return extraReq[key]
      }
      return nodeRequire(p)
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
  inst.__modals = modals
  inst.__navigations = navigations
  inst.selectComponent = (sel) => (o.components && o.components[sel]) || null
  return inst
}

const SHOP_STUB = {
  shop: {
    id: 0, name: '卿欢蛋糕', phone: '18725136710',
    openingHours: '09:00-22:00', address: '测试地址',
    latitude: 24.92, longitude: 102.58
  },
  delivery: { enabled: true, reminder: '' }
}
const DELIVERY_STUB = {
  PICKUP: 'pickup',
  DELIVERY: 'delivery',
  getMode: () => 'pickup',
  isDelivery: () => false,
  isDeliveryEnabled: () => true,
  setMode() {}
}
function makeSheet() {
  return { opened: 0, open() { this.opened++ } }
}

async function main() {
  // =========================================================================
  console.log('=== 1) utils/login-gate：状态机 ===')
  // =========================================================================
  {
    const store = {}
    useStore(store)
    check('没写过 loggedOut → 视为已登录（首次用户走静默 openid）', LG.isLoggedOut() === false)

    let ran = 0
    const p1 = { selectComponent: () => null }
    check('已登录：requireLogin 直接执行动作',
      LG.requireLogin(p1, () => { ran++ }) === true && ran === 1)

    store.loggedOut = '1'
    check('loggedOut=1 → 视为未登录', LG.isLoggedOut() === true)
    const sheet = makeSheet()
    const p2 = { selectComponent: (sel) => (sel === '#login-sheet' ? sheet : null) }
    let ran2 = 0
    check('★ 未登录：弹登录层、不执行动作',
      LG.requireLogin(p2, () => { ran2++ }) === false &&
      sheet.opened === 1 && ran2 === 0, { sheet, ran2 })
    check('  被拦下的动作已挂在页面上，登录成功后可继续',
      typeof p2._pendingAfterLogin === 'function')

    LG.onLoginSuccess(p2)
    check('★ 登录成功：清 loggedOut 并自动继续被拦动作',
      store.loggedOut === undefined && ran2 === 1, { store, ran2 })

    let fallback = 0
    LG.onLoginSuccess({}, () => { fallback++ })
    check('  没有待继续动作 → 执行刷新兜底', fallback === 1)

    store.loggedOut = '1'
    useStore(store)
    const p3 = { selectComponent: () => null }
    let ran3 = 0
    check('★ 登录组件没挂上 → 不放行（明确提示而不是静默继续）',
      LG.requireLogin(p3, () => { ran3++ }) === false && ran3 === 0)
    delete store.loggedOut
  }

  // =========================================================================
  console.log('\n=== 2) 点单页「去结算」：退出登录后必须重新登录 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    useStore(store)
    const sheet = makeSheet()
    const page = loadPage('pages/orders/index.js', {
      store,
      components: { '#login-sheet': sheet },
      requires: {
        'api-map$': {
          __isCloudMode: () => true,
          __dataSource: () => 'cloud',
          shippingCarInfo: async () => ({ code: 0, data: { number: 0, price: 0, items: [] } })
        },
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'utils/delivery$': DELIVERY_STUB,
        'shop-config$': SHOP_STUB
      }
    })
    page.data.cartCount = 1
    page.onCheckout()
    check('★ 退出登录后「去结算」被拦住（弹登录层、不跳结算页）',
      sheet.opened === 1 && page.__navigations.length === 0,
      { opened: sheet.opened, navs: page.__navigations })
    check('  被拦下的「去结算」已记录', typeof page._pendingAfterLogin === 'function')

    page.onLoginSuccess()
    check('★ 登录成功后自动继续去结算',
      page.__navigations.indexOf('/pages/pay/index') >= 0 && store.loggedOut === undefined,
      { navs: page.__navigations, store })

    page.data.cartCount = 1
    page.__navigations.length = 0
    page.onCheckout()
    check('已登录 → 直接去结算（门禁不误伤正常用户）',
      page.__navigations.indexOf('/pages/pay/index') >= 0, page.__navigations)
  }

  // =========================================================================
  console.log('\n=== 3) 商品详情「加入购物车」：退出登录后必须重新登录 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    useStore(store)
    const sheet = makeSheet()
    const calls = { add: 0, auth: 0 }
    const page = loadPage('pages/goods-details/index.js', {
      store,
      components: { '#login-sheet': sheet },
      requires: {
        'api-map$': {
          shippingCarInfoAddItemV2: async () => { calls.add++; return { code: 0, data: {} } },
          shippingCarInfo: async () => ({ code: 0, data: { items: [] } })
        },
        'utils/auth$': {
          checkHasLogined: async () => { calls.auth++; return true },
          authorize: async () => ({})
        }
      }
    })
    page.data.goodsDetail = { basicInfo: { id: 'g1', minBuyNumber: 1 }, properties: [] }
    await page.addCart()
    check('★ 退出登录后「加入购物车」被拦住（不调服务端）',
      sheet.opened === 1 && calls.add === 0 && calls.auth === 0, { sheet, calls })

    page.onLoginSuccess()
    await new Promise((r) => setTimeout(r, 0))
    check('★ 登录成功后自动继续加购',
      calls.auth === 1 && calls.add === 1, calls)
  }

  // =========================================================================
  console.log('\n=== 4) 结算页「去支付」：退出登录后必须重新登录 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    useStore(store)
    const sheet = makeSheet()
    let createCalls = 0
    const page = loadPage('pages/pay/index.js', {
      store,
      components: { '#login-sheet': sheet },
      requires: {
        'api-map$': {
          userDetail: async () => ({ code: 0, data: { base: {} } }),
          shippingCarInfo: async () => ({ code: 0, data: { items: [] } })
        },
        'utils/auth$': {
          login() {}, wxaCode: async () => 'code',
          checkHasLogined: async () => true, authorize: async () => ({})
        },
        'utils/pay$': { wxpay() {} },
        // 2026-10-19（上线清单 P0-4）：结算页新增隐私同意门禁。
        // 本节只验证登录门禁，统一按"已同意隐私政策"处理（真实 privacy.hasAgreed()
        // 会读空 storage 返回 false，导致 createorder 先被隐私门禁拦住，原断言失效）。
        'utils/privacy$': {
          hasAgreed: () => true,
          ensureAgreed: async () => true,
          markAgreed() {},
          requestPlatformAuthorize: async () => ({ ok: true })
        },
        'shop-config$': SHOP_STUB,
        'utils/delivery$': DELIVERY_STUB,
        'utils/address$': {
          formatFull: () => '', getById: () => null, getDefault: () => null,
          isValidPhone: () => true
        },
        'utils/delivery-range$': {
          calcQuote: () => ({}), setDeliveryRule() {},
          getDeliveryRule: () => ({ area: {} }), checkAdvanceTime: () => ({ valid: true })
        },
        'utils/location$': { formatDistance: () => '' }
      }
    })
    // 只验证门禁：真正下单逻辑用桩替换（否则要构造整页购物车/地址数据）
    page._createOrder = async () => { createCalls++ }
    await page.createorder()
    check('★ 退出登录后「去支付」被拦住（不进入下单流程）',
      sheet.opened === 1 && createCalls === 0, { sheet, createCalls })

    page.onLoginSuccess()
    await new Promise((r) => setTimeout(r, 0))
    check('★ 登录成功后自动继续去支付',
      createCalls === 1 && store.loggedOut === undefined, { createCalls, store })
  }

  // =========================================================================
  console.log('\n=== 5) 订单列表「再次支付」：退出登录后必须重新登录 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    useStore(store)
    const sheet = makeSheet()
    const calls = { pay: 0 }
    const page = loadPage('pages/current-order/index.js', {
      store,
      components: { '#login-sheet': sheet },
      requires: {
        'api-map$': {},
        'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
        'shop-config$': SHOP_STUB,
        'utils/admin$': {
          isShopAdmin: async () => false,
          isAdminUser: () => false,
          ensureAdminFlag: async () => true,
          canFinishOrder: () => false
        },
        'utils/pay$': { wxpay() { calls.pay++ } }
      }
    })
    const ev = { currentTarget: { dataset: { id: 'o1', money: 10 } } }
    page.toPayTap(ev)
    check('★ 退出登录后「再次支付」被拦住（不弹支付确认）',
      sheet.opened === 1 && page.__modals.length === 0 && calls.pay === 0,
      { sheet, modals: page.__modals.length, calls })

    page.onLoginSuccess()
    check('★ 登录成功后自动继续支付确认',
      page.__modals.length === 1 && /支付/.test(String(page.__modals[0].title)),
      page.__modals)
  }

  // =========================================================================
  console.log('\n=== 6) 退出登录 → 下次打开小程序重新弹隐私政策 ===')
  // =========================================================================
  {
    const store = {}
    useStore(store)
    delete require.cache[require.resolve('../utils/privacy')]
    const privacy = require('../utils/privacy')
    privacy.markAgreed()
    privacy.markPrompted()
    check('  已同意且已有登录态：冷启动不弹（顾客第一轮反馈的修复）',
      privacy.shouldShowOnLaunch() === false)

    // 退出登录：只写"下次冷启动重新告知"的标记，不在当前会话立刻清（避免退出后马上又弹）
    privacy.requestResetOnNextLaunch()
    check('★ 退出登录当次会话不立刻弹（只登记标记）',
      privacy.shouldShowOnLaunch() === false)

    // 下次冷启动：app.js onLaunch 消费标记 → 清同意/已提示 → 隐私弹窗重新出现
    const hit = privacy.consumeResetOnNextLaunch()
    check('★ 下次打开小程序重新弹隐私政策（顾客第二轮反馈：退出后重开要弹）',
      hit === true && privacy.shouldShowOnLaunch() === true && privacy.hasAgreed() === false,
      { hit, store })
    check('  标记只消费一次（已清状态，下次冷启动按"未同意"正常弹）',
      privacy.consumeResetOnNextLaunch() === false && privacy.shouldShowOnLaunch() === true)

    // 退出后又马上登录：登录弹层取消标记 → 下次冷启动不该再弹
    privacy.markAgreed()
    privacy.markPrompted()
    privacy.requestResetOnNextLaunch()
    privacy.cancelResetOnNextLaunch()
    check('★ 退出后马上重新登录 → 下次冷启动不再弹隐私',
      privacy.consumeResetOnNextLaunch() === false && privacy.shouldShowOnLaunch() === false)
  }

  // =========================================================================
  console.log('\n=== 7) 静态接线：四个入口都挂了登录弹层 / 都有门禁 ===')
  // =========================================================================
  {
    const pages = [
      { name: '点单页', js: 'pages/orders/index.js', wxml: 'pages/orders/index.wxml' },
      { name: '商品详情', js: 'pages/goods-details/index.js', wxml: 'pages/goods-details/index.wxml' },
      { name: '结算页', js: 'pages/pay/index.js', wxml: 'pages/pay/index.wxml' },
      { name: '订单列表', js: 'pages/current-order/index.js', wxml: 'pages/current-order/index.wxml' }
    ]
    pages.forEach((p) => {
      const js = src(p.js)
      const wxml = src(p.wxml)
      check('★ ' + p.name + ' 挂了登录弹层（隐私勾选 + 微信登录）',
        /<login-sheet\b/.test(wxml) && /bind:success="onLoginSuccess"/.test(wxml) &&
        /LOGIN_GATE\.isLoggedOut\(\)/.test(js) &&
        /LOGIN_GATE\.requireLogin\(this,/.test(js) &&
        /onLoginSuccess/.test(js))
    })
    check('★ 退出登录登记"下次冷启动重新告知"标记，由 app.js 冷启动消费',
      /PRIVACY\.requestResetOnNextLaunch\(\)/.test(src('pages/profile-edit/index.js')) &&
      /PRIVACY\.consumeResetOnNextLaunch\(\)/.test(src('app.js')))
    check('★ 重新登录成功会取消"下次冷启动重新弹隐私"的待办',
      /PRIVACY\.cancelResetOnNextLaunch\(\)/.test(src('components/login-sheet/index.js')))
    check('登录门禁模块被 app.json 之外的代码真实使用（不是死代码）',
      ['pages/orders/index.js', 'pages/goods-details/index.js', 'pages/pay/index.js',
        'pages/current-order/index.js'].every((f) => /utils\/login-gate/.test(src(f))))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1

  delete global.wx
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
