/**
 * 阶段 11「营销：优惠券 + 套餐方案 A」回归测试（2026-10-17 新增）
 * ---------------------------------------------------------------------------
 * 覆盖《实施步骤清单》阶段 11 的第 1~9 步，守住这些不变量：
 *
 *   1) **金额唯一出处**：能不能用券、能减多少只由服务端算 ——
 *      `couponUsableForCart`（结算页预览）与 `orderCreate`（实付）用同一套判定，
 *      前端传的 couponId 改不了优惠金额，优惠后实付永不为负；
 *   2) **资格判定**：有效期 / 停用 / 满减门槛（正好等于、低于）/ 新客券
 *      （无 status>=1 的历史订单，待支付与已取消不算老客）/ 每人限用 / 总量上限；
 *   3) **并发不超发**：总量与每人次数都是数据库端条件自增（incField），
 *      并发下单时既不超发，也不突破每人限用；落单失败会回滚，不白吃次数；
 *   4) **订单留痕与对账**：订单快照存 couponId / couponName / couponAmount，
 *      订单列表 / 详情 / 店主列表都带出来；店主补录运费时**不把优惠丢掉**；
 *   5) **店主自助建券**：couponUpsert 的 12 类非法入参被拒、停用走快速通道、
 *      usedCount 只由服务端维护；`couponAdminList` 带使用量与状态；
 *   6) **套餐方案 A（零开发）**：用现有 goodsUpsert 把一个"套装"录成普通商品
 *      （规格组放档位 + 详情写清包含什么），顾客能正常下单 —— 证明方案 A 真能跑；
 *   7) **页面层**（第 10 节）：结算页选券/金额/二次确认、订单详情优惠行、
 *      店主券列表/编辑页的校验与提交、路由与入口、不再留"还没上线"。
 *
 * 运行：node tests/test-coupon.js
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

// ===== 内存数据库（与 test-cloud-api.js / test-admin.js 同一套接口）=====
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
      // 与真实云库一致：_id 是主键，重复插入必须报错
      // （券的 coupon_user 行正是靠主键挡住并发插入的第二行）
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
    // 原子自增（真实实现见 cloudfunctions/api/index.js 的 incField，用 db.command.inc）
    // 函数体内没有 await → 在 node 事件循环里就是原子的，并发用例能真实暴露超发问题。
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

const DAY = 24 * 3600 * 1000
const SHOP = require('../shop-config').shop
const SHOP_CFG = require('../cloudfunctions/api/shop-config')
const ADMIN_OPENID = 'user_shop_owner'

function nearAddr(extra) {
  return Object.assign({
    name: '张三', phone: '13800138000',
    province: '云南省', city: '昆明市', district: '安宁市',
    detail: '太平新城某小区1栋101',
    latitude: SHOP.latitude + 1 / 111.19, longitude: SHOP.longitude
  }, extra || {})
}

/** 一张"正在进行中"的券（各用例在它上面做单点改动） */
function couponDoc(over) {
  const now = Date.now()
  return Object.assign({
    _id: 'cp_1',
    name: '满 100 减 10',
    type: 'threshold',
    threshold: 100,
    amount: 10,
    startTime: now - DAY,
    endTime: now + DAY,
    totalLimit: 0,
    perUserLimit: 0,
    enabled: true,
    sort: 10,
    usedCount: 0,
    createBy: ADMIN_OPENID,
    createTime: now - DAY
  }, over || {})
}

function seedData(coupons) {
  return {
    category: [
      { _id: 'cat_fruit', name: '水果蛋糕', sort: 10, enabled: true }
    ],
    goods: [
      {
        _id: 'g_plain', categoryId: 'cat_fruit', name: '无规格小商品',
        pic: '/images/logo@2x.png', pics: ['/images/logo@2x.png'],
        minPrice: 10, unit: '个', sort: 10, enabled: true, properties: []
      },
      {
        _id: 'g_ice', categoryId: 'cat_fruit', name: '冰淇淋蛋糕',
        pic: '/images/logo@2x.png', pics: ['/images/logo@2x.png'],
        minPrice: 88, unit: '个', sort: 20, enabled: true, properties: []
      }
    ],
    cart: [],
    order: [],
    app_config: [],
    coupon: coupons || [],
    coupon_user: []
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

function asAdmin(db) {
  return { db, openid: ADMIN_OPENID }
}

/**
 * 页面沙箱（与 tests/test-admin.js 第 9 节同一套）：
 * 把页面 js 放进 vm 里跑，Page() 拿走页面对象，wx 与 require 用桩替代。
 * require 是**路径感知**的：相对路径先按真实文件系统解析，写错直接抛
 * "Cannot find module"（与真机白屏同一个错），再拿解析后的路径匹配桩。
 */
const QUIET_LOG = { debug() {}, warn() {}, error() {} }

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

/** 顾客下单载荷（默认自提 1 件 10 元商品） */
function orderPayload(over) {
  return Object.assign({
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_plain', number: 1, propertyChildIds: '' }]),
    extJsonStr: '{}',
    deliveryMode: 'pickup'
  }, over || {})
}

async function main() {
  // =========================================================================
  console.log('=== 1) 权限：非店主调券的写接口一律被拒，且无副作用 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData([couponDoc()]))
    const outsider = { db, openid: 'user_ordinary' }
    const before = JSON.stringify(db._store.coupon)
    const cases = [
      ['couponAdminList', {}],
      ['couponUpsert', { name: '坏人建券', type: 'threshold', threshold: 100, amount: 10 }]
    ]
    for (const [action, payload] of cases) {
      const r = await dispatch(action, payload, outsider)
      check('★ 非店主调用 ' + action + ' 被拒', r.code !== 0, r)
      check('  拒绝文案明确（店主/权限）', /店主|权限/.test(String(r.msg || '')), r.msg)
    }
    const noId = await dispatch('couponUpsert', { name: 'x', amount: 1 }, { db, openid: '' })
    check('★ 身份缺失（openid 为空）也被拒', noId.code !== 0, noId)
    check('★ 越权调用没有改动任何券', JSON.stringify(db._store.coupon) === before)
    check('4 个券 action 都在路由表里',
      ['couponList', 'couponUsableForCart', 'couponAdminList', 'couponUpsert']
        .every((a) => typeof handlers[a] === 'function'))
  }
  SHOP_CFG.adminOpenids.push(ADMIN_OPENID)

  // =========================================================================
  console.log('\n=== 2) 店主建券：字段落库 / 列表视图 / 快速停用 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData([]))
    const ctx = asAdmin(db)
    const now = Date.now()
    const r = await dispatch('couponUpsert', {
      name: '新客立减 8 元',
      type: 'newCustomer',
      amount: 8,
      startTime: now,
      endTime: now + 7 * DAY,
      totalLimit: 100,
      perUserLimit: 5, // 新客券的每人上限会被强制为 1
      sort: 5
    }, ctx)
    check('新建新客券成功', r.code === 0 && r.data.created === true, r)
    const doc = db._store.coupon[0]
    check('★ 字段落库（name/type/amount/时间/总量/排序）',
      doc && doc.name === '新客立减 8 元' && doc.type === 'newCustomer' &&
      doc.amount === 8 && doc.totalLimit === 100 && doc.sort === 5 &&
      doc.startTime === now && doc.endTime === now + 7 * DAY, doc)
    check('★ 新客券的 threshold 归零（不允许"新客券还要求满 X"）', doc.threshold === 0, doc.threshold)
    check('★ usedCount 服务端初始化为 0（不接受前端传值）', doc.usedCount === 0, doc.usedCount)
    check('  写入审计字段 createBy/updBy', doc.createBy === ADMIN_OPENID && doc.updBy === ADMIN_OPENID, doc)
    check('  新客券每人上限实际生效值是 1', H.effectivePerUserLimitOf(doc) === 1)

    // 前端传 usedCount 想伪造使用量 → 必须被忽略（usedCount 只由服务端维护）
    const r2 = await dispatch('couponUpsert', { id: doc._id, usedCount: 999 }, ctx)
    check('★ 编辑时 payload 里的 usedCount 被忽略',
      r2.code === 0 && db._store.coupon[0].usedCount === 0, { r: r2, used: db._store.coupon[0].usedCount })
    const list = await dispatch('couponAdminList', {}, ctx)
    const view = list.data.couponList[0]
    check('★ 列表视图带券面说明与使用量',
      view.ruleText === '新客立减 ¥8' && view.usedCount === 0 &&
      view.usageText === '0 / 100 已用' && view.statusText === '进行中', view)
    check('  列表返回总量与每人上限（新客券**存**的也是 1，不存"填 5 只按 1 算"）',
      view.totalLimit === 100 && view.perUserLimit === 1 && view.effectivePerUserLimit === 1, view)
    check('  列表带有效期文案', /^有效期 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 至 /.test(view.validText), view.validText)

    // 只切启用/停用 = 快速通道（不重新校验其它字段）
    const off = await dispatch('couponUpsert', { id: doc._id, enabled: false }, ctx)
    check('★ 只传 {id, enabled} 即可停用（快速通道）',
      off.code === 0 && db._store.coupon[0].enabled === false, off)
    check('  停用后列表状态为「已停用」且其它字段没被清掉',
      (await dispatch('couponAdminList', {}, ctx)).data.couponList[0].statusText === '已停用' &&
      db._store.coupon[0].name === '新客立减 8 元')
    check('  非法 enabled（字符串）被拒',
      (await dispatch('couponUpsert', { id: doc._id, enabled: 'false' }, ctx)).code !== 0)
  }

  // =========================================================================
  console.log('\n=== 3) 入参校验：12 类非法券设置一律拒绝 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData([]))
    const ctx = asAdmin(db)
    const now = Date.now()
    const base = {
      name: '测试券', type: 'threshold', threshold: 100, amount: 10,
      startTime: now, endTime: now + DAY, totalLimit: 100, perUserLimit: 1, sort: 10
    }
    const badCases = [
      ['名称为空', { name: '' }],
      ['名称超过 30 字', { name: '很'.repeat(31) }],
      ['优惠金额为 0', { amount: 0 }],
      ['优惠金额为负', { amount: -5 }],
      ['满减券没有门槛', { threshold: '' }],
      ['门槛为 0', { threshold: 0 }],
      ['优惠金额 ≥ 门槛（等于白送）', { amount: 100 }],
      ['类型非法', { type: 'random' }],
      ['开始时间非法', { startTime: '不是时间' }],
      ['结束时间早于开始时间', { endTime: now - DAY }],
      ['总量不是整数', { totalLimit: 1.5 }],
      ['每人限用超过上限', { perUserLimit: 101 }],
      ['排序不是整数', { sort: 'abc' }]
    ]
    for (const [label, patch] of badCases) {
      const r = await dispatch('couponUpsert', Object.assign({}, base, patch), ctx)
      check('★ 拒绝：' + label, r.code !== 0, r)
    }
    check('★ 非法入参一条都没落库', db._store.coupon.length === 0, db._store.coupon)

    const ok = await dispatch('couponUpsert', base, ctx)
    check('同一份合法设置能建券（证明上面的拒绝不是"怎么都失败"）', ok.code === 0, ok)
    check('  建券后 usedCount 为 0', db._store.coupon[0].usedCount === 0)
  }

  // 新环境还没建 coupon / coupon_user 集合：顾客端要降级，店主端要给出可执行提示（不是 500）
  {
    const dbMissing = createMockDb(seedData([couponDoc()]))
    const origFind = dbMissing.find.bind(dbMissing)
    dbMissing.find = async (col, where, opts) => {
      if (col === 'coupon' || col === 'coupon_user') throw new Error('collection not exists')
      return origFind(col, where, opts)
    }
    const rl = await dispatch('couponList', {}, { db: dbMissing, openid: 'user_no_coll' })
    check('★ coupon 集合缺失时顾客端按"没有券"降级（结算页不崩）',
      rl.code === 0 && rl.data.coupons.length === 0, rl)
    const rn = await dispatch('orderCreate', orderPayload(), { db: dbMissing, openid: 'user_no_coll' })
    check('  不用券下单不受影响', rn.code === 0, rn)
    const origAdd = dbMissing.add.bind(dbMissing)
    dbMissing.add = async (col, data) => {
      if (col === 'coupon') throw new Error('collection not exists')
      return origAdd(col, data)
    }
    const nowT = Date.now()
    const ra = await dispatch('couponUpsert', {
      name: '测试券', type: 'threshold', threshold: 100, amount: 10,
      startTime: nowT, endTime: nowT + DAY
    }, asAdmin(dbMissing))
    check('★ 缺 coupon 集合时建券给出可执行提示（不是"服务异常"）',
      ra.code !== 0 && /coupon 集合/.test(ra.msg), ra)
  }

  // =========================================================================
  console.log('\n=== 4) 顾客读券：可见范围 / 资格 / 结算页预估优惠 ===')
  // =========================================================================
  {
    const now = Date.now()
    const coupons = [
      couponDoc({ _id: 'cp_active', name: '满 5 减 3', threshold: 5, amount: 3, sort: 1 }),
      couponDoc({ _id: 'cp_disabled', enabled: false, sort: 2 }),
      couponDoc({ _id: 'cp_expired', startTime: now - 2 * DAY, endTime: now - DAY, sort: 3 }),
      couponDoc({ _id: 'cp_future', startTime: now + DAY, endTime: now + 2 * DAY, sort: 4 }),
      couponDoc({ _id: 'cp_soldout', totalLimit: 2, usedCount: 2, sort: 5 }),
      couponDoc({
        _id: 'cp_new', name: '新客立减 10', type: 'newCustomer', threshold: 0,
        amount: 10, perUserLimit: 5, totalLimit: 50, sort: 6
      }),
      couponDoc({
        _id: 'cp_limit', name: '每人限用 1 次', threshold: 5, amount: 2,
        perUserLimit: 1, sort: 7
      })
    ]
    const db = createMockDb(seedData(coupons))
    // 老客：有一条已完成的订单；新客：没有任何订单
    db._store.order.push({ _id: 'o_old', _openid: 'user_old', status: 3, amountReal: 50, goods: [] })

    const listNew = await dispatch('couponList', {}, { db, openid: 'user_new' })
    const ids = listNew.data.coupons.map((c) => c.id)
    check('★ 只返回进行中的券（停用/未开始/已过期/已抢完全部不出现）',
      ids.indexOf('cp_disabled') < 0 && ids.indexOf('cp_expired') < 0 &&
      ids.indexOf('cp_future') < 0 && ids.indexOf('cp_soldout') < 0, ids)
    check('  进行中的券都在（含新客券、限用券）',
      ids.indexOf('cp_active') >= 0 && ids.indexOf('cp_new') >= 0 && ids.indexOf('cp_limit') >= 0, ids)
    const newCoupon = listNew.data.coupons.filter((c) => c.id === 'cp_new')[0]
    check('★ 新客（无历史订单）对新客券 eligible=true', newCoupon.eligible === true, newCoupon)
    check('  券面说明由服务端生成（满减/新客两种文案）',
      listNew.data.coupons.filter((c) => c.id === 'cp_active')[0].ruleText === '满 ¥5 减 ¥3' &&
      newCoupon.ruleText === '新客立减 ¥10')

    const listOld = await dispatch('couponList', {}, { db, openid: 'user_old' })
    const oldNewCoupon = listOld.data.coupons.filter((c) => c.id === 'cp_new')[0]
    check('★ 老客（有 status>=1 的历史订单）对新客券 eligible=false 且说明原因',
      oldNewCoupon.eligible === false && /新顾客/.test(oldNewCoupon.reason), oldNewCoupon)

    // 待支付(0) / 已取消(-1) 的历史订单不算老客
    const dbUnpaid = createMockDb(seedData([coupons[5]]))
    dbUnpaid._store.order.push({ _id: 'o_u', _openid: 'user_unpaid', status: 0, goods: [] })
    const ru = await dispatch('couponList', {}, { db: dbUnpaid, openid: 'user_unpaid' })
    check('★ 只下过"待支付"单的顾客仍算新客', ru.data.coupons[0].eligible === true, ru.data.coupons[0])

    // 已经用过的券：coupon_user 记 1 次 → eligible=false
    const dbUsed = createMockDb(seedData([coupons[6]]))
    dbUsed._store.coupon_user.push({
      _id: 'cu_x', _openid: 'user_used', couponId: 'cp_limit', usedCount: 1
    })
    const ru2 = await dispatch('couponList', {}, { db: dbUsed, openid: 'user_used' })
    check('★ 每人限用 1 次的券用过后 eligible=false',
      ru2.data.coupons[0].eligible === false && /用过/.test(ru2.data.coupons[0].reason),
      ru2.data.coupons[0])

    // ---- 结算页预览：可用券 + 预估优惠（金额由服务端算）----
    const dbCart = createMockDb(seedData(coupons))
    const ctxCart = { db: dbCart, openid: 'user_cart' }
    await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxCart)
    const preview = await dispatch('couponUsableForCart', { deliveryMode: 'pickup' }, ctxCart)
    check('结算预览返回购物车商品金额（10 元）', preview.code === 0 && preview.data.goodsAmount === 10, preview.data)
    const byId = {}
    preview.data.coupons.forEach((c) => { byId[c.id] = c })
    check('★ 满 5 减 3：可用且预估优惠 3', byId.cp_active.usable === true && byId.cp_active.discount === 3, byId.cp_active)
    check('★ 新客立减 10：优惠封顶不超过商品金额（10 → 10）',
      byId.cp_new.usable === true && byId.cp_new.discount === 10, byId.cp_new)
    check('★ 默认最优券 = 优惠最大的那张', preview.data.bestCouponId === 'cp_new' && preview.data.bestDiscount === 10,
      { best: preview.data.bestCouponId, d: preview.data.bestDiscount })

    // 门槛不够：把券门槛设成 100 → 不可用并说明还差多少
    const dbCart2 = createMockDb(seedData([couponDoc({ _id: 'cp_big', threshold: 100, amount: 10 })]))
    const ctxCart2 = { db: dbCart2, openid: 'user_cart2' }
    await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxCart2)
    const preview2 = await dispatch('couponUsableForCart', {}, ctxCart2)
    check('★ 金额没到门槛 → 不可用 + 提示还差多少',
      preview2.data.coupons[0].usable === false &&
      preview2.data.coupons[0].reason === '再买 ¥90 可用', preview2.data.coupons[0])
    check('  没有可用券时 bestCouponId 为空', preview2.data.bestCouponId === '')

    // 商品金额刚好等于门槛 → 可用（边界）
    const dbCart3 = createMockDb(seedData([couponDoc({ _id: 'cp_eq', threshold: 10, amount: 3 })]))
    const ctxCart3 = { db: dbCart3, openid: 'user_cart3' }
    await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxCart3)
    const preview3 = await dispatch('couponUsableForCart', {}, ctxCart3)
    check('★ 商品金额正好等于门槛 → 可用（边界）',
      preview3.data.coupons[0].usable === true && preview3.data.coupons[0].discount === 3,
      preview3.data.coupons[0])
  }

  // =========================================================================
  console.log('\n=== 5) 下单用券：金额正确 / 门槛 / 新客 / 不出现负实付 ===')
  // =========================================================================
  {
    // (1) 满减：10 元商品 - 3 元 = 7 元
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_3', threshold: 5, amount: 3 })]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_3' }), { db, openid: 'user_a' })
      check('★ 满减券：10 - 3 = 实付 7 元', r.code === 0 && r.data.amountReal === 7, r)
      check('  订单快照：goodsAmount 仍是原价，couponAmount 单独记',
        db._store.order[0].goodsAmount === 10 && db._store.order[0].couponAmount === 3, db._store.order[0])
      check('  订单快照记下券 id / 名称 / 类型',
        db._store.order[0].couponId === 'cp_3' &&
        db._store.order[0].couponName === '满 100 减 10' &&
        db._store.order[0].couponType === 'threshold', db._store.order[0])
      check('★ 券总量使用次数 +1', db._store.coupon[0].usedCount === 1, db._store.coupon[0].usedCount)
      check('★ 每人用券记录 +1',
        db._store.coupon_user[0].usedCount === 1 && db._store.coupon_user[0].couponId === 'cp_3',
        db._store.coupon_user)
    }

    // (2) 门槛：低于门槛拒绝且不消耗券
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_11', threshold: 11, amount: 3 })]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_11' }), { db, openid: 'user_b' })
      check('★ 低于门槛 → 拒绝下单', r.code !== 0 && /未满|门槛/.test(r.msg), r)
      check('  没有生成订单，也没消耗券次数',
        db._store.order.length === 0 && db._store.coupon[0].usedCount === 0)
    }

    // (3) 正好等于门槛 → 可用
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_eq', threshold: 10, amount: 3 })]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_eq' }), { db, openid: 'user_c' })
      check('★ 金额正好等于门槛 → 可用', r.code === 0 && r.data.amountReal === 7, r)
    }

    // (4) 优惠封顶：优惠 30 元但商品只有 10 元 → 实付 0，绝不为负
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_big', threshold: 5, amount: 30 })]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_big' }), { db, openid: 'user_d' })
      check('★ 优惠大于商品金额 → 封顶到商品金额，实付 0（不是 -20）',
        r.code === 0 && r.data.amountReal === 0 && db._store.order[0].couponAmount === 10, r)
    }

    // (5) 打包费不参与优惠：商品 10 - 券 10 + 打包费 2 = 2
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_10', threshold: 5, amount: 10 })]))
      Object.assign(db._store.goods[0], { packingFee: 2 })
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_10' }), { db, openid: 'user_e' })
      check('★ 优惠只抵商品金额：0 + 打包费 2 = 实付 2',
        r.code === 0 && r.data.amountReal === 2 && r.data.packingFee === 2, r)
    }

    // (6) 新客券：新客能用、老客被拒
    {
      const mkNew = () => couponDoc({
        _id: 'cp_new', name: '新客立减 10', type: 'newCustomer', threshold: 0,
        amount: 10, perUserLimit: 5, totalLimit: 50
      })
      const dbNew = createMockDb(seedData([mkNew()]))
      const rNew = await dispatch('orderCreate', orderPayload({ couponId: 'cp_new' }), { db: dbNew, openid: 'user_newbie' })
      check('★ 新客券：新客下单成功且减 10', rNew.code === 0 && rNew.data.amountReal === 0, rNew)

      const dbOld = createMockDb(seedData([mkNew()]))
      dbOld._store.order.push({ _id: 'o_paid', _openid: 'user_regular', status: 3, goods: [] })
      const rOld = await dispatch('orderCreate', orderPayload({ couponId: 'cp_new' }), { db: dbOld, openid: 'user_regular' })
      check('★ 新客券：老客被拒（服务端判定，前端改不掉）',
        rOld.code !== 0 && /新顾客/.test(rOld.msg), rOld)
      check('  老客被拒后没有消耗券次数', dbOld._store.coupon[0].usedCount === 0)

      // 新客券每人只能一次：同一人第二单被拒
      const r2 = await dispatch('orderCreate', orderPayload({ couponId: 'cp_new' }), { db: dbNew, openid: 'user_newbie' })
      check('★ 新客券同一人只能用一次（第二单被拒）', r2.code !== 0 && /用过/.test(r2.msg), r2)
    }

    // (7) 券不存在 / 非法 couponId → 明确拒绝，不能静默当"没用券"
    {
      const db = createMockDb(seedData([]))
      const r1 = await dispatch('orderCreate', orderPayload({ couponId: 'cp_not_exist' }), { db, openid: 'user_f' })
      check('★ 券不存在 → 拒绝', r1.code !== 0 && /不存在/.test(r1.msg), r1)
      const r2 = await dispatch('orderCreate', orderPayload({ couponId: '<script>' }), { db, openid: 'user_f' })
      check('★ 非法 couponId → 拒绝（不静默忽略）', r2.code !== 0, r2)
      check('  两种情况都没有生成订单', db._store.order.length === 0)
    }

    // (8) 过期 / 停用券 → 下单被拒且不消耗次数
    {
      const nowT = Date.now()
      const dbExp = createMockDb(seedData([
        couponDoc({ _id: 'cp_exp', startTime: nowT - 2 * DAY, endTime: nowT - DAY })
      ]))
      const rExp = await dispatch('orderCreate', orderPayload({ couponId: 'cp_exp' }), { db: dbExp, openid: 'user_exp' })
      check('★ 过期券下单被拒（提示"已过期"）',
        rExp.code !== 0 && /已过期/.test(rExp.msg), rExp)
      check('  过期券不消耗使用次数', dbExp._store.coupon[0].usedCount === 0)

      const dbOff = createMockDb(seedData([couponDoc({ _id: 'cp_off', enabled: false })]))
      const rOff = await dispatch('orderCreate', orderPayload({ couponId: 'cp_off' }), { db: dbOff, openid: 'user_off' })
      check('★ 已停用券下单被拒（提示"已停用"）',
        rOff.code !== 0 && /已停用/.test(rOff.msg), rOff)
    }

    // (9) 叠加：一次传多张券（数组）→ 拒绝（本店一单只能 1 张）
    {
      const db = createMockDb(seedData([
        couponDoc({ _id: 'cp_m1', threshold: 5, amount: 1 }),
        couponDoc({ _id: 'cp_m2', threshold: 5, amount: 2 })
      ]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: ['cp_m1', 'cp_m2'] }), { db, openid: 'user_multi' })
      check('★ 一次传多张券 → 拒绝（不支持叠加）', r.code !== 0, r)
      check('  没有生成订单、也没消耗券', db._store.order.length === 0 &&
        db._store.coupon.every((c) => c.usedCount === 0))
    }
  }

  // =========================================================================
  console.log('\n=== 6) 总量 / 每人限用：并发不超发，失败不白吃次数 ===')
  // =========================================================================
  {
    // (1) 总量 2：4 个不同顾客并发下单 → 只成功 2 单，usedCount 正好 2
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_total', threshold: 5, amount: 3, totalLimit: 2 })]))
      const users = ['u1', 'u2', 'u3', 'u4']
      const rs = await Promise.all(users.map((openid) =>
        dispatch('orderCreate', orderPayload({ couponId: 'cp_total' }), { db, openid })
      ))
      const okCount = rs.filter((r) => r.code === 0).length
      check('★ 总量 2：并发 4 单只成功 2 单', okCount === 2, rs.map((r) => r.code))
      check('★ 库里只有 2 张订单', db._store.order.length === 2, db._store.order.length)
      check('★ 券的 usedCount 正好 2（没有超发）', db._store.coupon[0].usedCount === 2, db._store.coupon[0].usedCount)
      check('  没抢到的两单提示「抢完」', rs.filter((r) => r.code !== 0).every((r) => /抢完/.test(r.msg)))
    }

    // (2) 每人限用 1 次：同一顾客并发两单 → 只成功 1 单
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_user1', threshold: 5, amount: 3, perUserLimit: 1 })]))
      const rs = await Promise.all([
        dispatch('orderCreate', orderPayload({ couponId: 'cp_user1' }), { db, openid: 'user_same' }),
        dispatch('orderCreate', orderPayload({ couponId: 'cp_user1' }), { db, openid: 'user_same' })
      ])
      check('★ 每人限用 1 次：并发两单只成功 1 单',
        rs.filter((r) => r.code === 0).length === 1, rs.map((r) => ({ c: r.code, m: r.msg })))
      check('  库里只有 1 张订单、每人记录 1 次',
        db._store.order.length === 1 &&
        db._store.coupon_user.length === 1 && db._store.coupon_user[0].usedCount === 1,
        db._store.coupon_user)
      check('  失败那一单的券次数被回滚（usedCount 仍是 1）', db._store.coupon[0].usedCount === 1, db._store.coupon[0].usedCount)
    }

    // (3) 每人限用 2 次：前两单成功、第三单被拒
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_user2', threshold: 5, amount: 3, perUserLimit: 2 })]))
      const ctx = { db, openid: 'user_two' }
      const r1 = await dispatch('orderCreate', orderPayload({ couponId: 'cp_user2' }), ctx)
      const r2 = await dispatch('orderCreate', orderPayload({ couponId: 'cp_user2' }), ctx)
      const r3 = await dispatch('orderCreate', orderPayload({ couponId: 'cp_user2' }), ctx)
      check('★ 每人限用 2 次：前两单成功、第三单被拒',
        r1.code === 0 && r2.code === 0 && r3.code !== 0 && /限用/.test(r3.msg),
        [r1.code, r2.code, r3.msg])
      check('  每人记录正好 2 次', db._store.coupon_user[0].usedCount === 2)
    }

    // (4) 落单失败 → 券次数回滚（模拟云库写订单失败）
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_rollback', threshold: 5, amount: 3 })]))
      const origAdd = db.add.bind(db)
      db.add = async (col, data) => {
        if (col === 'order') throw new Error('mock: order write failed')
        return origAdd(col, data)
      }
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_rollback' }), { db, openid: 'user_rb' })
      check('★ 订单写入失败 → 返回服务异常（不是假成功）', r.code !== 0, r)
      check('★ 落单失败后券次数回滚为 0（不白吃一次）',
        db._store.coupon[0].usedCount === 0, db._store.coupon[0].usedCount)
      check('  每人记录也回滚为 0', db._store.coupon_user[0].usedCount === 0, db._store.coupon_user)
    }

    // (5) 配送不可达 → 在下单校验阶段就拒，券不消耗（占券在配送校验之后）
    {
      const db = createMockDb(seedData([couponDoc({ _id: 'cp_geo', threshold: 5, amount: 3 })]))
      const farAddr = nearAddr({ detail: '昆明市区某小区', latitude: SHOP.latitude + 0.5 })
      const r = await dispatch('orderCreate', orderPayload({
        couponId: 'cp_geo', deliveryMode: 'delivery', address: farAddr
      }), { db, openid: 'user_geo' })
      check('★ 超出配送范围被拒', r.code !== 0, r)
      check('★ 配送校验失败不消耗券次数', db._store.coupon[0].usedCount === 0, db._store.coupon[0].usedCount)
    }
  }

  // =========================================================================
  console.log('\n=== 7) 订单留痕 / 取消不退券 / 店主补运费不丢优惠 / 幂等 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData([couponDoc({ _id: 'cp_keep', threshold: 5, amount: 3 })]))
    const ctx = { db, openid: 'user_order' }
    const created = await dispatch('orderCreate', orderPayload({ couponId: 'cp_keep' }), ctx)
    const orderId = created.data.id
    check('前置：用券下单成功', created.code === 0 && created.data.couponAmount === 3, created)

    // 订单列表 / 详情带出券信息
    const list = await dispatch('orderList', {}, ctx)
    const item = list.data.orderList[0]
    check('★ orderList 带出 couponAmount / couponName',
      item.couponAmount === 3 && item.couponName === '满 100 减 10', item)
    const detail = await dispatch('orderDetail', { id: orderId }, ctx)
    check('★ orderDetail 带出券信息（详情页据此显示优惠行）',
      detail.data.orderInfo.couponAmount === 3 &&
      detail.data.orderInfo.couponId === 'cp_keep' &&
      detail.data.orderInfo.couponName === '满 100 减 10', detail.data.orderInfo)

    // 取消订单：不退券（本期明确取舍）
    const closed = await dispatch('orderClose', { id: orderId }, ctx)
    check('取消订单成功', closed.code === 0, closed)
    check('★ 取消订单不退回优惠券（usedCount 仍是 1）',
      db._store.coupon[0].usedCount === 1, db._store.coupon[0].usedCount)
    check('  订单快照仍保留券信息（对账用）',
      db._store.order[0].couponAmount === 3 && db._store.order[0].status === -1)

    // 幂等：同一 token 重复提交 → 只落一张单、只消耗一次券
    {
      const dbI = createMockDb(seedData([couponDoc({ _id: 'cp_idem', threshold: 5, amount: 3 })]))
      const ctxI = { db: dbI, openid: 'user_idem' }
      const p = orderPayload({ couponId: 'cp_idem', clientOrderToken: 'tok_coupon_00001' })
      const first = await dispatch('orderCreate', p, ctxI)
      const again = await dispatch('orderCreate', p, ctxI)
      check('★ 带券幂等：重复提交返回同一张单',
        first.code === 0 && again.code === 0 && again.data.duplicated === true &&
        again.data.id === first.data.id, { first: first.data, again: again.data })
      check('★ 带券幂等：库里 1 张单、券只消耗 1 次',
        dbI._store.order.length === 1 && dbI._store.coupon[0].usedCount === 1,
        { orders: dbI._store.order.length, used: dbI._store.coupon[0].usedCount })
    }
    // 并发同一 token + 每人限用 1 次：只能有一张单，且券只消耗一次（另一个请求成功或明确失败都行）
    {
      const dbR = createMockDb(seedData([couponDoc({ _id: 'cp_race', threshold: 5, amount: 3, perUserLimit: 1 })]))
      const ctxR = { db: dbR, openid: 'user_race' }
      const p = orderPayload({ couponId: 'cp_race', clientOrderToken: 'tok_coupon_race1' })
      const rs = await Promise.all([
        dispatch('orderCreate', p, ctxR),
        dispatch('orderCreate', p, ctxR)
      ])
      check('★ 带券并发同一 token：只落 1 张单',
        dbR._store.order.length === 1, dbR._store.order.length)
      check('★ 带券并发同一 token：券只消耗 1 次',
        dbR._store.coupon[0].usedCount === 1, dbR._store.coupon[0].usedCount)
      check('  至少有一个请求成功（不会两个都失败）', rs.some((r) => r.code === 0), rs.map((r) => ({ c: r.code, m: r.msg })))
    }

    // 店主补录运费：amountReal = 商品 - 优惠 + 打包费 + 运费（优惠不能被抹掉）
    {
      const dbF = createMockDb(seedData([couponDoc({ _id: 'cp_freight', threshold: 5, amount: 10 })]))
      // 地址没有经纬度（顾客手填/选点没取到坐标）→ 运费"待确认"（freight = null），
      // 这正是店主端「确认运费」的适用场景
      const noCoordAddr = nearAddr({
        detail: '太平新城某小区3栋', latitude: 0, longitude: 0
      })
      const r = await dispatch('orderCreate', orderPayload({
        goodsJsonStr: JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }]),
        couponId: 'cp_freight',
        deliveryMode: 'delivery',
        address: noCoordAddr
      }), { db: dbF, openid: 'user_freight' })
      check('前置：地址无坐标的外送单（运费待确认）下单成功', r.code === 0, r)
      check('  下单时实付 = 88 - 10 + 0 = 78', r.data.amountReal === 78, r.data)
      const confirm = await dispatch('orderFreightConfirm', { id: r.data.id, freight: 18 },
        { db: dbF, openid: ADMIN_OPENID })
      check('★ 补录运费后实付 = 88 - 10 + 18 = 96（优惠没被丢掉）',
        confirm.code === 0 && confirm.data.amountReal === 96, confirm)
      check('  订单里 goodsAmount / couponAmount / freight 三清',
        dbF._store.order[0].goodsAmount === 88 && dbF._store.order[0].couponAmount === 10 &&
        dbF._store.order[0].freight === 18, dbF._store.order[0])
    }

    // 店主视角订单列表带出券信息
    {
      const dbA = createMockDb(seedData([couponDoc({ _id: 'cp_admin', threshold: 5, amount: 3 })]))
      const r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_admin' }), { db: dbA, openid: 'user_adminview' })
      check('前置：顾客下单成功', r.code === 0, r)
      const adminList = await dispatch('orderAdminList', {}, { db: dbA, openid: ADMIN_OPENID })
      const o = adminList.data.orderList[0]
      check('★ 店主订单列表带出 couponAmount / couponName（对账用）',
        o.couponAmount === 3 && o.couponName === '满 100 减 10', o)
    }
  }

  // =========================================================================
  console.log('\n=== 8) 套餐方案 A（零开发）：把套装录成普通商品即可下单 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData([]))
    const admin = asAdmin(db)
    // 用现有的店主商品接口"录入套餐"：规格组放档位，详情写清包含什么
    const created = await dispatch('goodsUpsert', {
      name: '生日套装｜主蛋糕 + 纸杯蛋糕 6 只',
      categoryId: 'cat_fruit',
      minPrice: 168,
      unit: '套',
      pics: ['cloud://env.goods/combo-1.jpg'],
      characteristic: '6 寸主蛋糕 + 纸杯蛋糕 6 只',
      content: '包含：6 寸生日蛋糕 1 个（可自选口味）+ 纸杯蛋糕 6 只。\n适合 4~6 人，请提前 3 小时预订。',
      properties: [{
        id: 'size', name: '档位',
        childsCurGoods: [
          { id: 'combo_a', name: '基础套装（168 元）', priceDelta: 0 },
          { id: 'combo_b', name: '升级套装（218 元）', priceDelta: 50 }
        ]
      }],
      enabled: true,
      sort: 5
    }, admin)
    check('★ 方案 A：套餐能通过现有商品接口录入', created.code === 0, created)
    const combo = db._store.goods.filter((g) => /生日套装/.test(g.name))[0]
    check('  套餐就是一个普通商品（规格组=档位，详情写清包含什么）',
      combo && combo.properties.length === 1 && /包含/.test(combo.content), combo)
    // 顾客按套餐下单：服务端按普通商品计价 → 基础套装 168 元
    const r = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify([{
        goodsId: combo._id, number: 1, propertyChildIds: 'size:combo_a'
      }]),
      extJsonStr: '{}',
      deliveryMode: 'pickup'
    }, { db, openid: 'user_combo' })
    check('★ 方案 A：顾客能按套餐下单（168 元）', r.code === 0 && r.data.amountReal === 168, r)
    check('  订单快照含档位说明（店主备料看得到）',
      r.code === 0 && /基础套装/.test(db._store.order[0].goods[0].property), db._store.order[0].goods[0])
    // 升级档位 +50
    const r2 = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify([{
        goodsId: combo._id, number: 1, propertyChildIds: 'size:combo_b'
      }]),
      extJsonStr: '{}',
      deliveryMode: 'pickup'
    }, { db, openid: 'user_combo2' })
    check('★ 方案 A：档位加价生效（168 + 50 = 218）', r2.code === 0 && r2.data.amountReal === 218, r2)
  }

  // =========================================================================
  console.log('\n=== 9) 纯函数边界（券状态 / 文案 / 解析）===')
  // =========================================================================
  {
    const now = Date.now()
    const base = { enabled: true, startTime: now - DAY, endTime: now + DAY, totalLimit: 0, usedCount: 0, amount: 10, threshold: 100 }
    check('进行中', H.couponStatusOf(base, now).key === 'active')
    check('未开始', H.couponStatusOf(Object.assign({}, base, { startTime: now + DAY }), now).key === 'pending')
    check('已结束', H.couponStatusOf(Object.assign({}, base, { endTime: now - 1 }), now).key === 'expired')
    check('已停用', H.couponStatusOf(Object.assign({}, base, { enabled: false }), now).key === 'disabled')
    check('已抢完', H.couponStatusOf(Object.assign({}, base, { totalLimit: 5, usedCount: 5 }), now).key === 'soldout')
    check('总量不限（0）时 usedCount 再大也不算抢完',
      H.couponStatusOf(Object.assign({}, base, { totalLimit: 0, usedCount: 999 }), now).key === 'active')
    check('满减文案', H.couponRuleText({ type: 'threshold', threshold: 100, amount: 10.5 }) === '满 ¥100 减 ¥10.5')
    check('新客文案忽略门槛', H.couponRuleText({ type: 'newCustomer', threshold: 0, amount: 8 }) === '新客立减 ¥8')
    check('couponId 解析：空值 = 不用券', H.parseCouponId(undefined).ok && H.parseCouponId('').id === '')
    check('couponId 解析：非法字符被拒', H.parseCouponId('a b').ok === false)
    check('couponId 解析：超长被拒', H.parseCouponId('x'.repeat(129)).ok === false)
    const t1 = H.normalizeCouponTime('2026-10-20 18:30')
    check('时间解析：字符串按北京时间解读（不随云函数时区漂移）',
      t1 === Date.UTC(2026, 9, 20, 18, 30) - 8 * 3600 * 1000, t1)
    check('时间解析：13 位毫秒字符串', H.normalizeCouponTime(String(now)) === now)
    check('时间解析：10 位秒字符串按秒处理', H.normalizeCouponTime('1700000000') === 1700000000000)
    check('时间解析：非法值返回 null', H.normalizeCouponTime('不是时间') === null)
    check('新客券每人上限强制为 1', H.effectivePerUserLimitOf({ type: 'newCustomer', perUserLimit: 9 }) === 1)
    check('满减券每人上限取配置值（0 = 不限）',
      H.effectivePerUserLimitOf({ type: 'threshold', perUserLimit: 0 }) === 0 &&
      H.effectivePerUserLimitOf({ type: 'threshold', perUserLimit: 3 }) === 3)
  }

  // =========================================================================
  console.log('\n=== 10) 页面层：结算页选券 / 订单详情优惠行 / 店主券管理 ===')
  // =========================================================================
  const ADMIN_STUB = {
    isShopAdmin: async () => true,
    isAdminUser: () => true,
    ensureAdminFlag: async () => true,
    getMyOpenid: async () => 'o_test',
    guardShopAdminPage: async () => true
  }

  // ---- 10.1 路由 + 店主中心入口（阶段 11 起券页真的能进） ----
  {
    const appJson = JSON.parse(src('app.json'))
    check('app.json 注册了券列表页', appJson.pages.indexOf('pages/admin/coupons/index') >= 0)
    check('app.json 注册了券编辑页', appJson.pages.indexOf('pages/admin/coupons-edit/index') >= 0)

    const page = loadPage('pages/admin/index.js', {
      requires: {
        'api-map$': {
          adminOrderList: async () => ({ code: 0, data: { statusCounts: {} } }),
          adminGoodsList: async () => ({ code: 0, data: {} })
        },
        'utils/admin$': ADMIN_STUB,
        'utils/location$': { isDevOrTrialEnv: () => false },
        'utils/log$': QUIET_LOG
      }
    })
    page.goCoupons()
    check('★ 店主中心「优惠券 / 满减」入口跳到券管理页',
      page.__navigations[0] === '/pages/admin/coupons/index', page.__navigations)
    check('★ 店主中心不再写"还没上线"（阶段 11 已交付）',
      src('pages/admin/index.wxml').indexOf('还没上线') < 0 &&
      src('pages/admin/index.js').indexOf('还没上线') < 0)
  }

  // ---- 10.2 店主券列表页：状态统计 / 停用走快速通道 ----
  {
    const views = [
      {
        id: 'cp_a', name: '满 100 减 10', amount: 10, ruleText: '满 ¥100 减 ¥10',
        validText: '有效期 2026-10-01 00:00 至 2026-10-31 23:59', usageText: '1 / 100 已用',
        statusText: '进行中', statusKey: 'active', enabled: true,
        effectivePerUserLimit: 1, totalLimit: 100, perUserLimit: 1, sort: 10
      },
      {
        id: 'cp_b', name: '新客立减 8 元', amount: 8, ruleText: '新客立减 ¥8',
        validText: '有效期 2026-10-01 00:00 至 2026-10-31 23:59', usageText: '0 次已用（不限量）',
        statusText: '已停用', statusKey: 'disabled', enabled: false,
        effectivePerUserLimit: 1, totalLimit: 0, perUserLimit: 5, sort: 20
      }
    ]
    const calls = []
    const api = {
      adminCouponList: async () => {
        calls.push('list')
        return { code: 0, data: { couponList: views, total: 2, statusCounts: { active: 1, disabled: 1 } } }
      },
      adminCouponUpsert: async (p) => {
        calls.push(p)
        return { code: 0, data: { id: p.id } }
      }
    }
    const page = loadPage('pages/admin/coupons/index.js', {
      requires: { 'api-map$': api, 'utils/admin$': ADMIN_STUB, 'utils/log$': QUIET_LOG }
    })
    await page.loadList()
    check('券列表装载成功（含已停用的券）', page.data.couponList.length === 2 && page.data.total === 2)
    check('★ 列表直接展示服务端算好的规则/有效期/使用量（前端不重复实现规则）',
      page.data.couponList[0].ruleText === '满 ¥100 减 ¥10' &&
      /已用/.test(page.data.couponList[0].usageText) &&
      /有效期/.test(page.data.couponList[0].validText))
    check('  状态统计汇总各状态',
      page.data.statsText === '进行中 1 · 未开始 0 · 已结束 0 · 已停用 1', page.data.statsText)

    page.toggleEnabled({ currentTarget: { dataset: { index: 1 } } })
    await new Promise((r) => setTimeout(r, 0))
    const upsertCall = calls.filter((c) => typeof c === 'object')[0]
    check('★ 停用/启用走快速通道：只传 { id, enabled }（不重新校验其它字段）',
      upsertCall && upsertCall.id === 'cp_b' && upsertCall.enabled === true &&
      Object.keys(upsertCall).length === 2, upsertCall)
    check('  操作完重新拉列表', calls.filter((c) => c === 'list').length === 2)
    check('  有二次确认（误触不能直接停掉正在跑的活动）', page.__modals.length === 1, page.__modals)
  }

  // ---- 10.3 店主券编辑页：回填 / 校验 / 提交毫秒时间戳 ----
  {
    const existing = {
      id: 'cp_a', name: '满 100 减 10', type: 'threshold', threshold: 100, amount: 10,
      startTime: Date.now() - DAY, endTime: Date.now() + DAY,
      totalLimit: 100, perUserLimit: 1, sort: 10, enabled: true,
      ruleText: '满 ¥100 减 ¥10', validText: '', usageText: '', statusText: '进行中',
      statusKey: 'active', effectivePerUserLimit: 1
    }
    let submitted = null
    const api = {
      adminCouponList: async () => ({ code: 0, data: { couponList: [existing] } }),
      adminCouponUpsert: async (p) => {
        submitted = p
        return { code: 0, data: { id: p.id || 'cp_new' } }
      }
    }
    const page = loadPage('pages/admin/coupons-edit/index.js', {
      requires: { 'api-map$': api, 'utils/admin$': ADMIN_STUB, 'utils/log$': QUIET_LOG }
    })
    await page.onLoad({ id: 'cp_a' })
    check('编辑页回填券设置（数值转成输入框字符串）',
      page.data.name === '满 100 减 10' && page.data.threshold === '100' &&
      page.data.amount === '10' && page.data.typeIndex === 0 &&
      page.data.totalLimit === '100' && page.data.enabled === true, page.data)
    check('有效期回填成「日期 + 时刻」两组',
      /^\d{4}-\d{2}-\d{2}$/.test(page.data.startDate) &&
      /^\d{2}:\d{2}$/.test(page.data.startTimeText) &&
      /^\d{4}-\d{2}-\d{2}$/.test(page.data.endDate), page.data)

    const v = page.validate()
    check('合法表单通过校验', v.ok === true, v.msg)
    check('★ 提交的是数字与毫秒时间戳（不是输入框字符串）',
      typeof v.payload.amount === 'number' && typeof v.payload.threshold === 'number' &&
      typeof v.payload.startTime === 'number' && typeof v.payload.endTime === 'number' &&
      v.payload.id === 'cp_a', v.payload)

    page.data.amount = '100'
    check('★ 优惠金额 ≥ 满减门槛 → 拒绝（否则实付 0、等于白送）',
      page.validate().ok === false)
    page.data.amount = '10'

    page.data.endDate = page.data.startDate
    page.data.endTimeText = '00:00'
    check('★ 结束时间不晚于开始时间 → 拒绝', page.validate().ok === false)
    page.data.endTimeText = '23:59'

    page.data.totalLimit = '1.5'
    check('总量不是整数 → 拒绝', page.validate().ok === false)
    page.data.totalLimit = '100'

    page.data.amount = '10.555'
    check('优惠金额超过两位小数 → 拒绝', page.validate().ok === false)
    page.data.amount = '10'

    await page.save()
    check('★ 保存调用 adminCouponUpsert 并带上 id（编辑）', !!submitted && submitted.id === 'cp_a', submitted)
    check('  保存结束后按钮复位（不会卡在"保存中…"）', page.data.saving === false)

    // 新建 + 新客券：threshold 归零、每人 1 次由服务端强制（页面有说明）
    let created = null
    const api2 = {
      adminCouponUpsert: async (p) => {
        created = p
        return { code: 0, data: { id: 'cp_new2' } }
      }
    }
    const page2 = loadPage('pages/admin/coupons-edit/index.js', {
      requires: { 'api-map$': api2, 'utils/admin$': ADMIN_STUB, 'utils/log$': QUIET_LOG }
    })
    await page2.onLoad({})
    check('新建默认值：7 天有效 / 总量不限 / 每人 1 次',
      page2.data.totalLimit === '0' && page2.data.perUserLimit === '1' &&
      page2.data.startDate !== page2.data.endDate, page2.data)
    page2.data.name = '新客立减 8 元'
    page2.data.typeIndex = 1
    page2.data.amount = '8'
    page2.refreshTypeHint()
    check('新客券说明写清"每人限用 1 次（服务端强制）"',
      /每人限用 1 次/.test(page2.data.typeHint), page2.data.typeHint)
    const v2 = page2.validate()
    check('★ 新客券提交 type=newCustomer、threshold=0',
      v2.ok === true && v2.payload.type === 'newCustomer' && v2.payload.threshold === 0, v2)
    const startMs = new Date(page2.data.startDate.replace(/-/g, '/')).getTime()
    page2.setDuration({ currentTarget: { dataset: { days: 30 } } })
    const endMs = new Date(page2.data.endDate.replace(/-/g, '/')).getTime()
    check('「设为 30 天」把结束日期推到 30 天后',
      Math.round((endMs - startMs) / DAY) === 30, { start: page2.data.startDate, end: page2.data.endDate })
    await page2.save()
    check('新建提交不带 id、时间仍是毫秒数',
      created && created.id === undefined &&
      typeof created.startTime === 'number' && typeof created.endTime === 'number', created)
  }

  // ---- 10.4 结算页：选券 / 金额 / 优惠行 / 下单带上 couponId ----
  {
    // 页面用到的真实规则模块（纯逻辑，不碰 wx）
    const DR = require('../utils/delivery-range')
    const SHOP = require('../shop-config')

    function mkPayPage(orderResponse, overrides) {
      const state = { payload: null, payCalls: 0, usableCalls: 0 }
      const api = Object.assign({
        shippingCarInfo: async () => ({
          code: 0,
          data: { items: [{ goodsId: 'g_plain', number: 1, sku: [] }], price: 10, packingFee: 0, number: 1 }
        }),
        goodsDetailV2: async () => ({ code: 0, data: { basicInfo: { isCake: false }, properties: [] } }),
        userDetail: async () => ({ code: 0, data: { base: { mobile: '' } } }),
        couponsAvailable: async () => ({ code: 0, data: { coupons: [{ id: 'cp1', eligible: true }] } }),
        couponUsableForCart: async () => {
          state.usableCalls++
          return {
            code: 0,
            data: {
              goodsAmount: 10,
              packingFee: 0,
              coupons: [
                {
                  id: 'cp1', name: '满 5 减 3', ruleText: '满 ¥5 减 ¥3', amount: 3,
                  validText: '有效期 2026-10-01 至 2026-10-31', usable: true, reason: '', discount: 3
                },
                {
                  id: 'cp2', name: '新客立减 10', ruleText: '新客立减 ¥10', amount: 10,
                  validText: '有效期 2026-10-01 至 2026-10-31', usable: false,
                  reason: '仅限新顾客', discount: 0
                }
              ],
              bestCouponId: 'cp1',
              bestDiscount: 3
            }
          }
        },
        orderCreate: async (p) => { state.payload = p; return orderResponse },
        shippingCarInfoRemoveAll: async () => ({ code: 0 })
      }, overrides || {})
      const page = loadPage('pages/pay/index.js', {
        requires: {
          'api-map$': api,
          'utils/auth$': { login() {}, wxaCode: async () => 'code' },
          'utils/login-gate$': {
            isLoggedOut: () => false,
            requireLogin: (page, action) => { if (typeof action === 'function') action(); return true },
            onLoginSuccess: () => {}
          },
          'utils/pay$': { wxpay: () => { state.payCalls++ } },
          'shop-config$': SHOP,
          'utils/delivery$': {
            PICKUP: 'pickup', getMode: () => 'pickup',
            isDelivery: () => false, isDeliveryEnabled: () => true, setMode() {}
          },
          'utils/address$': {
            formatFull: () => '', getById: () => null, getDefault: () => null,
            isValidPhone: (p) => /^1\d{10}$/.test(String(p || ''))
          },
          'utils/delivery-range$': DR,
          'utils/location$': {}
        }
      })
      // 店铺 / 购物车 / 时间等前置状态（等价于"结算页已经加载完"）
      page.data.cartLoaded = true
      page.data.cartEmpty = false
      page.data.shippingCarInfo = { items: [{ goodsId: 'g_plain', number: 1, sku: [] }], price: 10, number: 1 }
      page.data.goodsAmount = 10
      page.data.packingFee = 0
      page.data.isDelivery = false
      page.data.quote = { deliverable: true, distanceKm: 1, freight: 0, freightText: '免配送费' }
      page.data.mobile = '13800138000'
      page.data.fetchTime = '今天 15:00'
      return { page, state }
    }

    {
      const { page, state } = mkPayPage({ code: 0, data: { id: 'o_pay', amountReal: 7, duplicated: false } })
      await page.loadCouponList()
      await page.refreshCoupons()
      check('★ 结算页自动选中服务端推荐的最优券',
        page.data.selectedCouponId === 'cp1' && page.data.couponDiscount === 3, page.data)
      check('★ 合计已扣优惠：10 - 3 = 7（自提）',
        page.data.pickupTotal === 7 && page.shownAmount() === 7,
        { pickupTotal: page.data.pickupTotal, shown: page.shownAmount() })
      check('券行显示券名与抵扣额',
        /满 5 减 3/.test(page.data.couponSummaryText) && /3/.test(page.data.couponSummaryText),
        page.data.couponSummaryText)
      check('不可用券也列出并带服务端原因（顾客知道差在哪）',
        page.data.coupons[1].usable === false && page.data.coupons[1].reason === '仅限新顾客')

      // 不使用优惠券 → 合计恢复原价
      page.onCouponTap({ currentTarget: { dataset: { id: '' } } })
      check('★ 选「不使用优惠券」后合计恢复 10 元',
        page.data.selectedCouponId === '' && page.data.pickupTotal === 10 &&
        page.data.couponDiscount === 0, page.data)
      await page.refreshCoupons()
      check('★ 顾客主动「不使用」后，刷新不会又自动选回一张券',
        page.data.selectedCouponId === '' && page.data.pickupTotal === 10 &&
        page.data.couponSummaryText === '不使用优惠券',
        { id: page.data.selectedCouponId, text: page.data.couponSummaryText })

      // 点不可用券 → 提示原因（不是点了没反应）
      page.onCouponTap({ currentTarget: { dataset: { id: 'cp2', usable: false, reason: '仅限新顾客' } } })
      check('★ 点不可用券 → 提示服务端给的原因',
        page.__toasts.indexOf('仅限新顾客') >= 0, page.__toasts)
      check('  不可用券不会被选中', page.data.selectedCouponId === '', page.data.selectedCouponId)

      // 重新选中券 → 下单
      page.onCouponTap({ currentTarget: { dataset: { id: 'cp1', usable: true } } })
      check('选中券后合计重新变成 7 元', page.data.pickupTotal === 7)
      await page._createOrder()
      check('★ 下单 payload 带上 couponId（只传"想用哪张"，金额仍由服务端算）',
        state.payload && state.payload.couponId === 'cp1', state.payload && state.payload.couponId)
      check('★ 金额与服务端一致 → 不弹二次确认，直接发起支付', page.__modals.length === 0 && state.payCalls === 1,
        { modals: page.__modals.length, pay: state.payCalls })
    }

    // 服务端金额与页面不一致（例如券刚好被抢完/改价）→ 弹二次确认，文案要提到优惠券
    {
      const { page, state } = mkPayPage({ code: 0, data: { id: 'o_pay2', amountReal: 9, duplicated: false } })
      await page.loadCouponList()
      await page.refreshCoupons()
      await page._createOrder()
      check('★ 实付与页面不一致 → 弹「金额已更新」二次确认',
        page.__modals.length === 1 && /金额已更新/.test(String(page.__modals[0].title)), page.__modals)
      check('★ 二次确认文案包含优惠券（不是只提"价格或运费"）',
        /优惠券/.test(String(page.__modals[0].content)) &&
        /实际应付 9/.test(String(page.__modals[0].content)), page.__modals[0].content)
      check('  用户确认后才发起支付', state.payCalls === 1)
    }

    // 券接口失败：不阻塞下单，按"不使用优惠券"处理
    {
      const { page } = mkPayPage(
        { code: 0, data: { id: 'o_pay3', amountReal: 10, duplicated: false } },
        { couponUsableForCart: async () => ({ code: 500, msg: '服务异常' }) }
      )
      await page.loadCouponList()
      await page.refreshCoupons()
      check('★ 券接口失败不阻塞下单：按不使用券处理、金额与服务端口径一致',
        page.data.couponError === true && page.data.couponDiscount === 0 &&
        page.data.pickupTotal === 10, page.data)
    }

    // 选券弹层 / 订单详情 / 结算页 wxml 的关键结构
    const payWxml = src('pages/pay/index.wxml')
    check('结算页有选券弹层与"不使用优惠券"选项',
      /couponPopupShow/.test(payWxml) && /不使用优惠券/.test(payWxml) &&
      /onCouponTap/.test(payWxml))
    check('结算页写明「优惠券使用后取消订单不退回」',
      /取消订单不退回/.test(payWxml))
    const orderViewWxml = src('pages/order-view/index.wxml')
    check('订单详情页有优惠券抵扣行与不退券提示',
      /couponAmount/.test(orderViewWxml) && /优惠券使用后，取消订单不退回/.test(orderViewWxml))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})

