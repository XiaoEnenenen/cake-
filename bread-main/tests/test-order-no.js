/**
 * 订单号 / 取餐码生成规则单元测试
 * ---------------------------------------------------------------------------
 * 2026-10-10 重做，替代旧的「13 位毫秒时间戳 + 4 位随机」17 位单号。
 *
 * 新规则：
 *   订单号 orderNumber = 'QH' + yyMMdd + '-' + 4 位随机数字  例：QH261010-8342
 *   取餐码 pickupCode  = 订单号最后 4 位（自提叫号用）        例：8342
 *   （同日二次改造：扫码核销下线，不再生成核销码 hxNumber）
 *
 * 本文件守住的断言：
 *   1) 单号格式固定、日期段与下单时间一致；
 *   2) 单号里不再出现原始毫秒时间戳；
 *   3) 取餐码 = 订单号后 4 位（含老订单的回退计算）；
 *   4) 撞号时自动换候选值重试（不会发放重复单号 / 重复取餐码）；
 *   5) 连续撞号到上限时宁可下单失败，也不发放重复单号。
 * ---------------------------------------------------------------------------
 */
const { dispatch } = require('../cloudfunctions/api/handlers')

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

function seedData(orders) {
  return {
    goods: [
      {
        _id: 'g_ice',
        name: '冰淇淋蛋糕',
        minPrice: 88,
        enabled: true,
        properties: []
      }
    ],
    cart: [],
    order: orders || []
  }
}

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

// ===== 辅助 =====
const ORDER_PAYLOAD = {
  goodsJsonStr: JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }]),
  extJsonStr: '{}',
  shopIdZt: 0,
  shopNameZt: '卿欢蛋糕'
}
const ORDER_NO_RE = /^QH\d{6}-\d{4}$/

function pad(num, len) {
  let s = String(num)
  while (s.length < len) s = '0' + s
  return s
}
/** 与 handlers.js 同规则的日期段（yyMMdd，本地时区） */
function datePart(ms) {
  const d = new Date(ms)
  return pad(d.getFullYear() % 100, 2) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
}
/** 与 handlers.js 同规则的第 i 个候选后缀（随机源固定为 0 时） */
function candidateSuffix(i) {
  return pad((0 + i * 7919) % 10000, 4)
}

function createOrder(db, ctx, extra) {
  return dispatch('orderCreate', Object.assign({}, ORDER_PAYLOAD, extra || {}), ctx)
}

async function main() {
  // =========================================================================
  console.log('=== 1) 新单号格式与日期段 ===')
  // =========================================================================
  const db = createMockDb(seedData())
  const ctx = { db, openid: 'user_A' }
  let r = await createOrder(db, ctx)
  check('下单成功', r.code === 0, r)
  const no1 = r.data.orderNumber
  check('单号形如 QH261010-8342', ORDER_NO_RE.test(no1), no1)
  check('单号长度为 13', String(no1).length === 13, no1)
  check('单号带 QH 前缀（一眼认出是本店单号）', no1.indexOf('QH') === 0, no1)
  const doc1 = db._store.order[0]
  check('日期段 = 下单时间的年月日', no1.slice(2, 8) === datePart(doc1.dateAdd), { no: no1, dateAdd: doc1.dateAdd })
  check('单号里不再出现原始毫秒时间戳', no1.indexOf(String(doc1.dateAdd)) < 0, { no: no1, dateAdd: doc1.dateAdd })
  check('旧的 17 位纯数字单号已不复存在', !/^\d{17}$/.test(no1), no1)

  // =========================================================================
  console.log('\n=== 2) 取餐码 = 订单号后 4 位 ===')
  // =========================================================================
  const pc1 = r.data.pickupCode
  check('下单返回取餐码', !!pc1, r.data)
  check('取餐码为 4 位数字', /^\d{4}$/.test(pc1), pc1)
  check('取餐码 = 订单号后 4 位', pc1 === no1.slice(-4), { pickupCode: pc1, no: no1 })
  check('订单文档里也存了取餐码', doc1.pickupCode === pc1, doc1.pickupCode)
  check('订单文档不再有核销码字段 hxNumber', doc1.hxNumber === undefined, doc1.hxNumber)
  check('下单返回值不再有 hxNumber（扫码核销已下线）', r.data.hxNumber === undefined, r.data)

  r = await createOrder(db, ctx)
  check('第二单成功', r.code === 0, r)
  check('两单订单号不同', r.data.orderNumber !== no1, { a: no1, b: r.data.orderNumber })
  check('两单取餐码不同', r.data.pickupCode !== pc1, { a: pc1, b: r.data.pickupCode })

  // =========================================================================
  console.log('\n=== 3) 列表与详情返回取餐码 / 配送方式（老订单也能回退算出） ===')
  // =========================================================================
  let listRes = await dispatch('orderList', { statusBatch: '0' }, ctx)
  check('订单列表可取', listRes.code === 0, listRes)
  const listed = listRes.data.orderList[0]
  check('列表项带 pickupCode', /^\d{4}$/.test(listed.pickupCode), listed.pickupCode)
  check('列表项带 deliveryMode', listed.deliveryMode === 'pickup', listed.deliveryMode)
  check('列表项不含 hxNumber', listed.hxNumber === undefined, listed.hxNumber)

  const detailRes = await dispatch('orderDetail', { id: doc1._id }, ctx)
  check('订单详情可取', detailRes.code === 0, detailRes)
  check('详情带 pickupCode', detailRes.data.orderInfo.pickupCode === pc1, detailRes.data.orderInfo)
  check('详情带 deliveryMode', detailRes.data.orderInfo.deliveryMode === 'pickup', detailRes.data.orderInfo.deliveryMode)

  // 老订单（2026-10-10 之前生成，17 位单号、没有 pickupCode 字段）→ 用后 4 位回退
  const legacyNo = '17916238923573806'
  const dbLegacy = createMockDb(seedData([
    { _id: 'legacy_1', _openid: 'user_A', orderNumber: legacyNo, dateAdd: 1791623892357, status: 0, statusStr: '待支付', amountReal: 88, goods: [], goodsNumber: 1 }
  ]))
  const legacyCtx = { db: dbLegacy, openid: 'user_A' }
  const legacyDetail = await dispatch('orderDetail', { id: 'legacy_1' }, legacyCtx)
  check('老订单详情可打开', legacyDetail.code === 0, legacyDetail)
  check('老订单取餐码回退为单号后 4 位', legacyDetail.data.orderInfo.pickupCode === '3806', legacyDetail.data.orderInfo.pickupCode)
  check('老订单配送方式回退为自提', legacyDetail.data.orderInfo.deliveryMode === 'pickup', legacyDetail.data.orderInfo.deliveryMode)
  const legacyList = await dispatch('orderList', {}, legacyCtx)
  check('老订单在列表里也有取餐码', legacyList.data.orderList[0].pickupCode === '3806', legacyList.data.orderList[0])

  // =========================================================================
  console.log('\n=== 4) 撞号：自动换候选值重试 ===')
  // =========================================================================
  // 把随机源固定为 0，则第 0 个候选后缀一定是 '0000'。
  // 预置一条同号订单，逼服务端走重试分支。
  const fixedNow = Date.now()
  const takenNo = 'QH' + datePart(fixedNow) + '-0000'
  const db2 = createMockDb(seedData([
    { _id: 'old_1', orderNumber: takenNo, pickupCode: '0000', status: 0 }
  ]))
  const ctx2 = { db: db2, openid: 'user_A' }
  const realRandom = Math.random
  Math.random = () => 0
  try {
    r = await createOrder(db2, ctx2)
  } finally {
    Math.random = realRandom
  }
  check('撞号后仍能下单成功', r.code === 0, r)
  check('换掉了被占用的单号', r.data.orderNumber !== takenNo, { got: r.data.orderNumber, taken: takenNo })
  check('重试候选值 = 第 1 个偏移候选', r.data.orderNumber === 'QH' + datePart(db2._store.order[1].dateAdd) + '-' + candidateSuffix(1), r.data.orderNumber)
  check('取餐码跟着新单号走（也避开了被占用值）', r.data.pickupCode === candidateSuffix(1), r.data.pickupCode)
  check('库里两条订单号确实不同', db2._store.order[0].orderNumber !== db2._store.order[1].orderNumber)
  check('库里两条取餐码确实不同', db2._store.order[0].pickupCode !== db2._store.order[1].pickupCode)

  // =========================================================================
  console.log('\n=== 5) 候选值全被占用时：宁可失败也不发重复单号 ===')
  // =========================================================================
  const allTaken = []
  for (let i = 0; i < 6; i++) {
    allTaken.push({
      _id: 'taken_' + i,
      orderNumber: 'QH' + datePart(fixedNow) + '-' + candidateSuffix(i),
      pickupCode: candidateSuffix(i),
      status: 0
    })
  }
  const db3 = createMockDb(seedData(allTaken))
  const ctx3 = { db: db3, openid: 'user_A' }
  let threw = null
  Math.random = () => 0
  try {
    r = await createOrder(db3, ctx3)
  } catch (e) {
    threw = e
  } finally {
    Math.random = realRandom
  }
  check('未抛异常', threw === null, threw && threw.message)
  check('下单被明确拒绝', r && r.code !== 0, r)
  check('提示可读（订单号生成失败）', r && r.msg === '订单号生成失败，请稍后重试', r && r.msg)
  check('没有写入新订单（不产生重复单号）', db3._store.order.length === 6, db3._store.order.length)

  console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
