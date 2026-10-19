/**
 * P0-4 隐私同意门禁回归测试（2026-10-19，上线清单 P0-4）
 * ---------------------------------------------------------------------------
 * 缺陷：结算页只校验手机号，**未同意隐私政策也能下单** —— 等于在未取得用户同意
 * 的情况下收集手机号、收货地址等个人信息（微信小程序隐私合规硬要求）。
 *
 * 本文件守两件事：
 *   1) utils/privacy.ensureAgreed(options) 的行为约定（fail-closed）：
 *        · 已同意 → 直接 true，不弹窗；
 *        · 未同意 + 顾客点「同意并继续」→ 记录本机同意并 true；
 *        · 未同意 + 顾客点「暂不同意」/关闭 → false，且不记录同意；
 *        · 确认后微信平台级授权被**明确拒绝**（denied）→ false，并撤掉本地同意；
 *        · showModal 调用失败 → false（不 fail-open）。
 *   2) 结算页 createorder() 的门禁接线：
 *        · 未同意 → 不调用 orderCreate，toast 含「隐私」；
 *        · 同意 / 已同意 → 继续原下单流程（orderCreate 被调用、成功后发起支付）；
 *        · 门禁位置在登录门禁之后、_submitting 防抖判断之前（不破坏"连点只发一次"）。
 *
 * 运行：node tests/test-privacy-gate.js
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

// ===== 真实 utils/privacy（它只认全局 wx；本文件的 wx 桩在用例里逐个替换）=====
const PRIVACY = require('../utils/privacy')
const POLICY_VERSION = PRIVACY.POLICY_VERSION

/**
 * 全局 wx 桩（驱动真实 utils/privacy）：
 * @param {object} o
 *   o.store   本机 storage（同一对象跨用例复用可观测"是否已记录同意"）
 *   o.modal   'confirm' | 'cancel' | 'fail'    wx.showModal 的用户行为
 *   o.platform 'ok' | 'denied'                 wx.requirePrivacyAuthorize 的结果
 */
function makeWx(o) {
  const opts = o || {}
  const store = opts.store || {}
  const state = { modals: [], authCalls: 0 }
  const wx = {
    getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
    setStorageSync(k, v) { store[k] = v },
    removeStorageSync(k) { delete store[k] },
    showToast() {},
    showModal(m) {
      state.modals.push(m)
      if (opts.modal === 'confirm') {
        if (m && typeof m.success === 'function') m.success({ confirm: true, cancel: false })
      } else if (opts.modal === 'cancel') {
        if (m && typeof m.success === 'function') m.success({ confirm: false, cancel: true })
      } else if (opts.modal === 'fail') {
        if (m && typeof m.fail === 'function') m.fail({ errMsg: 'showModal:fail' })
      }
    },
    requirePrivacyAuthorize(req) {
      state.authCalls++
      if (opts.platform === 'denied') {
        if (req && typeof req.fail === 'function') req.fail({ errMsg: 'requirePrivacyAuthorize:fail user deny' })
      } else if (req && typeof req.success === 'function') {
        req.success()
      }
    }
  }
  return { wx, store, state }
}

// ===== 结算页沙箱（参考 test-coupon.js / test-stage5-page.js 的 loadPage 写法）=====
const QUIET_LOG = { debug() {}, warn() {}, error() {} }
const SHOP_STUB = {
  shop: { id: 0, name: '卿欢蛋糕', phone: '18725136710', openingHours: '09:00-22:00' },
  delivery: { enabled: true, reminder: '' }
}
const LOGIN_GATE_STUB = {
  isLoggedOut: () => false,
  requireLogin: (page, action) => {
    if (typeof action === 'function') action()
    return true
  },
  onLoginSuccess: () => {}
}

/**
 * 加载真实 pages/pay/index.js（路径感知 require：写错 require 路径会直接抛错）。
 * @param {object} o { hasAgreed, ensureAgreed }  → utils/privacy 桩的返回值
 */
function loadPayPage(o) {
  const opts = o || {}
  const toasts = []
  const modals = []
  const calls = { orderCreate: 0, removeAll: 0, pay: 0, ensureAgreed: 0, hasAgreed: 0 }
  let orderPayload = null

  const api = {
    __isCloudMode: () => true,
    __dataSource: () => 'cloud',
    shippingCarInfo: async () => ({ code: 0, data: { items: [], number: 0, price: 0 } }),
    goodsDetailV2: async () => ({ code: 0, data: { basicInfo: {}, properties: [] } }),
    userDetail: async () => ({ code: 0, data: { base: {} } }),
    orderCreate: async (p) => {
      calls.orderCreate++
      orderPayload = p
      return { code: 0, data: { id: 'o1', amountReal: 10, duplicated: false } }
    },
    shippingCarInfoRemoveAll: async () => { calls.removeAll++; return { code: 0 } },
    couponsAvailable: async () => ({ code: 0, data: { coupons: [] } }),
    couponUsableForCart: async () => ({ code: 0, data: { coupons: [], bestCouponId: '' } })
  }
  const privacyStub = {
    hasAgreed: () => { calls.hasAgreed++; return opts.hasAgreed === true },
    ensureAgreed: async () => { calls.ensureAgreed++; return opts.ensureAgreed === true },
    markAgreed() {},
    requestPlatformAuthorize: async () => ({ ok: true })
  }

  const wxBase = {
    showLoading() {}, hideLoading() {},
    showToast(t) { toasts.push(t && t.title) },
    showModal(m) {
      modals.push(m)
      if (m && typeof m.success === 'function') m.success({ confirm: true })
    },
    getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {},
    navigateBack() {}, navigateTo() {}, reLaunch() {},
    setNavigationBarTitle() {}, makePhoneCall() {}
  }
  const wx = new Proxy(wxBase, { get(t, k) { return k in t ? t[k] : () => {} } })

  const extraReq = {
    'api-map$': api,
    'utils/auth$': { login() {}, wxaCode: async () => 'c', checkHasLogined: async () => true, authorize: async () => ({}) },
    'utils/pay$': { wxpay() { calls.pay++ } },
    'shop-config$': SHOP_STUB,
    'utils/delivery$': {
      PICKUP: 'pickup', DELIVERY: 'delivery', getMode: () => 'pickup',
      isDelivery: () => false, isDeliveryEnabled: () => true, setMode() {}
    },
    'utils/address$': {
      formatFull: () => '', getById: () => null, getDefault: () => null,
      isValidPhone: (v) => /^1\d{10}$/.test(String(v || ''))
    },
    'utils/delivery-range$': {
      calcQuote: () => ({ freight: 0, freightText: '', deliverable: true, distanceKm: null }),
      checkAdvanceTime: () => ({ valid: true }),
      setDeliveryRule: () => ({}),
      getDeliveryRule: () => ({ area: { outOfAreaTip: '超出配送范围' } })
    },
    'utils/location$': { formatDistance: () => '', openNavigation: async () => {} },
    'utils/login-gate$': LOGIN_GATE_STUB,
    'utils/privacy$': privacyStub,
    'utils/log$': QUIET_LOG
  }

  const pageAbs = path.join(ROOT, 'pages/pay/index.js')
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
  vm.runInNewContext(src('pages/pay/index.js'), vm.createContext(sandbox), { filename: 'pages/pay/index.js' })
  if (!pageObj) throw new Error('Page() 没有被调用：pages/pay/index.js')
  const inst = Object.create(pageObj)
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (d, cb) {
    Object.assign(this.data, d)
    if (cb) cb()
  }
  inst.__toasts = toasts
  inst.__modals = modals
  return { page: inst, calls, toasts, modals, getOrderPayload: () => orderPayload }
}

/** 「结算页已加载完、只差点提交」的最小可下单状态（照抄 test-stage5-page.js 成功下单用例前置） */
function prepPayable(page) {
  page.data.cartLoaded = true
  page.data.cartEmpty = false
  page.data.cartLoadError = false
  page.data.shippingCarInfo = { items: [{ goodsId: 'g_plain', number: 1, sku: [] }], price: 10, number: 1 }
  page.data.cartItemsForQuote = []
  page.data.goodsAmount = 10
  page.data.packingFee = 0
  page.data.goodsAmount = 10
  page.data.isDelivery = false
  page.data.quote = { deliverable: true, distanceKm: 1, freight: 0, freightText: '免配送费' }
  page.data.pickupTotal = 10
  page.data.payableAmount = 10
  page.data.mobile = '13800138000'
  page.data.fetchTime = '今天 15:00'
  page.data.remark = '未填写'
  page.data.shopInfo = { id: 0, name: '卿欢蛋糕' }
  return page
}

/** 剥掉 JS 注释（源码守卫用：注释里会解释"原来怎么写"） */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

async function main() {
  // =========================================================================
  console.log('=== 1) utils/privacy.ensureAgreed：已同意 → 直接 true，不弹窗 ===')
  // =========================================================================
  {
    const { wx, store, state } = makeWx({
      store: { privacyAgreedVersion: POLICY_VERSION },
      modal: 'confirm'
    })
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('已同意当前版本 → 返回 true', ok === true)
    check('★ 已同意不重复弹窗（不打扰顾客）', state.modals.length === 0, state.modals.length)
    check('已同意时不去请求平台授权', state.authCalls === 0, state.authCalls)
    check('ensureAgreed 已从模块导出', typeof PRIVACY.ensureAgreed === 'function')
    check('原有导出与行为保留（hasAgreed/markAgreed/resetAgreed/openPolicy…）',
      typeof PRIVACY.hasAgreed === 'function' &&
      typeof PRIVACY.markAgreed === 'function' &&
      typeof PRIVACY.resetAgreed === 'function' &&
      typeof PRIVACY.requestPlatformAuthorize === 'function' &&
      typeof PRIVACY.shouldShowOnLaunch === 'function' &&
      typeof PRIVACY.openPolicy === 'function' &&
      typeof PRIVACY.openContractPage === 'function')
  }

  // =========================================================================
  console.log('\n=== 2) 未同意 + 顾客点「同意并继续」→ true 且记录同意 ===')
  // =========================================================================
  {
    const { wx, store, state } = makeWx({ store: {}, modal: 'confirm', platform: 'ok' })
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('★ 未同意 + 确认 → 返回 true', ok === true)
    check('★ 顾客确认后本机已记录同意', PRIVACY.hasAgreed() === true &&
      store.privacyAgreedVersion === POLICY_VERSION, store)
    check('弹了且只弹了一次自定义说明', state.modals.length === 1, state.modals.length)
    check('弹窗标题是「隐私政策」', state.modals[0] && state.modals[0].title === '隐私政策',
      state.modals[0] && state.modals[0].title)
    check('按钮文案：同意并继续 / 暂不同意',
      state.modals[0] && state.modals[0].confirmText === '同意并继续' &&
      state.modals[0].cancelText === '暂不同意',
      state.modals[0] && { c: state.modals[0].confirmText, x: state.modals[0].cancelText })
    check('弹窗正文说明了"下单前需同意隐私政策"',
      state.modals[0] && /隐私政策/.test(String(state.modals[0].content)) &&
      /下单/.test(String(state.modals[0].content)),
      state.modals[0] && state.modals[0].content)
    check('确认后补了一次微信平台级授权', state.authCalls === 1, state.authCalls)
  }

  // =========================================================================
  console.log('\n=== 3) 未同意 + 顾客点「暂不同意」/ 关闭 → false 且不记录同意 ===')
  // =========================================================================
  {
    const { wx, store, state } = makeWx({ store: {}, modal: 'cancel', platform: 'ok' })
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('★ 取消 → 返回 false（不得放行下单）', ok === false)
    check('★ 取消后没有记录同意', PRIVACY.hasAgreed() === false &&
      store.privacyAgreedVersion === undefined, store)
    check('取消后不去请求平台授权', state.authCalls === 0, state.authCalls)
  }

  // =========================================================================
  console.log('\n=== 4) 确认后平台级授权被明确拒绝（denied）→ false ===')
  // =========================================================================
  {
    const { wx, store, state } = makeWx({ store: {}, modal: 'confirm', platform: 'denied' })
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('★ 平台明确拒绝 → 返回 false（本次不放行）', ok === false)
    check('★ 被平台拒绝后撤掉本地同意（下次仍会重新征得同意）',
      PRIVACY.hasAgreed() === false && store.privacyAgreedVersion === undefined, store)
    check('确实发起了平台授权请求', state.authCalls === 1, state.authCalls)
  }

  // =========================================================================
  console.log('\n=== 5) 弹窗失败 / 旧基础库：fail-closed 不静默放行 ===')
  // =========================================================================
  {
    const { wx } = makeWx({ store: {}, modal: 'fail', platform: 'ok' })
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('showModal 调用失败 → false（不 fail-open）', ok === false)
  }
  {
    // 旧基础库没有 requirePrivacyAuthorize：按"平台能力不可用"放行（本地已记同意），
    // 与 requestPlatformAuthorize 既有约定一致 —— 不能因为平台能力缺失就把顾客堵死。
    const { wx } = makeWx({ store: {}, modal: 'confirm' })
    delete wx.requirePrivacyAuthorize
    global.wx = wx
    const ok = await PRIVACY.ensureAgreed()
    check('旧基础库无平台授权接口 → 顾客确认后放行', ok === true && PRIVACY.hasAgreed() === true)
  }

  // =========================================================================
  console.log('\n=== 6) 结算页 createorder：未同意 → 不调用 orderCreate 且提示含「隐私」===')
  // =========================================================================
  {
    const { page, calls, toasts } = loadPayPage({ hasAgreed: false, ensureAgreed: false })
    prepPayable(page)
    await page.createorder()
    check('★ 未同意隐私政策 → 不调用 orderCreate（不产生订单）',
      calls.orderCreate === 0, calls)
    check('★ 提示文案包含「隐私」', toasts.some((t) => /隐私/.test(String(t))), toasts)
    check('未同意时没有进入提交态（submitting 不残留）', page.data.submitting === false)
    check('门禁确实调用了 ensureAgreed（不是直接放行）', calls.ensureAgreed === 1, calls)
    check('未同意时也没有清购物车', calls.removeAll === 0, calls)
  }

  // =========================================================================
  console.log('\n=== 7) 结算页 createorder：同意后能走到 orderCreate（原流程不被破坏）===')
  // =========================================================================
  {
    const { page, calls, toasts, getOrderPayload } = loadPayPage({ hasAgreed: false, ensureAgreed: true })
    prepPayable(page)
    await page.createorder()
    check('★ 门禁同意后继续原下单流程 → orderCreate 被调用一次', calls.orderCreate === 1, calls)
    check('下单载荷仍带幂等键/渠道（原逻辑不变）',
      !!getOrderPayload() && !!getOrderPayload().clientOrderToken &&
      getOrderPayload().deliveryMode === 'pickup', getOrderPayload() && {
        token: !!getOrderPayload().clientOrderToken,
        mode: getOrderPayload().deliveryMode
      })
    check('下单成功后照常发起支付', calls.pay === 1, calls)
    check('同意后不再出现"需同意隐私政策"的拦截提示',
      !toasts.some((t) => /需同意隐私政策/.test(String(t))), toasts)
    check('提交完成后 submitting 复位', page.data.submitting === false)
  }
  {
    // 已同意（hasAgreed=true）：不进入 await 分支，直接走原流程 —— 保证"连点只发一次"时序不变
    const { page, calls } = loadPayPage({ hasAgreed: true })
    prepPayable(page)
    await page.createorder()
    check('★ 已同意 → 不调用 ensureAgreed（不额外弹窗）', calls.ensureAgreed === 0, calls)
    check('已同意 → 直接下单成功', calls.orderCreate === 1 && calls.pay === 1, calls)
  }

  // =========================================================================
  console.log('\n=== 8) 静态接线：门禁位置 / require 路径 / 文案 ===')
  // =========================================================================
  {
    const payJs = src('pages/pay/index.js')
    const code = stripComments(payJs)
    check('★ 结算页顶部 require 了 utils/privacy（路径正确）',
      /const PRIVACY = require\('\.\.\/\.\.\/utils\/privacy'\)/.test(code))
    check('★ createorder 里调用了 PRIVACY.ensureAgreed()', /PRIVACY\.ensureAgreed\(\)/.test(code))
    check('门禁先看 hasAgreed（已同意不弹窗）',
      /PRIVACY\.hasAgreed\(\)[\s\S]{0,120}PRIVACY\.ensureAgreed\(\)/.test(code))
    check('未同意时 toast 含「隐私」并 return',
      /需同意隐私政策后才能下单/.test(code))

    // 位置：登录门禁之后、_submitting 防抖判断之前（与登录门禁同级）
    const start = code.indexOf('async createorder()')
    const body = start >= 0 ? code.slice(start) : ''
    const loginIdx = body.indexOf('LOGIN_GATE.isLoggedOut()')
    const privacyIdx = body.indexOf('PRIVACY.ensureAgreed()')
    const submittingIdx = body.indexOf('if (this._submitting)')
    check('★ 门禁在登录门禁之后', loginIdx >= 0 && privacyIdx > loginIdx,
      { loginIdx, privacyIdx })
    check('★ 门禁在 _submitting 防抖判断之前（连点只发一次逻辑不被破坏）',
      privacyIdx >= 0 && submittingIdx > privacyIdx, { privacyIdx, submittingIdx })
    check('门禁使用 await（ensureAgreed 是 Promise<boolean>）',
      /const ok = await PRIVACY\.ensureAgreed\(\)/.test(body))
  }
  {
    // 隐私协议正文文案：由 Lead 负责写入 cloudfunctions/api/shop-config.js（P0-4 配套文案）
    const agreement = src('cloudfunctions/api/shop-config.js')
    check('★ 隐私协议正文包含「仅保存在你的手机本地」文案（由 Lead 补充）',
      /仅保存在你的手机本地/.test(agreement))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
  delete global.wx
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
  delete global.wx
})
