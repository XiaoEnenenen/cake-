/**
 * 上线收尾 P0-1 / P0-3 服务端回归（2026-10-19 新增）
 * ---------------------------------------------------------------------------
 * 覆盖两件事：
 *   P0-1 支付闭环：
 *     · wxpay 未配置商户号 → 501「尚未开通」（绝不伪造支付成功）；
 *     · wxpay 已配置 → 服务端按订单金额算 totalFee、调云开发支付统一下单；
 *     · 支付回调 **不信任 event 字段**，一律 queryOrder 查单验真：
 *       伪造的 SUCCESS 事件（查单 NOTPAY）不得改状态；金额不一致不得改状态；
 *       查单成功才 0 → 1，且重复回调幂等；
 *     · 订单已取消却收到支付成功 → 状态不动，打 needRefund 标记（人工退款）；
 *     · orderPayConfirm（客户端支付后确认）与 orderMarkPaid（店主线下收款）。
 *   P0-3 取消退券：
 *     · 下单时占券（防并发超用），取消/超时自动退券；
 *     · 重复取消/退款不二次返还（条件更新 + min:0 兜底）；
 *     · 历史「取消不退券」的老订单删除前补退。
 *
 * 说明：本文件自带内存 db（含 updateWhere 条件更新），不依赖云环境。
 * 运行：node tests/test-pay-server.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const H = require('../cloudfunctions/api/handlers')
const dispatch = H.dispatch
const payCallbackCore = H.payCallbackCore
const payConfigured = H.payConfigured
const SHOP = require('../cloudfunctions/api/shop-config')
const ORDER_STATUS = H.ORDER_STATUS

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

const DAY = 24 * 60 * 60 * 1000
const ADMIN = 'admin_openid_test'
const BUYER = 'buyer_openid_test'
SHOP.adminOpenids = [ADMIN]

// ===========================================================================
// 内存数据库：实现 handlers 需要的那套接口 + 条件更新 updateWhere
// ===========================================================================
function matchRow(row, where) {
  return Object.keys(where || {}).every((k) => row[k] === where[k])
}

function createMockDb(seed) {
  const store = JSON.parse(JSON.stringify(seed))
  let autoId = 5000
  const nextId = () => 'id_' + ++autoId

  return {
    _store: store,
    async find(col, where) {
      return JSON.parse(JSON.stringify((store[col] || []).filter((r) => matchRow(r, where))))
    },
    async findOne(col, where) {
      const rows = (store[col] || []).filter((r) => matchRow(r, where))
      return rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null
    },
    async get(col, id) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      return r ? JSON.parse(JSON.stringify(r)) : null
    },
    async add(col, data) {
      const doc = Object.assign({ _id: nextId() }, data)
      if (!store[col]) store[col] = []
      if (store[col].some((r) => r._id === doc._id)) {
        throw new Error('duplicate key: ' + doc._id)
      }
      store[col].push(JSON.parse(JSON.stringify(doc)))
      return JSON.parse(JSON.stringify(doc))
    },
    async update(col, id, data) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      if (r) Object.assign(r, data)
      return Object.assign({ _id: id }, data)
    },
    // 条件更新：函数体内没有 await，Node 单线程下等价于原子操作（与真实云库语义一致）
    async updateWhere(col, where, data) {
      const rows = (store[col] || []).filter((r) => matchRow(r, where))
      rows.forEach((r) => Object.assign(r, data))
      return { updated: rows.length }
    },
    async remove(col, id) {
      const before = (store[col] || []).length
      store[col] = (store[col] || []).filter((x) => x._id !== String(id))
      return { _id: id, removed: before - store[col].length }
    },
    async removeWhere(col, where) {
      const before = (store[col] || []).length
      store[col] = (store[col] || []).filter((r) => !matchRow(r, where))
      return { removed: before - store[col].length }
    },
    async incField(col, where, field, delta, opts) {
      const o = opts || {}
      const row = (store[col] || []).find((r) => matchRow(r, where))
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

// ===== 种子数据 =====
function couponDoc(over) {
  const now = Date.now()
  return Object.assign({
    _id: 'cp_1',
    name: '满 5 减 3',
    type: 'threshold',
    threshold: 5,
    amount: 3,
    startTime: now - DAY,
    endTime: now + DAY,
    totalLimit: 0,
    perUserLimit: 1,
    enabled: true,
    sort: 10,
    usedCount: 0
  }, over || {})
}

function seedData(over) {
  return Object.assign({
    goods: [{
      _id: 'g_plain',
      name: '无规格小商品',
      pic: '',
      pics: [],
      minPrice: 10,
      unit: '个',
      enabled: true,
      properties: []
    }],
    coupon: [couponDoc()],
    coupon_user: [],
    cart: [],
    order: []
  }, over || {})
}

function orderDoc(over) {
  return Object.assign({
    _id: 'o_1',
    _openid: BUYER,
    orderNumber: 'QH261019-0001',
    dateAdd: Date.now(),
    status: ORDER_STATUS.UNPAID,
    statusStr: '待支付',
    amountReal: 7,
    goodsAmount: 10,
    packingFee: 0,
    freight: 0,
    couponId: 'cp_1',
    couponName: '满 5 减 3',
    couponAmount: 3,
    couponReleased: false,
    deliveryMode: 'pickup',
    goods: []
  }, over || {})
}

const PAYMENT = {
  timeStamp: '1710000000',
  nonceStr: 'nonce_test',
  package: 'prepay_id=wx_test',
  signType: 'MD5',
  paySign: 'sign_test'
}

function makePay(opts) {
  const o = opts || {}
  const calls = { unified: [], query: [] }
  return {
    calls,
    async unifiedOrder(p) {
      calls.unified.push(p)
      if (o.unifiedThrows) throw new Error('mock unifiedOrder boom')
      if (o.unifiedResult) return o.unifiedResult
      return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', payment: PAYMENT }
    },
    async queryOrder(p) {
      calls.query.push(p)
      if (o.queryThrows) throw new Error('mock queryOrder boom')
      if (typeof o.query === 'function') return o.query(p)
      return {
        returnCode: 'SUCCESS',
        resultCode: 'SUCCESS',
        tradeState: 'SUCCESS',
        totalFee: 700,
        cashFee: 700,
        transactionId: 'wx_tx_1',
        timeEnd: '20261019120000'
      }
    }
  }
}

function orderPayload(over) {
  return Object.assign({
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_plain', number: 1, propertyChildIds: '' }]),
    extJsonStr: '{}',
    deliveryMode: 'pickup'
  }, over || {})
}

async function main() {
  // =========================================================================
  console.log('=== 1) 支付配置开关：未配置商户号时绝不伪造成功 ===')
  // =========================================================================
  {
    const savedPay = SHOP.pay
    SHOP.pay = { enabled: false, subMchId: '', envId: '' }
    check('payConfigured() = false（未填商户号）', payConfigured() === false)
    const db = createMockDb(seedData({ order: [orderDoc()] }))
    const r = await dispatch('wxpay', { orderId: 'o_1' }, { db, openid: BUYER })
    check('★ wxpay 未配置 → 501', r.code === 501, r)
    check('  文案明确「尚未开通」且给出到店支付/联系门店的出路',
      /尚未开通/.test(String(r.msg)) && /到店支付|联系门店/.test(String(r.msg)), r.msg)
    check('  未配置时不会触碰数据库订单状态', db._store.order[0].status === ORDER_STATUS.UNPAID)
    SHOP.pay = savedPay
  }

  // =========================================================================
  console.log('\n=== 2) wxpay：服务端算金额 + 统一下单 ===')
  // =========================================================================
  SHOP.pay = { enabled: true, subMchId: '1900000001', envId: 'env-test', callbackFunction: 'api' }
  check('payConfigured() = true（商户号 + 环境 ID 齐全）', payConfigured() === true)

  {
    const db = createMockDb(seedData({ order: [orderDoc()] }))
    const pay = makePay()
    const ctx = { db, openid: BUYER, pay }

    let r = await dispatch('wxpay', { orderId: 'nope' }, ctx)
    check('订单不存在 → 业务失败', r.code !== 0 && /不存在/.test(r.msg), r)

    // 别人的订单
    const otherDb = createMockDb(seedData({ order: [orderDoc({ _openid: 'someone_else' })] }))
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db: otherDb, openid: BUYER, pay })
    check('★ 不能支付别人的订单（越权）', r.code !== 0 && /无权/.test(r.msg), r)

    // 已支付：幂等返回，不重复统一下单
    const paidDb = createMockDb(seedData({ order: [orderDoc({ status: ORDER_STATUS.MAKING })] }))
    const paidPay = makePay()
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db: paidDb, openid: BUYER, pay: paidPay })
    check('★ 已支付订单 → alreadyPaid（前端直接回订单页）',
      r.code === 0 && r.data.alreadyPaid === true, r)
    check('  不重复调用统一下单', paidPay.calls.unified.length === 0)

    // 已取消
    const cancelDb = createMockDb(seedData({ order: [orderDoc({ status: ORDER_STATUS.CANCELLED })] }))
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db: cancelDb, openid: BUYER, pay })
    check('已取消订单 → 拒绝支付', r.code !== 0 && /已取消/.test(r.msg), r)

    // 超时订单：先按超时规则取消，再拒绝
    const expiredDb = createMockDb(seedData({
      order: [orderDoc({ dateAdd: Date.now() - 16 * 60 * 1000 })]
    }))
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db: expiredDb, openid: BUYER, pay })
    check('★ 超过 15 分钟的订单 → 先自动取消再拒绝支付',
      r.code !== 0 && expiredDb._store.order[0].status === ORDER_STATUS.CANCELLED, r)
    check('  超时取消同样退回优惠券', expiredDb._store.coupon[0].usedCount === 0,
      expiredDb._store.coupon[0].usedCount)

    // 统一下单抛异常 / 返回失败
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db, openid: BUYER, pay: makePay({ unifiedThrows: true }) })
    check('统一下单异常 → 明确业务失败（不是 500 崩溃）', r.code !== 0 && /下单失败/.test(r.msg), r)
    r = await dispatch('wxpay', { orderId: 'o_1' }, {
      db, openid: BUYER,
      pay: makePay({ unifiedResult: { returnCode: 'SUCCESS', resultCode: 'FAIL', errCodeDes: '商户号未绑定' } })
    })
    check('统一下单返回失败 → 把可读原因给顾客',
      r.code !== 0 && /商户号未绑定/.test(r.msg), r)

    // 成功：金额/商户号/回调函数名都正确
    const okDb = createMockDb(seedData({ order: [orderDoc()] }))
    const okPay = makePay()
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db: okDb, openid: BUYER, pay: okPay })
    check('★ 统一下单成功 → 返回 wx.requestPayment 需要的支付参数',
      r.code === 0 && r.data.timeStamp === PAYMENT.timeStamp &&
      r.data.package === PAYMENT.package && r.data.paySign === PAYMENT.paySign, r)
    check('★ totalFee 由服务端按 amountReal 算（7 元 → 700 分，忽略前端金额）',
      r.data.totalFee === 700 && okPay.calls.unified[0].totalFee === 700, okPay.calls.unified[0])
    check('  outTradeNo 用订单号（回调按它找回订单）',
      okPay.calls.unified[0].outTradeNo === 'QH261019-0001', okPay.calls.unified[0])
    check('  商户号 / 云环境 / 回调函数名来自 shop-config',
      okPay.calls.unified[0].subMchId === '1900000001' &&
      okPay.calls.unified[0].envId === 'env-test' &&
      okPay.calls.unified[0].functionName === 'api', okPay.calls.unified[0])
    check('  预支付信息落库用于对账', okDb._store.order[0].prepayInfo.totalFee === 700)
    check('  未支付前状态仍是待支付', okDb._store.order[0].status === ORDER_STATUS.UNPAID)

    // 没注入支付适配器（部署了旧 index.js）
    r = await dispatch('wxpay', { orderId: 'o_1' }, { db, openid: BUYER })
    check('云函数未注入支付模块 → 501 明确提示', r.code === 501 && /未加载支付模块/.test(r.msg), r)
  }

  // =========================================================================
  console.log('\n=== 3) 支付回调：只信服务端查单结果（防伪造/防改金额/幂等）===')
  // =========================================================================
  {
    // 3.1 伪造回调：event 说 SUCCESS，查单是 NOTPAY → 不改状态
    const db = createMockDb(seedData({ order: [orderDoc()] }))
    const pay = makePay({ query: () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'NOTPAY' }) })
    let r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS', returnCode: 'SUCCESS', totalFee: 700 },
      { db, pay }
    )
    check('★ 伪造的支付成功回调（查单 NOTPAY）→ 不改订单状态',
      r.errcode === 0 && db._store.order[0].status === ORDER_STATUS.UNPAID, { r, order: db._store.order[0] })
    check('  伪造回调不会写 payTime/payInfo',
      db._store.order[0].payTime === undefined && db._store.order[0].payInfo === undefined)

    // 3.2 正常回调：查单 SUCCESS + 金额一致 → 0 → 1
    const db2 = createMockDb(seedData({ order: [orderDoc()] }))
    const pay2 = makePay()
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS', totalFee: 700 },
      { db: db2, pay: pay2 }
    )
    const o2 = db2._store.order[0]
    check('★ 查单成功 + 金额一致 → 订单变成「制作中」',
      r.errcode === 0 && o2.status === ORDER_STATUS.MAKING && o2.statusStr === '制作中', o2)
    check('  写入支付信息供对账（渠道/微信单号/金额）',
      o2.payInfo && o2.payInfo.payChannel === 'wxpay' &&
      o2.payInfo.transactionId === 'wx_tx_1' && o2.payInfo.totalFee === 700, o2.payInfo)
    check('  记录支付来源与支付时间', o2.paySource === 'wxpay_callback' && Number(o2.payTime) > 0)
    check('  查单带的是订单号与商户号',
      pay2.calls.query[0].outTradeNo === 'QH261019-0001' &&
      pay2.calls.query[0].subMchId === '1900000001', pay2.calls.query[0])

    // 3.3 重复回调：幂等
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS' },
      { db: db2, pay: pay2 }
    )
    check('★ 重复回调幂等（状态仍是制作中、不重复写）',
      r.errcode === 0 && /duplicated/.test(r.errmsg) && db2._store.order[0].status === ORDER_STATUS.MAKING, r)
    check('  重复回调不再查单', pay2.calls.query.length === 1, pay2.calls.query.length)

    // 3.4 金额不一致：拒绝推进
    const db3 = createMockDb(seedData({ order: [orderDoc()] }))
    const pay3 = makePay({
      query: () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', totalFee: 1 })
    })
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS', totalFee: 1 },
      { db: db3, pay: pay3 }
    )
    check('★ 实付金额与订单不一致 → 拒绝推进状态',
      r.errcode === -1 && db3._store.order[0].status === ORDER_STATUS.UNPAID, r)
    check('  金额不一致也留痕（needRefund，失败时不只靠翻日志）',
      db3._store.order[0].needRefund === true &&
      db3._store.order[0].refundStatus === 'pending' &&
      db3._store.order[0].payAnomaly &&
      db3._store.order[0].payAnomaly.type === 'amount_mismatch', db3._store.order[0])

    // 3.5 订单已取消却支付成功：状态不动 + 人工退款标记
    const db4 = createMockDb(seedData({ order: [orderDoc({ status: ORDER_STATUS.CANCELLED })] }))
    const pay4 = makePay()
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS' },
      { db: db4, pay: pay4 }
    )
    const o4 = db4._store.order[0]
    check('★ 已取消订单收到支付成功 → 不改成已支付（钱货分离交给退款）',
      o4.status === ORDER_STATUS.CANCELLED && r.errcode === 0, { r, status: o4.status })
    check('  打上 needRefund / refundStatus=pending 标记',
      o4.needRefund === true && o4.refundStatus === 'pending' &&
      o4.payAfterCancel && o4.payAfterCancel.outTradeNo === 'QH261019-0001', o4)

    // 3.6 找不到订单 / 查单异常 / 未配置
    r = await payCallbackCore({ outTradeNo: 'QH_UNKNOWN', resultCode: 'SUCCESS' }, { db: db4, pay: pay4 })
    check('找不到订单的回调 → 忽略但不报错刷屏', r.errcode === 0 && /not found/.test(r.errmsg), r)
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS' },
      { db: createMockDb(seedData({ order: [orderDoc()] })), pay: makePay({ queryThrows: true }) }
    )
    check('查单异常 → 返回重试信号（不推进状态）', r.errcode === -1, r)
    const savedPay2 = SHOP.pay
    SHOP.pay = { enabled: false, subMchId: '', envId: '' }
    r = await payCallbackCore(
      { outTradeNo: 'QH261019-0001', resultCode: 'SUCCESS' },
      { db: createMockDb(seedData({ order: [orderDoc()] })), pay: makePay() }
    )
    check('未配置支付时收到回调 → 拒绝推进（fail-closed）', r.errcode === -1, r)
    SHOP.pay = savedPay2
  }

  // =========================================================================
  console.log('\n=== 4) orderPayConfirm：客户端支付后主动确认（回调延迟也能推进）===')
  // =========================================================================
  {
    const db = createMockDb(seedData({ order: [orderDoc()] }))
    const pay = makePay()
    const ctx = { db, openid: BUYER, pay }

    let r = await dispatch('orderPayConfirm', { id: 'nope' }, ctx)
    check('订单不存在 → 业务失败', r.code !== 0, r)

    const otherDb = createMockDb(seedData({ order: [orderDoc({ _openid: 'other' })] }))
    r = await dispatch('orderPayConfirm', { id: 'o_1' }, { db: otherDb, openid: BUYER, pay })
    check('★ 不能确认别人的订单', r.code !== 0 && /无权/.test(r.msg), r)

    // 查单 NOTPAY：返回 paid=false（正常情况，让页面稍后刷新）
    const notPay = makePay({
      query: () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'NOTPAY' })
    })
    r = await dispatch('orderPayConfirm', { id: 'o_1' }, { db: createMockDb(seedData({ order: [orderDoc()] })), openid: BUYER, pay: notPay })
    check('查单 NOTPAY → paid=false + 原因（不报错）',
      r.code === 0 && r.data.paid === false && r.data.reason === 'NOTPAY', r)

    // 查单成功但金额不一致（如支付期间店主改了运费）→ 不推进 + needRefund 留痕
    {
      const dbM = createMockDb(seedData({ order: [orderDoc()] }))
      const mismatch = makePay({
        query: () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', totalFee: 1 })
      })
      r = await dispatch('orderPayConfirm', { id: 'o_1' }, { db: dbM, openid: BUYER, pay: mismatch })
      check('★ 查单金额不一致 → paid=false + needRefund 留痕（与回调同口径）',
        r.code === 0 && r.data.paid === false && r.data.reason === 'amount_mismatch' &&
        dbM._store.order[0].needRefund === true && dbM._store.order[0].status === ORDER_STATUS.UNPAID,
        { r, order: dbM._store.order[0] })
    }

    // 查单成功 → 推进
    r = await dispatch('orderPayConfirm', { id: 'o_1' }, ctx)
    check('★ 查单成功 → 订单立即变「制作中」（不依赖回调）',
      r.code === 0 && r.data.paid === true && db._store.order[0].status === ORDER_STATUS.MAKING, r)
    check('  支付来源标记为 client_confirm', db._store.order[0].paySource === 'client_confirm')

    // 已支付再确认：直接 paid=true 且不再查单
    const before = pay.calls.query.length
    r = await dispatch('orderPayConfirm', { id: 'o_1' }, ctx)
    check('已支付订单再确认 → 幂等 paid=true', r.code === 0 && r.data.paid === true, r)
    check('  不再重复查单', pay.calls.query.length === before)
  }

  // =========================================================================
  console.log('\n=== 5) orderMarkPaid：店主确认线下收款（无商户号也能真实经营）===')
  // =========================================================================
  {
    const db = createMockDb(seedData({ order: [orderDoc()] }))

    let r = await dispatch('orderMarkPaid', { id: 'o_1' }, { db, openid: BUYER })
    check('★ 非店主调用 → 被拒（服务端 openid 白名单）', r.code !== 0 && /权限/.test(r.msg), r)
    check('  被拒后订单没有任何改动', db._store.order[0].status === ORDER_STATUS.UNPAID &&
      db._store.order[0].payInfo === undefined)

    r = await dispatch('orderMarkPaid', { id: 'o_1' }, { db, openid: ADMIN })
    const o = db._store.order[0]
    check('★ 店主确认收款 → 订单进入「制作中」',
      r.code === 0 && r.data.status === ORDER_STATUS.MAKING && o.status === ORDER_STATUS.MAKING, r)
    check('  支付信息标记 offline（与线上支付可区分对账）',
      o.payInfo && o.payInfo.payChannel === 'offline' && o.paySource === 'admin_offline', o.payInfo)
    check('  记录确认人（审计）', o.payInfo.confirmedBy === ADMIN)

    r = await dispatch('orderMarkPaid', { id: 'o_1' }, { db, openid: ADMIN })
    check('重复确认 → 拒绝（不重复改状态）', r.code !== 0 && /已收款/.test(r.msg), r)

    const cancelledDb = createMockDb(seedData({ order: [orderDoc({ status: ORDER_STATUS.CANCELLED })] }))
    r = await dispatch('orderMarkPaid', { id: 'o_1' }, { db: cancelledDb, openid: ADMIN })
    check('已取消订单不能确认收款', r.code !== 0 && /不可确认收款/.test(r.msg), r)
  }

  // =========================================================================
  console.log('\n=== 6) P0-3 取消/超时退券（含并发不重复返还）===')
  // =========================================================================
  {
    // 6.1 下单占券 → 取消退券
    const db = createMockDb(seedData())
    const ctx = { db, openid: BUYER }
    let r = await dispatch('orderCreate', orderPayload({ couponId: 'cp_1' }), ctx)
    check('前置：用券下单成功', r.code === 0 && r.data.couponAmount === 3, r)
    check('★ 下单时券被原子占用（usedCount=1，防同一张券并发下多单）',
      db._store.coupon[0].usedCount === 1 && db._store.coupon_user[0].usedCount === 1,
      { coupon: db._store.coupon[0].usedCount, user: db._store.coupon_user[0].usedCount })
    const orderId = r.data.id

    r = await dispatch('orderClose', { id: orderId }, ctx)
    check('★ 取消订单成功', r.code === 0, r)
    check('★ 取消后优惠券退回（usedCount 回到 0）',
      db._store.coupon[0].usedCount === 0 && db._store.coupon_user[0].usedCount === 0,
      { coupon: db._store.coupon[0].usedCount, user: db._store.coupon_user[0].usedCount })
    const closedOrder = db._store.order.find((x) => x._id === orderId)
    check('★ 订单留下退券审计字段（couponReleased / 时间 / 原因）',
      closedOrder.couponReleased === true &&
      Number(closedOrder.couponReleaseTime) > 0 &&
      closedOrder.couponReleaseReason === 'close', closedOrder)
    check('  返回体告知前端券已退回', r.data.couponReleased === true)

    // 6.2 重复取消不重复返还
    r = await dispatch('orderClose', { id: orderId }, ctx)
    check('重复取消 → 业务失败（当前状态不可取消）', r.code !== 0, r)
    check('  券次数仍是 0（不会被减成负数/多次返还）',
      db._store.coupon[0].usedCount === 0 && db._store.coupon_user[0].usedCount === 0)

    // 6.3 并发取消：只返还一次
    {
      const dbRace = createMockDb(seedData())
      const ctxRace = { db: dbRace, openid: BUYER }
      const created = await dispatch('orderCreate', orderPayload({ couponId: 'cp_1' }), ctxRace)
      const rs = await Promise.all([
        dispatch('orderClose', { id: created.data.id }, ctxRace),
        dispatch('orderClose', { id: created.data.id }, ctxRace)
      ])
      // 并发时后到的一路会命中「订单已被取消」的幂等分支（orderClose 返回成功），
      // 所以这里不数成功次数，只要求：至少一路成功 + 券只退一次（见下一条）。
      check('★ 并发取消同一订单：至少一路成功（另一路幂等返回）',
        rs.some((x) => x.code === 0), rs.map((x) => x.code))
      check('★ 并发取消只返还一次（usedCount=0，不会负值）',
        dbRace._store.coupon[0].usedCount === 0 && dbRace._store.coupon_user[0].usedCount === 0,
        dbRace._store.coupon[0].usedCount)
    }

    // 6.4 超时自动取消也退券
    {
      const dbT = createMockDb(seedData())
      const ctxT = { db: dbT, openid: BUYER }
      const created = await dispatch('orderCreate', orderPayload({ couponId: 'cp_1' }), ctxT)
      const now = Date.now() + 20 * 60 * 1000
      const res = await H.cancelExpiredOrders({ now }, ctxT)
      check('★ 超时 15 分钟自动取消 → 退券',
        res.code === 0 && res.data.cancelled === 1 && res.data.couponReleased === 1, res)
      check('  券次数回到 0', dbT._store.coupon[0].usedCount === 0 &&
        dbT._store.coupon_user[0].usedCount === 0)
      const timedOut = dbT._store.order.find((x) => x._id === created.data.id)
      check('  取消原因记为 timeout，且已标记退券',
        timedOut.cancelReason === 'timeout' && timedOut.couponReleased === true &&
        timedOut.couponReleaseReason === 'timeout', timedOut)
    }

    // 6.5 老订单（历史"取消不退券"）删除前补退
    {
      const dbL = createMockDb(seedData())
      dbL._store.order.push(orderDoc({
        _id: 'o_legacy',
        status: ORDER_STATUS.CANCELLED,
        couponReleased: undefined,
        couponReleaseTime: undefined,
        couponReleaseReason: undefined
      }))
      dbL._store.coupon[0].usedCount = 1
      dbL._store.coupon_user.push({ _id: 'cu_legacy', _openid: BUYER, couponId: 'cp_1', usedCount: 1 })
      const r = await dispatch('orderDelete', { id: 'o_legacy' }, { db: dbL, openid: BUYER })
      check('★ 删除历史已取消订单 → 补退当年占用的券',
        r.code === 0 && dbL._store.coupon[0].usedCount === 0, r)
      check('  订单已删除', !dbL._store.order.some((x) => x._id === 'o_legacy'))
    }
  }

  // =========================================================================
  console.log('\n=== 7) P1-5：运费待确认的订单不允许线上支付 ===')
  // =========================================================================
  {
    const pending = orderDoc({
      _id: 'o_freight',
      orderNumber: 'QH261019-0002',
      deliveryMode: 'delivery',
      goodsAmount: 54,
      amountReal: 54,
      freight: 0,
      // 不用券：金额口径只留商品 + 运费，断言更直观
      couponId: '',
      couponAmount: 0,
      deliveryQuote: {
        reason: 'beyond', freightConfirmed: false, freightText: '运费待确认', distanceKm: 9
      }
    })
    const dbP = createMockDb(seedData({ order: [pending] }))
    const payP = makePay()
    let r = await dispatch('wxpay', { orderId: 'o_freight' }, { db: dbP, openid: BUYER, pay: payP })
    check('★ 运费待确认订单 → 拒绝线上支付（先让店主确认运费）',
      r.code !== 0 && /运费待确认/.test(r.msg), r)
    check('  没有发起统一下单（不会按不含运费的金额扣款）', payP.calls.unified.length === 0)
    check('  订单金额没有被改动', dbP._store.order[0].amountReal === 54)

    // 店主补录运费 → 金额重算并标记 freightConfirmed → 可以正常支付
    const confirmed = await dispatch('orderFreightConfirm', { id: 'o_freight', freight: 18 },
      { db: dbP, openid: ADMIN })
    check('前置：店主确认运费 → 实付 = 54 + 18 = 72',
      confirmed.code === 0 && confirmed.data.amountReal === 72, confirmed)
    r = await dispatch('wxpay', { orderId: 'o_freight' }, { db: dbP, openid: BUYER, pay: payP })
    check('★ 店主确认运费后 → 线上支付可发起，totalFee 含运费（7200 分）',
      r.code === 0 && payP.calls.unified[0] && payP.calls.unified[0].totalFee === 7200,
      { r, unified: payP.calls.unified })
  }

  // =========================================================================
  console.log('\n=== 8) P1-4：服务端入参加固（行数/扩展信息/电话）===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = { db, openid: BUYER, pay: makePay() }

    // 行数上限：51 行即便都会合并，也要在合并前拒绝（防放大数据库调用）
    let r = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify(Array.from({ length: 51 }, () => ({ goodsId: 'g_plain', number: 1 }))),
      extJsonStr: '{}', deliveryMode: 'pickup', expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ 单次下单超过 50 行 → 拒绝', r.code !== 0 && /最多 50/.test(r.msg), r)

    r = await dispatch('orderCreate', {
      goodsJsonStr: orderPayload().goodsJsonStr,
      extJsonStr: JSON.stringify({ x: 'y'.repeat(5000) }),
      deliveryMode: 'pickup', expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ extJson 超长（>4KB）→ 拒绝', r.code !== 0 && /扩展信息过长/.test(r.msg), r)

    r = await dispatch('orderCreate', {
      goodsJsonStr: orderPayload().goodsJsonStr,
      extJsonStr: { 联络电话: '13800138000' },
      deliveryMode: 'pickup', expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ extJson 传对象（非 JSON 字符串）→ 拒绝', r.code !== 0 && /扩展信息/.test(r.msg), r)

    // 外送：收货电话必须 11 位手机号
    const addr = {
      name: '张三', phone: '123',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城某小区1栋101', latitude: 24.92, longitude: 102.58
    }
    r = await dispatch('orderCreate', {
      goodsJsonStr: orderPayload().goodsJsonStr, extJsonStr: '{}',
      deliveryMode: 'delivery', address: addr, expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ 外送收货电话不是 11 位手机号 → 拒绝', r.code !== 0 && /收货电话/.test(r.msg), r)

    // 地址字段超长 / 坐标非法 → 拒绝
    r = await dispatch('orderCreate', {
      goodsJsonStr: orderPayload().goodsJsonStr, extJsonStr: '{}',
      deliveryMode: 'delivery',
      address: Object.assign({}, addr, { phone: '13800138000', detail: 'x'.repeat(200) }),
      expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ 收货地址过长 → 拒绝', r.code !== 0 && /地址内容过长/.test(r.msg), r)

    r = await dispatch('orderCreate', {
      goodsJsonStr: orderPayload().goodsJsonStr, extJsonStr: '{}',
      deliveryMode: 'delivery',
      address: Object.assign({}, addr, { phone: '13800138000', latitude: 'abc' }),
      expectTime: '2099-01-01 12:00'
    }, ctx)
    check('★ 收货地址坐标非法 → 拒绝', r.code !== 0 && /坐标不正确/.test(r.msg), r)
  }

  // =========================================================================
  console.log('\n=== 9) 源码/路由守卫（防止后续改动把安全边界改回去）===')
  // =========================================================================
  {
    check('wxpay / orderPayConfirm / orderMarkPaid 已进路由表',
      ['wxpay', 'orderPayConfirm', 'orderMarkPaid'].every((a) => typeof H.handlers[a] === 'function'))

    const indexJs = src('cloudfunctions/api/index.js')
    // 注释里允许提历史（解释"原来为什么关掉"），先剥注释再查代码
    const indexCode = indexJs
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    check('★ 支付回调已接到 payCallbackCore（查单验真）',
      /payCallbackCore/.test(indexCode) && /isPayCallbackEvent/.test(indexCode))
    check('★ 旧的无校验回调开关已删除（ENABLE_PAY_CALLBACK 不再作为开关存在）',
      !/ENABLE_PAY_CALLBACK\s*=/.test(indexCode) && !/if\s*\(\s*ENABLE_PAY_CALLBACK/.test(indexCode))
    check('★ 云函数入口注入 cloudPay 适配器（unifiedOrder + queryOrder）',
      /cloud\.cloudPay\.unifiedOrder/.test(indexCode) && /cloud\.cloudPay\.queryOrder/.test(indexCode))
    check('★ 数据库适配器提供条件更新 updateWhere（原子状态流转的基础）',
      /async updateWhere\(collection, where, data\)/.test(indexCode) &&
      /\.where\(where \|\| \{\}\)\.update/.test(indexCode))

    const handlersJs = src('cloudfunctions/api/handlers.js')
    check('★ 支付回调不信任 event.totalFee：以 queryOrder 的 totalFee 校验',
      /q\.tradeState !== 'SUCCESS'/.test(handlersJs) && /paidFee !== expectFee/.test(handlersJs))
    check('★ 状态推进只允许 0 → 1（条件更新 where status）',
      /\{ _id: order\._id, status: ORDER_STATUS\.UNPAID \}/.test(handlersJs))
    check('★ 取消/超时走 cancelPendingOrder（退券与状态更新同一处）',
      /async function cancelPendingOrder/.test(handlersJs) &&
      /couponReleaseReason/.test(handlersJs))

    const shopCfg = src('cloudfunctions/api/shop-config.js')
    check('★ shop-config 提供 pay 配置段（enabled/subMchId/envId）',
      /pay: \{/.test(shopCfg) && /subMchId/.test(shopCfg) && /envId/.test(shopCfg))
    check('★ 隐私协议与实现一致：地址簿写明仅存本机',
      /仅保存在你的手机本地/.test(shopCfg))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
