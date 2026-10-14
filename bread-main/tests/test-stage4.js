/**
 * 阶段 4「不依赖支付的业务闭环」回归测试
 * ---------------------------------------------------------------------------
 * 覆盖本轮落地的 4 项（4.3 因库存概念删除已作废，4.5/4.6 被「取餐码 + 完成订单」
 * 方案取代，见《实施步骤清单》阶段 4 的表现状说明）：
 *
 *   4.1 订单状态机收敛
 *       - 唯一一份状态表（utils/order-status.js 前端 / handlers.js 云端文案）
 *       - 两端状态集合必须一致（防止漂移）
 *       - 幽灵状态 2 / 4 从查询与模板里消失
 *       - 前端不再覆盖服务端返回的 statusStr
 *       - 服务端按 status 现算文案（脏数据也能纠偏）
 *   4.2 超时未支付自动取消
 *       - config.json 定时触发器（每 5 分钟）
 *       - 超时订单被置为 -1，未超时/已取消/已付款的不受影响
 *       - 幂等、可注入 now 便于测试、不在公开路由表里
 *       - 2026-10-12 追加：超时时间 30 → 15 分钟；
 *         **读取兜底**（orderList / orderDetail 内部先取消超时订单，
 *         不依赖定时触发器是否建好）+ 响应下发 autoCancelAt / serverNow 供前端倒计时
 *   4.7 自提也要校验时间（结算页二次校验 + 自提必选时间）
 *   4.8 订单时间存绝对值（不再存"今天 15:00"）
 *
 * 说明：4.7 / 4.8 改的是小程序页面代码，无法在 node 里跑（依赖 wx.*），
 *      因此用本仓库已有的做法做**源码级断言**（同 tests/test-data-source.js）。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { dispatch, cancelExpiredOrders, orderTimeoutMs } = require('../cloudfunctions/api/handlers')
const OS = require('../utils/order-status')

const ROOT = path.join(__dirname, '..') // bread-main
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

// ===== 内存数据库（与 test-cloud-api.js 同一套精简版）=====
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
      // 与真实云库一致：_id 是主键，**重复插入必须报错**
      // （2026-10-14 的并发/幂等保护正是靠它挡掉第二行/第二张单，见 stableDocId 注释）
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
    }
  }
}

function seedData() {
  return {
    goods: [{ _id: 'g_ice', name: '冰淇淋蛋糕', minPrice: 88, enabled: true, properties: [] }],
    cart: [],
    order: []
  }
}

const ORDER_PAYLOAD = {
  goodsJsonStr: JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }]),
  extJsonStr: '{}',
  shopIdZt: 0,
  shopNameZt: '卿欢蛋糕'
}
const SHOP_CFG = require('../cloudfunctions/api/shop-config')

// ===== 断言工具 =====
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

async function main() {
  // =========================================================================
  console.log('=== 0) 本轮改动的文件能被正常编译（防重复声明这类低级错误）===')
  // =========================================================================
  // 为什么需要：小程序页面文件不会被任何 node 测试执行到（依赖 wx.*），
  // 一旦出现"同一作用域重复 const 声明"这种语法错误，测试全绿但真机白屏。
  // vm.Script 只编译不执行，正好用来兜住这一类问题。
  const COMPILE_FILES = [
    'utils/order-status.js',
    'utils/order-countdown.js',
    'utils/format.js',
    'utils/admin.js',
    'utils/api-map.js',
    'pages/pay/index.js',
    'pages/current-order/index.js',
    'pages/order-view/index.js',
    'pages/my/index.js',
    'pages/select-time/index.js',
    'cloudfunctions/api/index.js',
    'cloudfunctions/api/handlers.js',
    'cloudfunctions/api/shop-config.js'
  ]
  COMPILE_FILES.forEach((rel) => {
    let err = null
    try {
      new vm.Script(src(rel), { filename: rel })
    } catch (e) {
      err = e
    }
    check('可编译：' + rel, err === null, err && err.message)
  })

  // =========================================================================
  console.log('\n=== 4.1 订单状态机收敛 ===')
  // =========================================================================
  const values = Object.keys(OS.STATUS).map((k) => OS.STATUS[k]).sort((a, b) => a - b)
  check('状态只有 -1 / 0 / 1 / 3 四个', JSON.stringify(values) === JSON.stringify([-1, 0, 1, 3]), OS.STATUS)
  check('没有幽灵状态 2', values.indexOf(2) < 0)
  check('没有幽灵状态 4', values.indexOf(4) < 0)
  check('「当前订单」= 待支付 + 制作中', JSON.stringify(OS.CURRENT_STATUS) === JSON.stringify([0, 1]), OS.CURRENT_STATUS)
  check('「历史订单」= 已取消 + 交易成功', JSON.stringify(OS.HISTORY_STATUS) === JSON.stringify([-1, 3]), OS.HISTORY_STATUS)
  check("statusBatch 拼串 = '0,1'", OS.statusBatch(OS.CURRENT_STATUS) === '0,1', OS.statusBatch(OS.CURRENT_STATUS))
  check("statusBatch 拼串 = '-1,3'", OS.statusBatch(OS.HISTORY_STATUS) === '-1,3', OS.statusBatch(OS.HISTORY_STATUS))
  check('删单按钮规则：-1 / 3 可删', OS.canDelete(-1) === true && OS.canDelete(3) === true)
  check('删单按钮规则：0 / 1 不可删', OS.canDelete(0) === false && OS.canDelete(1) === false)
  check('完成订单按钮规则：仅 status=1', OS.canFinish(1) === true && OS.canFinish(0) === false && OS.canFinish(3) === false)
  check('「我的」页订单入口 = 0/1/3/all',
    OS.ORDER_ENTRIES.map((e) => e.key).join(',') === '0,1,3,all',
    OS.ORDER_ENTRIES)

  // 两端状态集合一致（前端 utils/order-status.js ↔ 云函数 handlers.js 文案表）
  const handlersSrc = src('cloudfunctions/api/handlers.js')
  const textBlock = handlersSrc.match(/ORDER_STATUS_TEXT\s*=\s*\{([\s\S]*?)\}/)
  const cloudKeys = textBlock ? (textBlock[1].match(/'(-?\d+)'\s*:/g) || [])
    .map((s) => s.replace(/[':\s]/g, '')).sort() : []
  check('云函数状态文案表能被解析', cloudKeys.length === 4, cloudKeys)
  check('前端与云函数状态集合完全一致（防漂移）',
    JSON.stringify(cloudKeys) === JSON.stringify(values.map(String).sort()),
    { cloud: cloudKeys, front: values.map(String).sort() })

  // 源码级：幽灵状态从查询与模板里消失
  const currentOrderJs = src('pages/current-order/index.js')
  const currentOrderWxml = src('pages/current-order/index.wxml')
  const orderViewJs = src('pages/order-view/index.js')
  check("当前订单页不再用旧 batch '0, 1, 2'", !/statusBatch\s*=\s*'0, 1, 2'/.test(currentOrderJs))
  check("历史订单页不再用旧 batch '-1, 3, 4'", !/statusBatch\s*=\s*'-1, 3, 4'/.test(currentOrderJs))
  check('列表模板不再判断 status == 4', !/status\s*==\s*4/.test(currentOrderWxml))
  check('列表模板用 ST.UNPAID 等常量而不是魔数', currentOrderWxml.indexOf('ST.UNPAID') >= 0 && currentOrderWxml.indexOf('ST.MAKING') >= 0)
  check('列表页不再覆盖服务端 statusStr', !/statusStr\s*=/.test(currentOrderJs))
  check('详情页不再覆盖服务端 statusStr', !/statusStr\s*=/.test(orderViewJs))
  check('「我的」页不再自己维护订单入口表', src('pages/my/index.js').indexOf('OS.ORDER_ENTRIES') >= 0)

  // 功能级：状态流转 + 文案由服务端现算
  const db = createMockDb(seedData())
  const ctx = { db, openid: 'user_A' }
  let r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx)
  check('下单成功', r.code === 0, r)
  const orderId = r.data.id
  let detail = await dispatch('orderDetail', { id: orderId }, ctx)
  check("新订单文案 = '待支付'", detail.data.orderInfo.statusStr === '待支付', detail.data.orderInfo)

  // 脏数据纠偏：库里 statusStr 写错了，返回时仍按 status 现算
  db._store.order[0].statusStr = '制作中'
  detail = await dispatch('orderDetail', { id: orderId }, ctx)
  check('库里旧文案写错也会被纠偏', detail.data.orderInfo.statusStr === '待支付', detail.data.orderInfo.statusStr)

  const listBefore = await dispatch('orderList', { statusBatch: OS.statusBatch(OS.CURRENT_STATUS) }, ctx)
  check('当前订单列表能查到待支付订单', listBefore.data.orderList.length === 1, listBefore.data.orderList.length)
  check('列表文案由 status 现算', listBefore.data.orderList[0].statusStr === '待支付', listBefore.data.orderList[0])

  r = await dispatch('orderClose', { id: orderId }, ctx)
  check('取消订单成功', r.code === 0, r)
  detail = await dispatch('orderDetail', { id: orderId }, ctx)
  check("取消后文案 = '已取消'", detail.data.orderInfo.statusStr === '已取消', detail.data.orderInfo)
  const listAfter = await dispatch('orderList', { statusBatch: OS.statusBatch(OS.CURRENT_STATUS) }, ctx)
  check('已取消订单不在「当前订单」里', listAfter.data.orderList.length === 0, listAfter.data.orderList.length)
  const historyList = await dispatch('orderList', { statusBatch: OS.statusBatch(OS.HISTORY_STATUS) }, ctx)
  check('已取消订单出现在「历史订单」里', historyList.data.orderList.length === 1, historyList.data.orderList.length)

  // 完成订单 → 交易成功
  const db2 = createMockDb(seedData())
  const ctx2 = { db: db2, openid: 'user_B' }
  r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx2)
  const finishId = r.data.id
  db2._store.order[0].status = OS.STATUS.MAKING
  db2._store.order[0].statusStr = '制作中'
  SHOP_CFG.adminOpenids.push(ctx2.openid)
  r = await dispatch('orderFinish', { id: finishId }, ctx2)
  SHOP_CFG.adminOpenids.length = 0
  check('店主完成订单成功', r.code === 0, r)
  detail = await dispatch('orderDetail', { id: finishId }, ctx2)
  check("完成后文案 = '交易成功'", detail.data.orderInfo.statusStr === '交易成功', detail.data.orderInfo)

  // =========================================================================
  console.log('\n=== 4.2 超时未支付自动取消 ===')
  // =========================================================================
  const cfg = JSON.parse(src('cloudfunctions/api/config.json'))
  check('存在 config.json 定时触发器配置', Array.isArray(cfg.triggers) && cfg.triggers.length === 1, cfg)
  check('触发器类型 = timer', cfg.triggers[0].type === 'timer', cfg.triggers[0])
  check('触发器名 = orderTimeoutCancel', cfg.triggers[0].name === 'orderTimeoutCancel', cfg.triggers[0].name)
  check('每 5 分钟触发一次（秒 分 时 日 月 周 年）',
    cfg.triggers[0].config === '0 */5 * * * * *', cfg.triggers[0].config)
  check('shop-config 里超时时间 = 15 分钟', SHOP_CFG.orderTimeoutMinutes === 15, SHOP_CFG.orderTimeoutMinutes)
  check('handlers 读取的超时时间同样是 15 分钟',
    orderTimeoutMs() === 15 * 60 * 1000, orderTimeoutMs())

  const now = 1791624000000 // 固定"当前时间"，便于断言
  const MIN = 60 * 1000
  const db3 = createMockDb(seedData())
  db3._store.order = [
    { _id: 'o_old', _openid: 'u1', orderNumber: 'QH1', status: 0, statusStr: '待支付', dateAdd: now - 16 * MIN },
    { _id: 'o_edge', _openid: 'u1', orderNumber: 'QH2', status: 0, statusStr: '待支付', dateAdd: now - 15 * MIN - 1 },
    { _id: 'o_fresh', _openid: 'u1', orderNumber: 'QH3', status: 0, statusStr: '待支付', dateAdd: now - 14 * MIN },
    { _id: 'o_paid', _openid: 'u1', orderNumber: 'QH4', status: 1, statusStr: '制作中', dateAdd: now - 999 * MIN },
    { _id: 'o_cancelled', _openid: 'u1', orderNumber: 'QH5', status: -1, statusStr: '已取消', dateAdd: now - 999 * MIN },
    { _id: 'o_bad', _openid: 'u1', orderNumber: 'QH6', status: 0, statusStr: '待支付' }
  ]
  const ctx3 = { db: db3, openid: '', appid: '' }
  r = await cancelExpiredOrders({ now }, ctx3)
  check('扫描返回成功', r.code === 0, r)
  check('扫到 4 条待支付（含缺 dateAdd 的脏数据）', r.data.scanned === 4, r.data)
  check('取消 2 条超时订单', r.data.cancelled === 2, r.data)
  check('返回的超时分钟数 = 15', r.data.timeoutMinutes === 15, r.data)
  check('超时订单被置为 -1', db3._store.order.find((o) => o._id === 'o_old').status === -1)
  check("超时订单文案 = '已取消'", db3._store.order.find((o) => o._id === 'o_old').statusStr === '已取消')
  check("写入 cancelReason = 'timeout'（区分顾客主动取消）",
    db3._store.order.find((o) => o._id === 'o_old').cancelReason === 'timeout')
  check('刚好超时的边界订单也被取消', db3._store.order.find((o) => o._id === 'o_edge').status === -1)
  check('未超时订单（14 分钟）不受影响', db3._store.order.find((o) => o._id === 'o_fresh').status === 0)
  check('已付款订单不受影响', db3._store.order.find((o) => o._id === 'o_paid').status === 1)
  check('已取消订单不受影响', db3._store.order.find((o) => o._id === 'o_cancelled').status === -1 &&
    db3._store.order.find((o) => o._id === 'o_cancelled').cancelReason === undefined)
  check('缺 dateAdd 的脏数据不动它', db3._store.order.find((o) => o._id === 'o_bad').status === 0)

  r = await cancelExpiredOrders({ now }, ctx3)
  check('再跑一次是幂等的（不再重复取消）', r.data.cancelled === 0, r.data)

  r = await cancelExpiredOrders({ now, timeoutMinutes: 5 }, { db: createMockDb(
    { goods: [], cart: [], order: [{ _id: 'o_x', status: 0, dateAdd: now - 6 * MIN }] }
  ) })
  check('超时时间可由参数覆盖（5 分钟）', r.data.cancelled === 1 && r.data.timeoutMinutes === 5, r.data)

  r = await dispatch('cancelExpiredOrders', {}, createMockDb(seedData()))
  check('超时取消不在公开路由表里（前端调不到）', r.code === 404, r)

  // 真实链路：超时取消后，订单从「当前订单」消失、进「历史订单」
  const db4 = createMockDb(seedData())
  const ctx4 = { db: db4, openid: 'user_C' }
  r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx4)
  db4._store.order[0].dateAdd = Date.now() - 16 * MIN
  await cancelExpiredOrders({}, ctx4)
  const cur = await dispatch('orderList', { statusBatch: OS.statusBatch(OS.CURRENT_STATUS) }, ctx4)
  const his = await dispatch('orderList', { statusBatch: OS.statusBatch(OS.HISTORY_STATUS) }, ctx4)
  check('超时订单不再出现在当前订单', cur.data.orderList.length === 0, cur.data.orderList.length)
  check('超时订单进入历史订单', his.data.orderList.length === 1 && his.data.orderList[0].status === -1, his.data.orderList)

  // =========================================================================
  console.log('\n=== 4.2b 读取兜底取消（不依赖定时触发器）+ 倒计时字段 ===')
  // =========================================================================
  // 为什么要有这一节：店主 2026-10-12 反馈"待支付账单一直存在"。
  // 根因是定时触发器必须在云开发控制台里真正建出来才生效（只传代码不够）。
  // 现在 orderList / orderDetail 自己会先取消超时订单，触发器没建也不会挂单。
  const db5 = createMockDb(seedData())
  const ctx5 = { db: db5, openid: 'user_D' }
  r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx5)
  const selfOrderId = r.data.id
  const selfDateAdd = db5._store.order[0].dateAdd
  // 别人的一条超时订单：兜底必须只处理"本次请求的顾客"
  db5._store.order.push({
    _id: 'other_expired', _openid: 'user_E', orderNumber: 'QH_OTHER',
    status: 0, statusStr: '待支付', dateAdd: Date.now() - 99 * MIN
  })
  // 自己的订单改成已超时（16 分钟前下单）
  db5._store.order[0].dateAdd = Date.now() - 16 * MIN

  const lazyList = await dispatch('orderList', { statusBatch: '0' }, ctx5)
  check('打开订单列表即完成超时取消（无需定时触发器）',
    lazyList.code === 0 && lazyList.data.orderList.length === 0, lazyList.data.orderList)
  check('自己的超时订单被置为 -1',
    db5._store.order.find((o) => o._id === selfOrderId).status === -1)
  check("兜底取消同样写入 cancelReason = 'timeout'",
    db5._store.order.find((o) => o._id === selfOrderId).cancelReason === 'timeout')
  check('别人的超时订单不受影响（兜底只处理本次请求的顾客）',
    db5._store.order.find((o) => o._id === 'other_expired').status === 0)
  check('列表响应带 serverNow（前端倒计时以服务端时间为基准）',
    typeof lazyList.data.serverNow === 'number' && lazyList.data.serverNow > 0, lazyList.data.serverNow)
  const lazyAll = await dispatch('orderList', {}, ctx5)
  const cancelledItem = lazyAll.data.orderList.find((o) => o.id === selfOrderId)
  check('已取消订单不下发 autoCancelAt（只有待支付才需要倒计时）',
    !!cancelledItem && cancelledItem.autoCancelAt === null,
    cancelledItem && cancelledItem.autoCancelAt)

  // 详情页兜底：一打开详情就已经是「已取消」
  const db6 = createMockDb(seedData())
  const ctx6 = { db: db6, openid: 'user_F' }
  r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx6)
  db6._store.order[0].dateAdd = Date.now() - 16 * MIN
  const lazyDetail = await dispatch('orderDetail', { id: r.data.id }, ctx6)
  check('打开订单详情即完成超时取消',
    lazyDetail.code === 0 && lazyDetail.data.orderInfo.status === -1, lazyDetail.data.orderInfo)
  check("详情文案 = '已取消'", lazyDetail.data.orderInfo.statusStr === '已取消', lazyDetail.data.orderInfo)
  check('详情响应带 serverNow', typeof lazyDetail.data.serverNow === 'number', lazyDetail.data.serverNow)

  // 倒计时字段：待支付订单下发 autoCancelAt = dateAdd + 15 分钟
  const db7 = createMockDb(seedData())
  const ctx7 = { db: db7, openid: 'user_G' }
  r = await dispatch('orderCreate', ORDER_PAYLOAD, ctx7)
  const cdOrderId = r.data.id
  const cdDateAdd = db7._store.order[0].dateAdd
  const cdList = await dispatch('orderList', { statusBatch: '0' }, ctx7)
  const cdItem = cdList.data.orderList[0]
  check('列表下发 autoCancelAt = 下单时间 + 15 分钟',
    cdItem.autoCancelAt === cdDateAdd + 15 * MIN, { autoCancelAt: cdItem.autoCancelAt, dateAdd: cdDateAdd })
  check('列表的 autoCancelAt 换算回服务端时间 = 刚好 15 分钟',
    cdItem.autoCancelAt - cdList.data.serverNow <= 15 * MIN &&
    cdItem.autoCancelAt - cdList.data.serverNow > 15 * MIN - 5000,
    cdItem.autoCancelAt - cdList.data.serverNow)
  const cdDetail = await dispatch('orderDetail', { id: cdOrderId }, ctx7)
  check('详情同样下发 autoCancelAt',
    cdDetail.data.orderInfo.autoCancelAt === cdDateAdd + 15 * MIN, cdDetail.data.orderInfo.autoCancelAt)
  check('未超时的待支付订单不会被兜底误取消',
    db7._store.order[0].status === 0, db7._store.order[0].status)

  // =========================================================================
  console.log('\n=== 4.7 自提时间校验 / 4.8 订单时间存绝对值 ===')
  // =========================================================================
  const paySrc = src('pages/pay/index.js')
  const selectSrc = src('pages/select-time/index.js')
  check('结算页对自提也要求选时间', paySrc.indexOf('请选择自取时间') >= 0)
  check('结算页的时间二次校验不再只包在 isDelivery 里',
    /expectTimeAbs[\s\S]{0,400}checkAdvanceTime/.test(paySrc))
  check('订单不再写入相对文案 fetchTime（自取时间）',
    !/extJsonStr\['自取时间'\]\s*=\s*this\.data\.fetchTime/.test(paySrc))
  check('订单不再写入相对文案 fetchTime（期望送达时间）',
    !/extJsonStr\['期望送达时间'\]\s*=\s*this\.data\.fetchTime/.test(paySrc))
  check('订单时间改用 storage 里的绝对时间 expectTime',
    /wx\.getStorageSync\('expectTime'\)/.test(paySrc) && /extJsonStr\['自取时间'\]\s*=\s*timeForOrder/.test(paySrc))
  check('select-time 仍写入绝对值 expectTime（YYYY-MM-DD HH:mm）',
    /wx\.setStorageSync\('expectTime', expectTimeStr\)/.test(selectSrc))
  check('相对文案仍用于页面展示（顾客体验不变）',
    /wx\.setStorageSync\('fetchTime', timeText\)/.test(selectSrc))

  console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
