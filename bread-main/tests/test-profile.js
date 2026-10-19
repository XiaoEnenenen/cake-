/**
 * 阶段 12「用户体系与隐私合规」回归测试（2026-10-17 新增；2026-10-17 顾客反馈后扩充）
 * ---------------------------------------------------------------------------
 * 覆盖四件事：
 *
 *   1) **隐私合规**：隐私政策正文不再是"待补充"占位、应用里有勾选同意弹窗
 *      （components/privacy-popup）、首次启动/隐私接口页都挂载了它，
 *      `app.json` 打开隐私检查；后台《用户隐私保护指引》的配置步骤写进文档。
 *   2) **首次启动只弹一次**（顾客反馈第 1 条）：弹过即记 `privacyPromptedVersion`，
 *      第二次进小程序（哪怕还没点同意、已是登录状态）都不再主动弹。
 *   3) **退出登录后重新登录必须先过隐私**（顾客反馈第 2、3 条）：
 *      components/login-sheet 每次打开都把勾选框重置为未勾选，
 *      顾客必须重新勾选后才能「微信登录」；没勾选时按钮只提示、不发起登录。
 *      **2026-10-17 顾客确认不做手机号登录**：手机号一键登录（getPhoneNumber）已删除，
 *      手机号只作为订单联系方式（结算页手填 / 编辑资料保存）。
 *   4) **编辑资料**：独立页 pages/profile-edit 支持头像 / 昵称 / 手机号 / 收货地址入口；
 *      服务端 updateUser 补了字段校验（昵称 ≤20、手机号 11 位、头像不允许本地临时路径、
 *      payload 里的 _openid 等一律忽略）。
 *
 * 运行：node tests/test-profile.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const H = require('../cloudfunctions/api/handlers')
const { dispatch, handlers } = H

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

// ===== 内存数据库（与 test-cloud-api.js 同一套接口）=====
function createMockDb(seed) {
  const store = JSON.parse(JSON.stringify(seed))
  let autoId = 1000
  const nextId = () => 'id_' + ++autoId

  return {
    _store: store,
    async find(col, where = {}, opts = {}) {
      let rows = (store[col] || []).filter((r) =>
        Object.keys(where).every((k) => r[k] === where[k])
      )
      if (opts.sort) {
        rows = rows.slice().sort((a, b) => {
          const av = a[opts.field]
          const bv = b[opts.field]
          if (av === bv) return 0
          return (av > bv ? 1 : -1) * (opts.sort > 0 ? 1 : -1)
        })
      }
      return JSON.parse(JSON.stringify(rows))
    },
    async findOne(col, where) {
      const r = await this.find(col, where)
      return r[0] || null
    },
    async get(col, id) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      return r ? JSON.parse(JSON.stringify(r)) : null
    },
    async add(col, data) {
      const doc = Object.assign({ _id: nextId() }, data)
      if (!store[col]) store[col] = []
      if (store[col].some((r) => r._id === doc._id)) {
        throw new Error('duplicate key error: _id=' + doc._id)
      }
      store[col].push(doc)
      return JSON.parse(JSON.stringify(doc))
    },
    async update(col, id, data) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      if (r) Object.assign(r, data)
      return { _id: id, ...data }
    },
    async remove(col, id) {
      store[col] = (store[col] || []).filter((x) => x._id !== String(id))
      return { _id: id }
    },
    async removeWhere(col, where) {
      const before = (store[col] || []).length
      store[col] = (store[col] || []).filter(
        (r) => !Object.keys(where).every((k) => r[k] === where[k])
      )
      return { removed: before - store[col].length }
    },
    async incField(col, where, field, delta, opts) {
      const o = opts || {}
      const row = (store[col] || []).find((r) =>
        Object.keys(where).every((k) => r[k] === where[k])
      )
      if (!row) return { updated: 0 }
      const cur = Number(row[field])
      if (!Number.isFinite(cur)) return { updated: 0 }
      const next = cur + delta
      if (o.min !== undefined && next < o.min) return { updated: 0 }
      if (o.max !== undefined && next > o.max) return { updated: 0 }
      row[field] = next
      return { updated: 1 }
    }
  }
}

function seedData() {
  return {
    user: [
      {
        _id: 'u_profile',
        _openid: 'u_profile',
        nick: '小明',
        avatarUrl: 'cloud://old.png',
        mobile: '13900139000',
        sex: 0,
        birthday: ''
      }
    ],
    cart: [],
    order: []
  }
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

const QUIET_LOG = { debug() {}, warn() {}, error() {} }
const SHOP_STUB = {
  shop: {
    id: 0, name: '卿欢蛋糕', phone: '18725136710',
    openingHours: '09:00-22:00', address: '测试地址',
    latitude: 24.92, longitude: 102.58
  },
  delivery: { enabled: true, reminder: '' }
}

/** 页面沙箱（与 test-coupon.js 同一套；require 路径感知） */
function loadPage(rel, opts) {
  const o = opts || {}
  const toasts = []
  const modals = []
  const navigations = []
  const wxBase = Object.assign({
    showLoading() {}, hideLoading() {},
    showToast(t) { toasts.push(t && t.title) },
    showModal(m) {
      modals.push(m)
      if (m && typeof m.success === 'function') m.success({ confirm: true })
    },
    getStorageSync() { return '' }, setStorageSync() {},
    removeStorageSync() {},
    navigateBack() {}, navigateTo(args) { navigations.push(args && args.url) },
    setNavigationBarTitle() {},
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
  // 组件桩：页面里 this.selectComponent('#login-sheet') 用它
  inst.selectComponent = (sel) => (o.components && o.components[sel]) || null
  return inst
}

/**
 * 组件沙箱（Component() 构造器 + lifetimes.attached）。
 * 与 loadPage 同一套 require 路径感知；额外提供 __events（triggerEvent 记录）。
 */
function loadComponent(rel, opts) {
  const o = opts || {}
  const toasts = []
  const modals = []
  const events = []
  const wxBase = Object.assign({
    showLoading() {}, hideLoading() {},
    showToast(t) { toasts.push(t && t.title) },
    showModal(m) { modals.push(m) },
    getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {},
    navigateTo() {}, openPrivacyContract() {}
  }, o.wx || {})
  const wx = new Proxy(wxBase, { get(t, k) { return k in t ? t[k] : () => {} } })
  const extraReq = o.requires || {}
  const compAbs = path.join(ROOT, rel)
  const nodeRequire = createRequire(compAbs)
  let compObj = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Component: (obj) => { compObj = obj },
    getApp: () => ({ tabbarChange() {}, globalData: {} }),
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
  if (!compObj) throw new Error('Component() 没有被调用：' + rel)
  const inst = {
    data: JSON.parse(JSON.stringify(compObj.data || {})),
    setData(d, cb) {
      Object.assign(this.data, d)
      if (cb) cb()
    },
    triggerEvent(name, detail) { events.push({ name, detail }) },
    __toasts: toasts,
    __modals: modals,
    __events: events
  }
  Object.assign(inst, compObj.methods || {})
  inst.__attached = () => {
    if (compObj.lifetimes && typeof compObj.lifetimes.attached === 'function') {
      compObj.lifetimes.attached.call(inst)
    }
  }
  inst.__detached = () => {
    if (compObj.lifetimes && typeof compObj.lifetimes.detached === 'function') {
      compObj.lifetimes.detached.call(inst)
    }
  }
  return inst
}

/** 用一份可控 storage 重新加载真实的 utils/privacy.js（它直接读全局 wx） */
function loadPrivacy(store, wxExtra) {
  const wxStub = Object.assign({
    getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
    setStorageSync(k, v) { store[k] = v },
    removeStorageSync(k) { delete store[k] },
    navigateTo() {}, openPrivacyContract() {}
  }, wxExtra || {})
  global.wx = wxStub
  delete require.cache[require.resolve('../utils/privacy')]
  return require('../utils/privacy')
}

async function main() {
  // =========================================================================
  console.log('=== 1) 服务端 updateUser：字段校验 / 不越权 / 忽略多余字段 ===')
  // =========================================================================
  {
    const ctx = { db: createMockDb(seedData()), openid: 'u_profile' }
    const db = ctx.db

    let r = await dispatch('updateUser', {
      nick: '小明明', mobile: '13800138000', avatarUrl: 'cloud://a.png'
    }, ctx)
    check('★ 合法资料保存成功', r.code === 0 && r.data.base.nick === '小明明', r)
    check('  昵称/手机号/头像都写进库里',
      db._store.user[0].nick === '小明明' &&
      db._store.user[0].mobile === '13800138000' &&
      db._store.user[0].avatarUrl === 'cloud://a.png', db._store.user[0])

    r = await dispatch('updateUser', { nick: '   ' }, ctx)
    check('★ 昵称空 → 拒绝', r.code !== 0, r)
    r = await dispatch('updateUser', { nick: '一'.repeat(21) }, ctx)
    check('★ 昵称超过 20 字 → 拒绝', r.code !== 0, r)
    r = await dispatch('updateUser', { avatarUrl: 'wxfile://tmp_avatar.jpg' }, ctx)
    check('★ 头像还是本地临时路径 → 拒绝（否则顾客端裂图）', r.code !== 0, r)
    r = await dispatch('updateUser', { mobile: '12345' }, ctx)
    check('★ 手机号格式不正确 → 拒绝', r.code !== 0, r)
    r = await dispatch('updateUser', { sex: 9 }, ctx)
    check('性别参数非法 → 拒绝', r.code !== 0, r)
    r = await dispatch('updateUser', { birthday: '2020/01/01' }, ctx)
    check('生日格式非法 → 拒绝', r.code !== 0, r)
    r = await dispatch('updateUser', {}, ctx)
    check('没有任何可更新字段 → 拒绝', r.code !== 0, r)

    r = await dispatch('updateUser', { mobile: '' }, ctx)
    check('手机号传空串 = 清空（允许）', r.code === 0 && db._store.user[0].mobile === '', r)
    r = await dispatch('updateUser', { birthday: '2000-01-01' }, ctx)
    check('生日 YYYY-MM-DD → 允许', r.code === 0 && db._store.user[0].birthday === '2000-01-01')

    // 越权/多余字段：payload 里的 _openid 不能改主人，amount 等不该落库
    r = await dispatch('updateUser', {
      nick: '新名字', _openid: 'hacker', openid: 'hacker', amount: 999999, id: 'x'
    }, ctx)
    check('★ payload 里的 _openid/openid 被忽略（改不了归属）',
      r.code === 0 && db._store.user[0]._openid === 'u_profile' &&
      r.data.base.id === 'u_profile', r.data)
    check('★ 不在白名单里的字段（amount）不会写进用户资料',
      db._store.user[0].amount === undefined, db._store.user[0])

    // 没有 user 记录时自动创建
    const dbNew = createMockDb(seedData())
    r = await dispatch('updateUser', { nick: '新顾客' }, { db: dbNew, openid: 'u_new' })
    check('用户记录不存在时自动创建（_openid 由服务端注入）',
      r.code === 0 && dbNew._store.user.length === 2 &&
      dbNew._store.user[1]._openid === 'u_new' && dbNew._store.user[1].nick === '新顾客',
      dbNew._store.user)
  }

  // =========================================================================
  console.log('\n=== 2) 隐私合规：政策正文 / 弹窗组件 / 页面挂载 / 后台配置说明 ===')
  // =========================================================================
  {
    const appJson = JSON.parse(src('app.json'))
    check('★ app.json 打开隐私检查（__usePrivacyCheck__）',
      appJson.__usePrivacyCheck__ === true)
    check('★ 全局注册 privacy-popup 组件',
      (appJson.usingComponents || {})['privacy-popup'] === '/components/privacy-popup/index')
    check('★ app.json 注册了编辑资料页', (appJson.pages || []).indexOf('pages/profile-edit/index') >= 0)
    check('位置接口仍声明在 requiredPrivateInfos 里',
      (appJson.requiredPrivateInfos || []).indexOf('getLocation') >= 0 &&
      (appJson.requiredPrivateInfos || []).indexOf('chooseLocation') >= 0)

    ;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((f) => {
      check('  隐私弹窗组件文件齐全：' + f, exists('components/privacy-popup/' + f))
    })
    const popupJs = src('components/privacy-popup/index.js')
    const popupWxml = src('components/privacy-popup/index.wxml')
    check('★ 弹窗必须勾选才能同意（checkbox + disabled 按钮）',
      /toggleCheck/.test(popupWxml) && /disabled="\{\{\s*!checked\s*\}\}"/.test(popupWxml))
    check('★ 同意按钮使用官方隐私授权按钮',
      /open-type="agreePrivacyAuthorization"/.test(popupWxml) &&
      /bindagreeprivacyauthorization="onAgreeAuth"/.test(popupWxml))
    check('★ 弹窗提供《隐私政策》与《微信隐私保护指引》入口',
      /隐私政策/.test(popupWxml) && /微信隐私保护指引/.test(popupWxml) &&
      /openPolicy/.test(popupJs) && /openContractPage/.test(popupJs))
    check('★ 同意后记录本地状态（版本化）',
      /PRIVACY\.markAgreed\(\)/.test(popupJs) && /POLICY_VERSION/.test(src('utils/privacy.js')))
    check('弹窗有「暂不使用」选项（不强制登录）', /暂不使用/.test(popupWxml))

    // 2026-10-17 顾客反馈：首次启动只弹一次；登录必须重新勾选
    const privacyJs = src('utils/privacy.js')
    check('★ 隐私"已提示"状态版本化（第二次进小程序不再弹）',
      /privacyPromptedVersion/.test(privacyJs) && /hasPrompted/.test(privacyJs) &&
      /markPrompted/.test(privacyJs) && /shouldShowOnLaunch/.test(privacyJs))
    check('★ 弹窗依赖 shouldShowOnLaunch（不再每次冷启动都主动弹）',
      /PRIVACY\.shouldShowOnLaunch\(\)/.test(popupJs) && /PRIVACY\.markPrompted\(\)/.test(popupJs))
    check('★ 登录时主动请求平台级隐私授权（wx.requirePrivacyAuthorize）',
      /requirePrivacyAuthorize/.test(privacyJs) && /requestPlatformAuthorize/.test(privacyJs))
    check('★ app.json 注册登录弹层 login-sheet',
      (appJson.usingComponents || {})['login-sheet'] === '/components/login-sheet/index')
    ;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((f) => {
      check('  登录弹层组件文件齐全：' + f, exists('components/login-sheet/' + f))
    })
    check('★ 「我的」页挂载登录弹层（退出后重新登录入口）',
      /<login-sheet/.test(src('pages/my/index.wxml')) &&
      /bind:success="onLoginSuccess"/.test(src('pages/my/index.wxml')))
    check('★ 旧 bind-mobile 组件已归档（手机号登录已删除，登录只保留微信登录）',
      !exists('components/bind-mobile/index.js') &&
      (appJson.usingComponents || {})['bind-mobile'] === undefined)
    check('★ 手机号登录能力已从 API / 云函数路由删除',
      !/bindMobile\s*:/.test(src('utils/api-map.js')) &&
      !/async function bindMobile/.test(src('cloudfunctions/api/handlers.js')) &&
      require('../cloudfunctions/api/handlers').handlers.bindMobile === undefined)

    // 首次启动/隐私接口页面都挂载了弹窗
    const mountedPages = [
      'pages/index/index.wxml',
      'pages/my/index.wxml',
      'pages/profile-edit/index.wxml',
      'pages/pay/index.wxml',
      'pages/order-view/index.wxml',
      'pages/address/edit.wxml',
      'pages/shop-locator/index.wxml'
    ]
    const notMounted = mountedPages.filter((p) => src(p).indexOf('<privacy-popup') < 0)
    check('★ 首页/我的/编辑资料/结算/订单详情/地址/选点页都挂载了隐私弹窗',
      notMounted.length === 0, notMounted)

    // 隐私政策正文：不再是占位，且覆盖实际收集的信息
    const cms = require('../cloudfunctions/api/shop-config').cms
    const content = (cms && cms.agreement && cms.agreement.content) || ''
    check('★ 隐私政策不再是"内容待补充"占位',
      content.length > 500 && content.indexOf('内容待补充') < 0, content.slice(0, 60))
    check('  政策写明收集 OpenID / 手机号 / 地址 / 位置 / 订单',
      /OpenID/i.test(content) && /手机号/.test(content) && /收货地址/.test(content) &&
      /位置信息/.test(content) && /订单/.test(content))
    check('  政策包含未成年人保护与联系方式',
      /未成年人/.test(content) && /联系我们/.test(content) &&
      /18725136710/.test(content))
    check('  关于我们页的入口指向 privacy 政策页',
      /about-us\/detail\?key=agreement/.test(src('pages/about-us/index.wxml')))
    check('  我的页/关于我们页都能找到隐私政策入口',
      /关于/.test(src('pages/my/index.wxml')) &&
      src('pages/about-us/index.wxml').indexOf('隐私政策') >= 0)

    // 后台《用户隐私保护指引》配置步骤必须写在文档里（审核要求，不在代码里）
    const initDoc = src('docs/云开发初始化清单.md')
    check('★ 文档写明后台《用户隐私保护指引》怎么配',
      /用户隐私保护指引/.test(initDoc) && /服务内容声明/.test(initDoc))
    check('  文档提醒文字需与实际收集信息一致',
      /与.*实际.*一致/.test(initDoc) || /内容必须与实际一致/.test(initDoc))

    // app.js：退出登录后不自动建立登录态
    check('★ app.js 尊重本机退出登录状态（不再自动登录）',
      /loggedOut/.test(src('app.js')) && /getStorageSync\('loggedOut'\)/.test(src('app.js')))
  }

  // =========================================================================
  console.log('\n=== 3) 「我的」页：退出登录后重新登录必须先过登录弹层 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    const calls = { userDetail: 0, authorize: 0 }
    const sheet = { opened: 0, open() { this.opened++ } }
    const api = {
      userDetail: async () => {
        calls.userDetail++
        return { code: 0, data: { base: { id: 'oUSER123', nick: '小明', avatarUrl: 'cloud://a.png' } } }
      }
    }
    const auth = {
      checkHasLogined: async () => true,
      authorize: async () => { calls.authorize++; return {} }
    }
    const page = loadPage('pages/my/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': auth,
        'shop-config$': SHOP_STUB,
        'utils/address$': { getDefault: () => null, formatFull: () => '' },
        'utils/admin$': { isAdminUser: () => false, ensureAdminFlag: async () => true },
        'utils/location$': { isDevOrTrialEnv: () => false, openNavigation: async () => {} },
        'utils/log$': QUIET_LOG
      },
      components: { '#login-sheet': sheet },
      wx: {
        getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
        setStorageSync(k, v) { store[k] = v },
        removeStorageSync(k) { delete store[k] }
      }
    })
    // 本机已退出：onShow 不拉资料
    page.onShow()
    check('★ 已退出登录 → 显示登录卡片、不自动拉资料',
      page.data.loggedOut === true && page.data.userInfo === null &&
      calls.userDetail === 0, { data: page.data, calls })
    check('退出状态说明写清"订单和地址仍保留"',
      /订单/.test(src('pages/my/index.wxml')) && /保留/.test(src('pages/my/index.wxml')))

    // 顾客反馈第 2 条：退出登录后点「登录」不能静默直接登录
    page.login()
    check('★ 退出登录后点「登录」→ 打开登录弹层（不静默登录）',
      sheet.opened === 1 && calls.authorize === 0, { sheet, calls })
    check('★ 页面不再有"隐私同意后自动继续登录"的旧静默逻辑',
      typeof page.onPrivacyAgree === 'undefined' &&
      !/_pendingLogin/.test(src('pages/my/index.js')))

    // 弹层登录成功后回调本页：清 loggedOut + 重新拉资料
    page.onLoginSuccess()
    await new Promise((r) => setTimeout(r, 0))
    check('★ 弹层登录成功 → 清本机退出标志并恢复资料',
      calls.userDetail === 1 && page.data.loggedOut === false &&
      store.loggedOut === undefined, { calls, store, loggedOut: page.data.loggedOut })
    check('  微信登录是静默的，成功后给明确反馈（避免以为点了没反应）',
      page.__toasts.some((t) => /登录成功/.test(String(t))), page.__toasts)

    // 2026-10-17 顾客反馈：退出登录入口移到「编辑资料」页底部，本页不再放
    check('★ 「我的」页不再有退出登录入口/逻辑',
      typeof page.logout === 'undefined' &&
      !/bindtap="logout"/.test(src('pages/my/index.wxml')) &&
      !/logout\(\)/.test(src('pages/my/index.js')))

    // 点用户卡：已退出 → 再开登录弹层；已登录 → 进编辑资料页
    page.data.loggedOut = true
    page.onTapUserCard()
    check('已退出时点用户卡 = 打开登录弹层（仍不静默登录）',
      sheet.opened === 2 && calls.authorize === 0, { sheet, calls })
    page.data.loggedOut = false
    page.onTapUserCard()
    check('已登录时点用户卡 = 进入「编辑资料」页',
      page.__navigations.indexOf('/pages/profile-edit/index') >= 0, page.__navigations)

    // 已登录状态 onShow：正常拉资料，不触发登录弹层
    page.onShow()
    await new Promise((r) => setTimeout(r, 0))
    check('已登录状态 onShow 正常拉资料（不需要再登录）',
      calls.userDetail >= 2 && page.data.loggedOut === false, { calls, data: page.data })
  }

  // =========================================================================
  console.log('\n=== 4) 登录弹层：隐私勾选 + 微信登录（手机号登录已删除）===')
  // =========================================================================
  {
    const navs = []
    const calls = { markAgreed: 0, authorize: 0, cancelReset: 0 }
    let platformResult = { ok: true, denied: false }
    const privacyStub = {
      async requestPlatformAuthorize() { return platformResult },
      markAgreed() { calls.markAgreed++ },
      cancelResetOnNextLaunch() { calls.cancelReset++ },
      openPolicy() { navs.push('/pages/about-us/detail?key=agreement') },
      openContractPage() { navs.push('/pages/about-us/detail?key=agreement') }
    }
    const auth = { async authorize() { calls.authorize++ } }
    const sheet = loadComponent('components/login-sheet/index.js', {
      requires: {
        'utils/auth$': auth,
        'utils/privacy$': privacyStub,
        'utils/log$': QUIET_LOG
      }
    })
    const sheetJs = src('components/login-sheet/index.js')
    const wxml = src('components/login-sheet/index.wxml')
    check('★ 弹层提供隐私勾选 +《隐私政策》《微信隐私保护指引》入口',
      /toggleCheck/.test(wxml) && /《隐私政策》/.test(wxml) &&
      /《微信隐私保护指引》/.test(wxml) && /onOpenPolicy/.test(wxml))
    check('★ 只保留「微信登录」：手机号登录已按顾客要求删除',
      /微信登录/.test(wxml) &&
      !/getPhoneNumber/.test(wxml) && !/手机号一键登录/.test(wxml) &&
      !/getPhoneNumber/.test(sheetJs) && !/bindMobile/.test(sheetJs) &&
      typeof sheet.onGetPhoneNumber === 'undefined' &&
      typeof sheet.markPhoneUnavailable === 'undefined')
    check('★ 弹层说明微信登录是静默的（不弹授权框、不读昵称头像）',
      /微信不会弹授权框/.test(wxml) && /不读取昵称头像/.test(wxml))
    check('★ 弹层说明手机号不是登录方式（结算页/编辑资料里填）',
      /手机号无需登录/.test(wxml) && /结算页/.test(wxml))
    check('★ 未勾选时不渲染真正的登录按钮（先同意后登录）',
      /wx:if="\{\{ checked \}\}"/.test(wxml) && /onLoginBlocked/.test(wxml))

    sheet.open()
    check('★ 每次打开都把隐私勾选重置为未勾选（退出后重新登录必须重新同意）',
      sheet.data.show === true && sheet.data.checked === false)

    await sheet.onWechatLogin()
    check('★ 没勾选隐私政策 → 微信登录不发起',
      calls.authorize === 0 && sheet.__toasts.some((t) => /隐私政策/.test(String(t))),
      { calls, toasts: sheet.__toasts })

    // 勾选 + 平台授权通过 → 登录成功
    sheet.toggleCheck()
    await sheet.onWechatLogin()
    check('★ 勾选同意 + 微信登录成功',
      calls.authorize === 1 && calls.markAgreed === 1 &&
      sheet.__events.some((e) => e.name === 'success' && e.detail && e.detail.method === 'wechat'),
      { calls, events: sheet.__events })
    check('  登录成功取消"退出登录后下次冷启动重新弹隐私"的待办',
      calls.cancelReset === 1, calls)
    check('  登录成功后关闭弹层、复位登录中标志',
      sheet.data.show === false && sheet.data.logging === false)

    // 平台级授权被用户明确拒绝 → 不登录
    calls.authorize = 0; calls.markAgreed = 0
    platformResult = { ok: false, denied: true, errMsg: 'requirePrivacyAuthorize:fail auth deny' }
    sheet.open(); sheet.toggleCheck()
    await sheet.onWechatLogin()
    check('★ 用户在微信隐私框里拒绝 → 不登录、不记同意',
      calls.authorize === 0 && calls.markAgreed === 0 &&
      sheet.__toasts.some((t) => /隐私政策/.test(String(t))), { calls, toasts: sheet.__toasts })

    // 后台未配置隐私指引 / 旧基础库（非用户拒绝）→ 不能把登录堵死
    platformResult = { ok: false, denied: false, unsupported: true }
    calls.authorize = 0; calls.markAgreed = 0
    sheet.open(); sheet.toggleCheck()
    await sheet.onWechatLogin()
    check('  后台未配置隐私指引 / 旧基础库 → 按本地同意继续登录（不堵死登录）',
      calls.authorize === 1 && calls.markAgreed === 1, calls)

    sheet.onOpenPolicy()
    sheet.onOpenContract()
    check('  隐私政策 / 微信隐私指引入口可用', navs.length === 2, navs)
  }

  // =========================================================================
  console.log('\n=== 5) 隐私弹窗：首次启动只弹一次（顾客反馈第 1 条）===')
  // =========================================================================
  {
    // ---- utils/privacy 的状态机 ----
    const storeA = {}
    let privacy = loadPrivacy(storeA)
    check('  未同意/未提示 → 冷启动应主动弹', privacy.shouldShowOnLaunch() === true)
    privacy.markPrompted()
    check('★ 弹过一次后（即使点「暂不使用」未同意）不再反复打扰',
      privacy.shouldShowOnLaunch() === false && privacy.hasAgreed() === false)
    privacy.markAgreed()
    check('  同意后记录版本化状态', privacy.hasAgreed() === true)
    privacy.resetPrompted()
    check('  已同意时即使清掉"已提示"也不再弹（同意优先）',
      privacy.shouldShowOnLaunch() === false)

    // ---- requestPlatformAuthorize 的三种结果 ----
    let platformOk = false
    privacy = loadPrivacy({}, {
      requirePrivacyAuthorize(opts) { platformOk ? opts.success() : opts.fail({ errMsg: 'requirePrivacyAuthorize:fail auth deny' }) }
    })
    let r = await privacy.requestPlatformAuthorize()
    check('  平台隐私授权：用户拒绝 → denied=true', r.ok === false && r.denied === true, r)
    platformOk = true
    r = await privacy.requestPlatformAuthorize()
    check('  平台隐私授权：用户同意 → ok=true', r.ok === true && r.denied === false, r)
    privacy = loadPrivacy({})
    r = await privacy.requestPlatformAuthorize()
    check('  旧基础库无 requirePrivacyAuthorize → 按不支持放行', r.ok === true && r.unsupported === true, r)

    // ---- 弹窗组件：首次自动弹、只弹一次 ----
    const storeB = {}
    let platformCalls = 0
    // 2026-10-17 真机反馈：勾选同意后还要补一次"微信平台级隐私授权"
    loadPrivacy(storeB, {
      requirePrivacyAuthorize(opts) { platformCalls++; if (opts && opts.success) opts.success() }
    })
    const popup = loadComponent('components/privacy-popup/index.js', {
      wx: {
        getStorageSync(k) { return storeB[k] === undefined ? '' : storeB[k] },
        setStorageSync(k, v) { storeB[k] = v },
        removeStorageSync(k) { delete storeB[k] }
      }
    })
    popup.__attached()
    await new Promise((r2) => setTimeout(r2, 450))
    check('★ 首次启动自动弹隐私告知', popup.data.show === true && popup.data.checked === false)
    check('★ 弹出即记录"已提示"（下次冷启动不再弹）',
      storeB.privacyPromptedVersion !== undefined, storeB)
    popup.onAgreeTap()
    check('没有勾选 → 同意无效（并提示）',
      popup.data.show === true && popup.__toasts.some((t) => /隐私政策/.test(String(t))))
    popup.toggleCheck()
    popup.onAgreeTap()
    await new Promise((r3) => setTimeout(r3, 0))
    check('★ 勾选后同意 → 关闭弹窗并记同意',
      popup.data.show === false && storeB.privacyAgreedVersion !== undefined, storeB)
    check('★ 勾选同意后同时补一次微信平台级隐私授权（否则定位仍会被拦）',
      platformCalls === 1, { platformCalls })

    // 第二次进小程序：上次点了「暂不使用」（已提示但未同意）→ 不再弹
    // 2026-10-19：版本号改为动态读取 utils/privacy 的 POLICY_VERSION。
    //   原来这里硬编码 '2026-10-17'，P0-4 修正协议后版本升到 '2026-10-19'，
    //   硬编码会让「已提示/已同意」的桩失效、断言误报。
    const CUR_POLICY_VERSION = loadPrivacy({}).POLICY_VERSION
    const storeC = { privacyPromptedVersion: CUR_POLICY_VERSION }
    loadPrivacy(storeC)
    const popup2 = loadComponent('components/privacy-popup/index.js', {
      wx: {
        getStorageSync(k) { return storeC[k] === undefined ? '' : storeC[k] },
        setStorageSync(k, v) { storeC[k] = v },
        removeStorageSync(k) { delete storeC[k] }
      }
    })
    popup2.__attached()
    await new Promise((r3) => setTimeout(r3, 450))
    check('★ 第二次进小程序（已提示但未同意）→ 不再弹隐私政策',
      popup2.data.show === false && popup2.__toasts.length === 0, popup2.data)

    // 已同意过 → 冷启动不弹
    const storeD = { privacyAgreedVersion: CUR_POLICY_VERSION }
    loadPrivacy(storeD)
    const popup3 = loadComponent('components/privacy-popup/index.js', {
      wx: {
        getStorageSync(k) { return storeD[k] === undefined ? '' : storeD[k] },
        setStorageSync(k, v) { storeD[k] = v },
        removeStorageSync(k) { delete storeD[k] }
      }
    })
    popup3.__attached()
    await new Promise((r4) => setTimeout(r4, 450))
    check('★ 已同意的登录状态再进小程序 → 不弹隐私政策',
      popup3.data.show === false, popup3.data)

    delete global.wx
  }

  // =========================================================================
  console.log('\n=== 6) 编辑资料页：回填 / 校验 / 保存 / 头像并发 / 地址入口 ===')
  // =========================================================================
  {
    let modified = null
    let navigatedBack = 0
    const logoutStore = {}
    const logoutCalls = { n: 0 }
    // 2026-10-17 第二轮反馈：退出登录要登记"下次冷启动重新弹隐私政策"
    const privacyReset = { requested: 0 }
    const privacyStub = {
      requestResetOnNextLaunch() { privacyReset.requested++ }
    }
    const api = {
      userDetail: async () => ({
        code: 0,
        data: { base: { id: 'oUSER123', nick: '小明', avatarUrl: 'cloud://a.png', mobile: '13800138000' } }
      }),
      uploadFile: async () => ({ code: 0, fileID: 'cloud://up.png' }),
      modifyUserInfoV2: async (d) => { modified = d; return { code: 0, data: {} } }
    }
    const ADDR_STUB = {
      getDefault: () => ({ name: '张三', phone: '13800138000', province: '云南省', city: '昆明市', district: '安宁市', detail: '太平新城1号' }),
      formatFull: () => '云南省昆明市安宁市太平新城1号'
    }
    const page = loadPage('pages/profile-edit/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': { loginOut: () => { logoutCalls.n++ } },
        'utils/address$': ADDR_STUB,
        'utils/format$': require('../utils/format'),
        'utils/privacy$': privacyStub,
        'utils/log$': QUIET_LOG
      },
      wx: {
        navigateBack() { navigatedBack++ },
        setStorageSync(k, v) { logoutStore[k] = v }
      }
    })
    await page.onLoad()
    check('★ 编辑资料页回填当前资料（昵称/头像/手机号）',
      page.data.nick === '小明' && page.data.avatarUrl === 'cloud://a.png' &&
      page.data.mobile === '13800138000', page.data)
    page.onShow()
    check('  收货地址回填默认地址', page.data.addressText === '云南省昆明市安宁市太平新城1号')

    page.data.nick = ''
    check('昵称为空 → 拒绝', page.validate().ok === false)
    page.data.nick = '一'.repeat(21)
    check('昵称超过 20 字 → 拒绝', page.validate().ok === false)
    page.data.nick = '小明明'
    page.data.mobile = '123'
    check('★ 手机号不是 11 位 → 拒绝', page.validate().ok === false)
    page.data.mobile = '13800138000'
    page.data.avatarIsLocal = true
    check('★ 头像还没上传成功 → 拒绝保存', page.validate().ok === false)
    page.data.avatarIsLocal = false

    const v = page.validate()
    check('合法表单通过校验', v.ok === true, v.msg)
    check('  提交的是昵称/手机号/头像（不含空白草稿字段）',
      v.payload.nick === '小明明' && v.payload.mobile === '13800138000' &&
      v.payload.avatarUrl === 'cloud://a.png', v.payload)

    await page.save()
    // 保存成功后有 600ms 的"已保存"提示再返回上一页
    await new Promise((r) => setTimeout(r, 700))
    check('★ 保存调用 modifyUserInfoV2（服务端 updateUser）',
      modified && modified.nick === '小明明' && modified.mobile === '13800138000' &&
      modified.avatarUrl === 'cloud://a.png', modified)
    check('  保存后返回上一页（我的页 onShow 会刷新）', navigatedBack === 1)
    check('  保存中标志复位', page.data.saving === false)

    // 手机号可以留空（选填）
    page.data.mobile = ''
    check('手机号留空 → 允许保存（选填）', page.validate().ok === true)

    // 收货地址入口
    page.goAddress()
    check('★ 收货地址入口跳地址管理页',
      page.__navigations.indexOf('/pages/address/index') >= 0, page.__navigations)

    // ===== 退出登录（2026-10-17 反馈：入口在编辑资料页底部，不在「我的」页）=====
    const backBeforeLogout = navigatedBack
    page.logout()
    check('★ 编辑资料页底部可退出登录（AUTH.loginOut 被调用）', logoutCalls.n === 1, logoutCalls)
    check('★ 退出登录写本机 loggedOut 标志（不是删除云端资料）',
      logoutStore.loggedOut === '1', logoutStore)
    check('★ 退出登录登记"下次冷启动重新弹隐私政策"',
      privacyReset.requested === 1, privacyReset)
    check('  退出前有二次确认（误点不会直接退出）',
      page.__modals.length >= 1 && /退出/.test(String(page.__modals[0].title)), page.__modals)
    // 500ms 后返回「我的」页（它 onShow 会展示登录卡片）
    await new Promise((r) => setTimeout(r, 600))
    check('★ 退出后返回「我的」页', navigatedBack === backBeforeLogout + 1,
      { before: backBeforeLogout, after: navigatedBack })
    check('编辑资料页底部有「退出登录」入口与说明',
      /bindtap="logout"/.test(src('pages/profile-edit/index.wxml')) &&
      /订单与收货地址仍保留/.test(src('pages/profile-edit/index.wxml')))

    // 头像并发上传：先发的旧上传返回后不能覆盖后选的
    const resolvers = []
    const api2 = {
      userDetail: api.userDetail,
      uploadFile: () => new Promise((res) => resolvers.push(res)),
      modifyUserInfoV2: api.modifyUserInfoV2
    }
    const page2 = loadPage('pages/profile-edit/index.js', {
      requires: {
        'api-map$': api2,
        'utils/address$': ADDR_STUB,
        'utils/format$': require('../utils/format'),
        'utils/log$': QUIET_LOG
      }
    })
    page2.data.nick = '小明'
    const p1 = page2.onChooseAvatar({ detail: { avatarUrl: 'wxfile://a.jpg' } })
    const p2 = page2.onChooseAvatar({ detail: { avatarUrl: 'wxfile://b.png' } })
    check('两次选头像都在上传中', resolvers.length === 2, resolvers.length)
    resolvers[1]({ code: 0, fileID: 'cloud://b.png' })
    await p2
    check('后选的头像先返回 → 生效', page2.data.avatarUrl === 'cloud://b.png', page2.data.avatarUrl)
    resolvers[0]({ code: 0, fileID: 'cloud://a.jpg' })
    await p1
    check('★ 先发的旧上传返回后不覆盖最后选的头像',
      page2.data.avatarUrl === 'cloud://b.png', page2.data.avatarUrl)
    check('  上传成功后不再是"本地临时路径"状态', page2.data.avatarIsLocal === false)
  }

  // =========================================================================
  console.log('\n=== 7) 静态接线：路由 / 组件 / 不再是内联编辑 ===')
  // =========================================================================
  {
    const appJson = JSON.parse(src('app.json'))
    const requiredFiles = ['pages/profile-edit/index.js', 'pages/profile-edit/index.wxml',
      'pages/profile-edit/index.wxss', 'pages/profile-edit/index.json']
    check('编辑资料页四个文件齐全', requiredFiles.every((f) => exists(f)))
    check('编辑资料页 json 有标题', /编辑资料/.test(src('pages/profile-edit/index.json')))

    const profileWxml = src('pages/profile-edit/index.wxml')
    check('编辑资料页有头像选择、昵称、手机号、收货地址',
      /open-type="chooseAvatar"/.test(profileWxml) &&
      /type="nickname"/.test(profileWxml) &&
      /type="number"/.test(profileWxml) &&
      /goAddress/.test(profileWxml))
    check('★ 底部保存栏带 z-index（输入框不会盖住按钮，阶段 12 UI 反馈）',
      /\.pe-bottom-bar\s*\{[^}]*z-index/.test(src('pages/profile-edit/index.wxss')))

    const myJs = src('pages/my/index.js')
    const myWxml = src('pages/my/index.wxml')
    const profileEditJs = src('pages/profile-edit/index.js')
    const profileEditWxml = src('pages/profile-edit/index.wxml')
    check('★ 退出登录在「编辑资料」页（不在「我的」页）',
      /logout/.test(profileEditJs) && /bindtap="logout"/.test(profileEditWxml) &&
      /AUTH\.loginOut/.test(profileEditJs) &&
      !/bindtap="logout"/.test(myWxml) && !/logout\(\)/.test(myJs))
    check('★ 我的页有登录入口（退出后重新登录）',
      /login\(\)/.test(myJs) && /登录/.test(myWxml))
    check('★ 我的页不再内联编辑资料（统一进编辑资料页）',
      !/startEditProfile/.test(myJs) && !/saveProfile/.test(myJs) &&
      !/chooseAvatar/.test(myWxml))
    check('我的页挂载了隐私弹窗', /<privacy-popup/.test(myWxml))
    check('★ 我的页挂载登录弹层（退出后重新登录的隐私门禁入口）',
      /<login-sheet\b/.test(myWxml) &&
      (/<privacy-popup/.test(myWxml)) &&
      !/onPrivacyAgree/.test(myJs))
    check('★ 登录弹层全局注册且被真实引用（不是零使用组件）',
      (appJson.usingComponents || {})['login-sheet'] === '/components/login-sheet/index')
    // 2026-10-17 顾客反馈：不要单独的「编辑资料」列表项/文字按钮，点用户卡整行即可
    check('★ 点用户卡整行进入「编辑资料」（不再有单独入口行）',
      /onTapUserCard/.test(myWxml) && /goProfileEdit/.test(myJs) &&
      !/bindtap="goProfileEdit"/.test(myWxml) &&
      !/class="user-edit">编辑资料/.test(myWxml),
      { wxmlHasRow: /list-title">编辑资料/.test(myWxml) })
    check('  用户卡右侧保留一个指向箭头（可点的视觉提示）',
      /class="list-arrow"/.test(myWxml))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
