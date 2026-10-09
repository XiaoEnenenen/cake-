/**
 * 安全回归测试（2026-10-09 阶段二：安全止血）
 * ---------------------------------------------------------------------------
 * 目的：把第二阶段审计发现的 5 个服务端漏洞固化成断言，防止以后退化。
 * 背景：原 tests/test-cloud-api.js 的 74 项断言全部集中在"正常路径"，
 *       一条都没有覆盖 orderCreate 的非法入参 —— 这正是漏洞能活到现在的原因。
 *
 * 覆盖：
 *   SEC-1 支付回调分支必须默认关闭（伪造回调）
 *   SEC-2 核销必须校验调用者身份 + 订单状态
 *   SEC-3 orderCreate 入参校验（负数 / 0 / 非整数 / 超量 / 重复行 / 规格 / 上架）
 *   SEC-4 importData 必须从公开路由移除
 *   SEC-5 orderDelete 状态限制 + 未支付订单回滚库存
 *
 * 运行：node tests/test-security.js
 * ---------------------------------------------------------------------------
 */
const path = require('path')
const fs = require('fs')

// 必须先拿到 shop-config 的对象引用，再「篡改」白名单用于测试（不修改仓库里的配置文件）
const SHOP_CONFIG = require('../cloudfunctions/api/shop-config')
const { dispatch } = require('../cloudfunctions/api/handlers')

const ADMIN_OPENID = 'openid_shop_owner'
const STRANGER_OPENID = 'openid_stranger'

// ===== 内存数据库（与 test-cloud-api.js 同一套）=====
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
    },
    // 库存原子扣减（与 cloudfunctions/api/index.js 的真实实现同语义）
    async decStores(col, id, n) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      if (!r) return { ok: false, reason: 'not_found' }
      if (typeof r.stores !== 'number' || r.stores < n) return { ok: false, reason: 'insufficient' }
      r.stores -= n
      return { ok: true, stores: r.stores }
    },
    // 库存原子回补
    async incStores(col, id, n) {
      const r = (store[col] || []).find((x) => x._id === String(id))
      if (!r) return { ok: false, reason: 'not_found' }
      r.stores = (typeof r.stores === 'number' ? r.stores : 0) + n
      return { ok: true, stores: r.stores }
    }
  }
}

// ===== 假数据 =====
function seedData() {
  return {
    goods: [
      {
        _id: 'g_cake',
        categoryId: 'cat1',
        name: '慕斯围边水果小蛋糕',
        pic: 'p1.jpg',
        pics: [{ pic: 'p1.jpg' }],
        minPrice: 54,
        unit: '个',
        stores: 20,
        sort: 10,
        enabled: true,
        properties: [
          {
            id: 'size',
            name: '磅数',
            childsCurGoods: [
              { id: 's4', name: '4寸', priceDelta: 0 },
              { id: 's6', name: '6寸', priceDelta: 34 }
            ]
          },
          {
            id: 'flavor',
            name: '口味',
            childsCurGoods: [
              { id: 'f_straw', name: '草莓', priceDelta: 0 },
              { id: 'f_choco', name: '巧克力', priceDelta: 10 }
            ]
          }
        ]
      },
      {
        _id: 'g_plain',
        categoryId: 'cat1',
        name: '无规格商品',
        pic: 'p2.jpg',
        minPrice: 10,
        unit: '个',
        stores: 20,
        sort: 20,
        enabled: true,
        properties: []
      },
      {
        _id: 'g_off',
        categoryId: 'cat1',
        name: '已下架商品',
        pic: 'p3.jpg',
        minPrice: 30,
        unit: '个',
        stores: 10,
        sort: 30,
        enabled: false,
        properties: []
      }
    ],
    cart: [],
    order: []
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
function section(t) {
  console.log('\n=== ' + t + ' ===')
}

function ctxOf(db, openid) {
  return { db, openid }
}

// 下单payload快捷构造
function orderPayload(rows, extra) {
  return Object.assign(
    {
      goodsJsonStr: JSON.stringify(rows),
      extJsonStr: '{}',
      shopIdZt: 0,
      shopNameZt: '卿欢蛋糕'
    },
    extra || {}
  )
}

;(async () => {
  // =========================================================================
  section('SEC-1 支付回调分支必须默认关闭')
  // =========================================================================
  const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'api', 'index.js'),
    'utf8'
  )
  check(
    'index.js 声明了 ENABLE_PAY_CALLBACK 开关',
    /ENABLE_PAY_CALLBACK\s*=/.test(indexSrc)
  )
  check(
    '开关默认值为 false（不接支付前禁止回调分支）',
    /ENABLE_PAY_CALLBACK\s*=\s*false/.test(indexSrc)
  )
  const guardAt = indexSrc.search(/if\s*\(\s*ENABLE_PAY_CALLBACK/)
  check('回调分支受开关保护（存在 if (ENABLE_PAY_CALLBACK）', guardAt >= 0)
  // 关键：真正的回调分支必须出现在开关之后（受其保护），而不能是裸的入口判断
  const branchAt = indexSrc.search(/event\.outTradeNo\s*&&\s*event\.resultCode/)
  check(
    '回调入口判断位于开关之后（不再无条件进入回调）',
    guardAt >= 0 && branchAt > guardAt,
    { guardAt, branchAt }
  )

  // =========================================================================
  section('SEC-4 importData 必须从公开路由移除')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const r = await dispatch('importData', { checkOnly: true }, ctxOf(db, STRANGER_OPENID))
    check('任意用户调用 importData 被拒（未知接口 404）', r.code === 404, r)
    const r2 = await dispatch('importData', {}, ctxOf(db, STRANGER_OPENID))
    check('不带 checkOnly 的写入同样被拒', r2.code === 404, r2)
  }

  // =========================================================================
  section('SEC-3 orderCreate 入参校验（核心资损口）')
  // =========================================================================
  {
    // --- 负数数量：以前能过，金额为负、库存反而增加 ---
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_a')
    let r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: -5 }]),
      ctx
    )
    check('负数数量被拒', r.code !== 0, r)
    check('负数数量不产生订单', (db._store.order || []).length === 0, db._store.order)
    check('负数数量不改变库存（仍 20）', db._store.goods[0].stores === 20, db._store.goods[0].stores)

    // --- 数量为 0 ---
    r = await dispatch('orderCreate', orderPayload([{ goodsId: 'g_plain', number: 0 }]), ctx)
    check('数量 0 被拒', r.code !== 0, r)

    // --- 非整数 / 非数字 ---
    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1.5 }]),
      ctx
    )
    check('小数数量被拒', r.code !== 0, r)

    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 'abc' }]),
      ctx
    )
    check('非数字数量被拒', r.code !== 0, r)

    // --- 超大数量（超过单次上限 99）---
    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1000 }]),
      ctx
    )
    check('单行数量超过上限 99 被拒', r.code !== 0, r)
  }

  {
    // --- 同一请求内重复行：以前单请求就能超卖 ---
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_b')
    const r = await dispatch(
      'orderCreate',
      orderPayload([
        { goodsId: 'g_plain', number: 20 },
        { goodsId: 'g_plain', number: 20 }
      ]),
      ctx
    )
    check('重复行合计超库存被拒（库存只有 20）', r.code !== 0, r)
    check('被拒后库存不变（仍 20）', db._store.goods[1].stores === 20, db._store.goods[1].stores)
    check('被拒后不产生订单', (db._store.order || []).length === 0, db._store.order)
  }

  {
    // --- 重复行合计在库存内：应合并成一行、金额正确 ---
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_c')
    const r = await dispatch(
      'orderCreate',
      orderPayload([
        { goodsId: 'g_plain', number: 3 },
        { goodsId: 'g_plain', number: 4 }
      ]),
      ctx
    )
    check('重复行合计不超库存时成功', r.code === 0, r)
    check('  金额 = 10 * 7 = 70', r.data && r.data.amountReal === 70, r.data)
    check('  库存 20 → 13', db._store.goods[1].stores === 13, db._store.goods[1].stores)
  }

  {
    // --- 规格校验：缺组 / 非法规格值 / 多余规格组 ---
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_d')

    let r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_cake', number: 1, propertyChildIds: 'size:s6' }]),
      ctx
    )
    check('只选一半规格（缺口味）被拒', r.code !== 0, r)

    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_cake', number: 1, propertyChildIds: 'size:s6,flavor:NOT_EXIST' }]),
      ctx
    )
    check('不存在的规格值被拒', r.code !== 0, r)

    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1, propertyChildIds: 'fake:id' }]),
      ctx
    )
    check('无规格商品却传了规格组被拒', r.code !== 0, r)

    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_cake', number: 1, propertyChildIds: 'size:s6,flavor:f_choco' }]),
      ctx
    )
    check('合法规格组合成功', r.code === 0, r)
    check('  金额 = 54+34+10 = 98', r.data && r.data.amountReal === 98, r.data)
  }

  {
    // --- 已下架商品 ---
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_e')
    const r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_off', number: 1 }]),
      ctx
    )
    check('已下架商品不能下单', r.code !== 0, r)
    check('  下架商品库存未被扣', db._store.goods[2].stores === 10, db._store.goods[2].stores)
  }

  // =========================================================================
  section('SEC-2 核销鉴权 + 状态校验')
  // =========================================================================
  {
    // 白名单暂时置空：任何人都不能核销
    SHOP_CONFIG.adminOpenids.length = 0

    const db = createMockDb(seedData())
    const buyer = ctxOf(db, 'user_buyer')
    const r0 = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1 }]),
      buyer
    )
    const hxNumber = r0.data.hxNumber
    check('（前置）下单成功并生成核销码', !!hxNumber, r0)

    let r = await dispatch('orderHx', { hxNumber }, ctxOf(db, STRANGER_OPENID))
    check('白名单为空时陌生人核销被拒', r.code !== 0, r)
    let order = db._store.order[0]
    check('  订单状态未被改成 3（交易成功）', order.status === 0, order.status)

    // 白名单加入店主
    SHOP_CONFIG.adminOpenids.push(ADMIN_OPENID)

    // 仍不允许核销未支付订单（status = 0）
    r = await dispatch('orderHx', { hxNumber }, ctxOf(db, ADMIN_OPENID))
    check('店主核销【未支付】订单被拒', r.code !== 0, r)
    order = db._store.order[0]
    check('  订单状态仍为 0', order.status === 0, order.status)

    // 非管理员即使白名单非空也被拒
    r = await dispatch('orderHx', { hxNumber }, ctxOf(db, STRANGER_OPENID))
    check('非管理员核销被拒（白名单非空时）', r.code !== 0, r)

    // 模拟"已支付"（status=1）后，店主可以核销
    order.status = 1
    order.statusStr = '制作中'
    r = await dispatch('orderHx', { hxNumber }, ctxOf(db, ADMIN_OPENID))
    check('店主核销【已支付】订单成功', r.code === 0, r)
    order = db._store.order[0]
    check('  状态变为 3（交易成功）', order.status === 3, order.status)
    check('  写入核销人 hxBy 审计字段', order.hxBy === ADMIN_OPENID, order.hxBy)

    // 重复核销
    r = await dispatch('orderHx', { hxNumber }, ctxOf(db, ADMIN_OPENID))
    check('重复核销被拒', r.code !== 0, r)
  }

  // =========================================================================
  section('SEC-5 orderDelete 状态限制 + 库存回滚')
  // 规则（与前端 pages/current-order/index.wxml 的按钮一致）：
  //   status 0（待支付）→ 只能「取消订单」（取消会回补库存），不能直接删除
  //   status -1（已取消）→ 可以删除
  //   status 1（已支付/制作中）→ 不可删除（阶段 4 补"申请取消"路径）
  //   status 3（已完成/已核销）→ 可以删除（沿用原有前端按钮规则）
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_f')

    // 未支付订单：不能直接删除（否则库存永久丢失）
    let r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 2 }]),
      ctx
    )
    const unpaidId = r.data.id
    check('（前置）未支付订单创建成功，库存 20 → 18', db._store.goods[1].stores === 18, db._store.goods[1].stores)

    r = await dispatch('orderDelete', { id: unpaidId }, ctx)
    check('待支付订单不能直接删除（提示先取消）', r.code !== 0, r)
    check('  订单仍在，库存未变（仍 18）', db._store.goods[1].stores === 18, db._store.goods[1].stores)

    // 正确路径：先取消（回补库存），再删除
    r = await dispatch('orderClose', { id: unpaidId }, ctx)
    check('取消订单成功', r.code === 0, r)
    check('  库存已回补 18 → 20', db._store.goods[1].stores === 20, db._store.goods[1].stores)

    r = await dispatch('orderDelete', { id: unpaidId }, ctx)
    check('已取消订单可以删除', r.code === 0, r)
    check('  订单已移除', !db._store.order.find((o) => o._id === unpaidId), db._store.order.length)

    // 已支付但未核销（status=1）：不可删除（阶段 4 补申请取消路径）
    SHOP_CONFIG.adminOpenids.length = 0
    SHOP_CONFIG.adminOpenids.push(ADMIN_OPENID)

    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1 }]),
      ctx
    )
    const paidId = r.data.id
    // 注意：必须解构出「对象本身」再改，不能写成 db._store.order[0].status
    // （数组元素引用在后续操作后会指向别的对象，导致断言看错对象）
    const paidDoc = db._store.order.find((o) => o._id === paidId)
    paidDoc.status = 1
    paidDoc.statusStr = '制作中'
    check('（前置）订单置为已支付 status=1', paidDoc.status === 1)

    r = await dispatch('orderDelete', { id: paidId }, ctx)
    check('已支付(制作中)订单不可删除', r.code !== 0, r)

    // 店主核销 → status=3 → 允许删除（沿用前端原有按钮规则）
    const hxRes = await dispatch('orderHx', { hxNumber: paidDoc.hxNumber }, ctxOf(db, ADMIN_OPENID))
    check('（前置）店主核销成功，状态变为 3', hxRes.code === 0 && paidDoc.status === 3, { hxRes, status: paidDoc.status })

    r = await dispatch('orderDelete', { id: paidId }, ctx)
    check('已完成订单可以删除（与原前端按钮规则一致）', r.code === 0, r)
    check('  订单已移除', !db._store.order.find((o) => o._id === paidId), db._store.order.length)

    // 越权：不能删他人订单
    r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_plain', number: 1 }]),
      ctx
    )
    const otherId = r.data.id
    const otherDoc = db._store.order.find((o) => o._id === otherId)
    otherDoc.status = -1
    r = await dispatch('orderDelete', { id: otherId }, ctxOf(db, STRANGER_OPENID))
    check('不能删除他人订单', r.code !== 0, r)
    check('  订单仍在', !!db._store.order.find((o) => o._id === otherId))
  }

  // =========================================================================
  section('回归：正常路径不受影响')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = ctxOf(db, 'user_normal')
    const r = await dispatch(
      'orderCreate',
      orderPayload([{ goodsId: 'g_cake', number: 2, propertyChildIds: 'size:s6,flavor:f_choco' }]),
      ctx
    )
    check('正常下单仍然成功', r.code === 0, r)
    check('  金额 = 98 * 2 = 196', r.data && r.data.amountReal === 196, r.data)
    check('  库存 20 → 18', db._store.goods[0].stores === 18, db._store.goods[0].stores)

    const c = await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_straw' }] }, ctx)
    check('加购仍然成功', c.code === 0, c)
    const c2 = await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: [{ optionId: 'size', optionValueId: 's6' }] }, ctx)
    check('加购缺规格仍被拒（原有校验未丢）', c2.code !== 0, c2)
  }

  // ===== 汇总 =====
  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exit(1)
})
