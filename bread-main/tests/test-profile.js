/**
 * 阶段 12「用户体系与隐私合规」回归测试（2026-10-17 新增）
 * ---------------------------------------------------------------------------
 * 覆盖三件事：
 *
 *   1) **隐私合规**：隐私政策正文不再是"待补充"占位、应用里有勾选同意弹窗
 *      （components/privacy-popup）、首次启动/隐私接口页都挂载了它，
 *      `app.json` 打开隐私检查；后台《用户隐私保护指引》的配置步骤写进文档。
 *   2) **退出登录**：只清本机展示（storage.loggedOut），不删除订单/地址；
 *      退出后「我的」页显示登录卡片、不再自动拉资料；点登录恢复。
 *   3) **编辑资料**：独立页 pages/profile-edit 支持头像 / 昵称 / 手机号 / 收货地址入口；
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
  return inst
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
  console.log('\n=== 3) 「我的」页：退出登录 / 重新登录 / 隐私门禁 ===')
  // =========================================================================
  {
    const store = { loggedOut: '1' }
    const calls = { userDetail: 0, authorize: 0, loginOut: 0 }
    let privacyAgreed = true
    const api = {
      userDetail: async () => {
        calls.userDetail++
        return { code: 0, data: { base: { id: 'oUSER123', nick: '小明', avatarUrl: 'cloud://a.png' } } }
      }
    }
    const auth = {
      checkHasLogined: async () => true,
      authorize: async () => { calls.authorize++; return {} },
      loginOut: () => { calls.loginOut++ }
    }
    const privacy = {
      hasAgreed: () => privacyAgreed,
      resetAgreed() {}
    }
    const page = loadPage('pages/my/index.js', {
      requires: {
        'api-map$': api,
        'utils/auth$': auth,
        'shop-config$': SHOP_STUB,
        'utils/address$': { getDefault: () => null, formatFull: () => '' },
        'utils/admin$': { isAdminOpenid: () => false, ensureWhitelist: async () => true },
        'utils/location$': { isDevOrTrialEnv: () => false, openNavigation: async () => {} },
        'utils/privacy$': privacy,
        'utils/log$': QUIET_LOG
      },
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

    // 隐私未同意时点登录 → 不授权、提示先同意
    privacyAgreed = false
    page.login()
    check('★ 未同意隐私政策时点登录 → 先要求同意（不发起登录）',
      calls.authorize === 0 && page.__toasts.some((t) => /隐私政策/.test(String(t))), page.__toasts)

    // 弹窗同意后自动继续登录
    privacyAgreed = true
    page.onPrivacyAgree()
    await new Promise((r) => setTimeout(r, 0))
    check('★ 隐私同意后自动继续登录（不用再点一次）',
      calls.authorize === 1 && calls.userDetail === 1 &&
      page.data.loggedOut === false && store.loggedOut === undefined,
      { calls, store, loggedOut: page.data.loggedOut })

    // 2026-10-17 顾客反馈：退出登录入口移到「编辑资料」页底部，本页不再放
    check('★ 「我的」页不再有退出登录入口/逻辑',
      typeof page.logout === 'undefined' &&
      !/bindtap="logout"/.test(src('pages/my/index.wxml')) &&
      !/logout\(\)/.test(src('pages/my/index.js')))

    // 点用户卡：已退出 → 登录；已登录 → 进编辑资料页
    page.data.loggedOut = true
    const before = calls.authorize
    page.onTapUserCard()
    await new Promise((r) => setTimeout(r, 0))
    check('已退出时点用户卡 = 重新登录', calls.authorize === before + 1, calls)
    page.data.loggedOut = false
    page.onTapUserCard()
    check('已登录时点用户卡 = 进入「编辑资料」页',
      page.__navigations.indexOf('/pages/profile-edit/index') >= 0, page.__navigations)
  }

  // =========================================================================
  console.log('\n=== 4) 编辑资料页：回填 / 校验 / 保存 / 头像并发 / 地址入口 ===')
  // =========================================================================
  {
    let modified = null
    let navigatedBack = 0
    const logoutStore = {}
    const logoutCalls = { n: 0 }
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
  console.log('\n=== 5) 静态接线：路由 / 组件 / 不再是内联编辑 ===')
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
