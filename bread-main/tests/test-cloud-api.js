/**
 * 云函数逻辑本地测试（用完可删）
 * ---------------------------------------------------------------------------
 * 目的：在没有 AppID、没有云环境的情况下，验证 handlers.js 的业务逻辑正确。
 * 原理：handlers.js 不依赖 wx-server-sdk，只要给它一个内存版 db 就能跑。
 * ---------------------------------------------------------------------------
 */
const H = require('../cloudfunctions/api/handlers')
const { calcPrice } = H
// 2026-10-19 P1-4：服务端现在要求「含蛋糕的订单必须带期望时间」。
// 本文件大量用例只关心金额/权限/幂等，统一在 dispatch 入口补一个合法的远未来时间
// （2099-01-01 12:00：营业时间内、远超 3 小时，与真实日期无关）；
// 显式传了 expectTime 的用例不受影响，需要验证"缺时间被拒"的用例走 H.dispatch。
const DEFAULT_EXPECT_TIME = '2099-01-01 12:00'
const dispatch = (action, payload, ctx) => {
  if (action === 'orderCreate' && payload && payload.expectTime === undefined) {
    payload = Object.assign({}, payload, { expectTime: DEFAULT_EXPECT_TIME })
  }
  return H.dispatch(action, payload, ctx)
}

// ===== 内存数据库（实现 handlers 需要的那套接口）=====
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
    },
    // 2026-10-14（backlog：并发/幂等）：原子自增。
    // 真实实现见 cloudfunctions/api/index.js 的 incField（用 db.command.inc 在数据库端完成）。
    // 这里函数体内**没有 await**，在 node 事件循环里就是原子的 —— 因此并发用例
    // （Promise.all 同时发两个 cartAdd）能真实暴露原来"先读后写"的丢数量问题。
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

// ===== 假数据 =====
function seedData() {
  return {
    category: [
      { _id: 'cat_fruit', name: '水果蛋糕', sort: 10, enabled: true },
      { _id: 'cat_ice', name: '冰淇淋蛋糕', sort: 20, enabled: true },
      { _id: 'cat_off', name: '已停用分类', sort: 30, enabled: false }
    ],
    goods: [
      {
        _id: 'g_musi',
        categoryId: 'cat_fruit',
        name: '慕斯围边水果小蛋糕',
        pic: 'p1.jpg',
        pics: [{ pic: 'p1.jpg' }, { pic: 'p2.jpg' }],
        characteristic: '水果味 / 约400克',
        content: '<p>动物奶油</p>',
        minPrice: 54,
        unit: '个',
        purchaseNotes: '需冷藏',
        sort: 10,
        enabled: true,
        properties: [
          {
            id: 'size',
            name: '磅数',
            childsCurGoods: [
              { id: 's4', name: '4寸', priceDelta: 0 },
              { id: 's6', name: '6寸', priceDelta: 34 },
              { id: 's8', name: '8寸', priceDelta: 74 }
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
        // 2026-10-09：原名 g_soldout（库存 0 的「售罄商品」）。
        // 库存概念已整体删除，这里改成一个「无规格的低价商品」，
        // 用于验证无规格商品同样可以加购。
        _id: 'g_plain',
        categoryId: 'cat_fruit',
        name: '无规格小商品',
        pic: 'p3.jpg',
        pics: [{ pic: 'p3.jpg' }],
        minPrice: 10,
        unit: '个',
        sort: 20,
        enabled: true,
        properties: []
      },
      {
        _id: 'g_ice',
        categoryId: 'cat_ice',
        name: '冰淇淋蛋糕',
        pic: 'p4.jpg',
        pics: [{ pic: 'p4.jpg' }],
        minPrice: 88,
        unit: '个',
        sort: 10,
        enabled: true,
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
    console.log('  FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''))
  }
}

async function main() {
  // ---- 纯函数：价格计算 ----
  console.log('=== 1) 规格加价计算（基础价 + 加价）===')
  const g = seedData().goods[0]
  check('无规格 = 基础价 54', calcPrice(g, []) === 54, calcPrice(g, []))
  check(
    '4寸+草莓 = 54',
    calcPrice(g, [{ optionId: 'size', optionValueId: 's4' }, { optionId: 'flavor', optionValueId: 'f_straw' }]) === 54
  )
  check(
    '6寸+草莓 = 54+34 = 88',
    calcPrice(g, [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_straw' }]) === 88
  )
  check(
    '8寸+巧克力 = 54+74+10 = 138',
    calcPrice(g, [{ optionId: 'size', optionValueId: 's8' }, { optionId: 'flavor', optionValueId: 'f_choco' }]) === 138
  )
  check('只选一组也能算 = 54+34 = 88', calcPrice(g, [{ optionId: 'size', optionValueId: 's6' }]) === 88)

  // ---- 分类 ----
  console.log('\n=== 2) 分类列表 ===')
  const db = createMockDb(seedData())
  const ctx = { db, openid: 'user_A' }
  let r = await dispatch('categoryList', {}, ctx)
  check('返回成功', r.code === 0, r)
  check('只返回启用的分类（2 个，排除已停用）', r.data.length === 2, r.data)
  check('按 sort 升序', r.data[0].name === '水果蛋糕' && r.data[1].name === '冰淇淋蛋糕', r.data)
  check('分类带 id 字段供前端使用', r.data[0].id === 'cat_fruit', r.data[0])

  // ---- 商品列表 ----
  console.log('\n=== 3) 商品列表 ===')
  r = await dispatch('goodsList', { categoryId: 'cat_fruit' }, ctx)
  check('按分类过滤', r.code === 0 && r.data.result.length === 2, r.data)
  check('total 正确', r.data.total === 2)
  check('返回 result 字段（兼容前端）', Array.isArray(r.data.result))
  const item = r.data.result[0]
  check('商品含前端所需字段', ['id', 'name', 'pic', 'minPrice'].every((k) => item[k] !== undefined), item)
  // 2026-10-09：库存概念整体删除 —— 商品列表不应再返回 stores
  check('商品列表不再返回 stores 字段', item.stores === undefined, item.stores)

  r = await dispatch('goodsList', { categoryId: '' }, ctx)
  check('categoryId 为空 = 全部商品（3 个）', r.data.result.length === 3, r.data.result.length)
  r = await dispatch('goodsList', { categoryId: '0' }, ctx)
  check("categoryId='0' 也视为全部", r.data.result.length === 3)

  // ---- 商品详情 ----
  console.log('\n=== 4) 商品详情 ===')
  r = await dispatch('goodsDetail', { id: 'g_musi' }, ctx)
  check('返回 basicInfo', r.code === 0 && !!r.data.basicInfo, r)
  check('含前端读取的全部字段', ['id', 'name', 'minPrice', 'unit', 'purchaseNotes'].every((k) => r.data.basicInfo[k] !== undefined), r.data.basicInfo)
  // 2026-10-09：库存概念整体删除 —— 商品详情不应再返回 stores
  check('商品详情不再返回 stores 字段', r.data.basicInfo.stores === undefined, r.data.basicInfo.stores)
  check('含 pics / content / properties', Array.isArray(r.data.pics) && r.data.content && Array.isArray(r.data.properties))
  check('规格有 2 组（磅数/口味）', r.data.properties.length === 2, r.data.properties.length)

  // ---- 购物车 ----
  console.log('\n=== 5) 购物车 ===')
  r = await dispatch('cartInfo', {}, ctx)
  check('初始为空', r.code === 0 && r.data.number === 0)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)
  check('加入购物车成功', r.code === 0, r)
  check('单价 = 88+10 = 98', r.data.items[0].price === 98, r.data.items[0])

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 2, sku: [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)
  check('同规格累加为 3 件（不新增行）', r.data.number === 3 && r.data.items.length === 1, r.data)
  check('总价 = 98*3 = 294', r.data.price === 294, r.data.price)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 's4' }, { optionId: 'flavor', optionValueId: 'f_straw' }] }, ctx)
  check('不同规格新增一行（共 2 行）', r.data.items.length === 2, r.data.items.length)
  check('新行单价 = 54', r.data.items.find((i) => i.price === 54) !== undefined)

  // 2026-10-09：库存概念整体删除 —— 原先这里断言「售罄商品不能加购」「超库存时报错」，
  // 现在改为：无规格商品可以正常加购，且加购数量没有**库存**上限。
  // ⚠️ 2026-10-12 阶段 5.1 复核整改：加购数量现在与下单同口径（单次最多 99 件），
  //    原因不是库存，而是"购物车里不该出现永远下不了单的金额"
  //    （原来能加到 150 件 → 合计 13200 元，但 orderCreate 拒绝"最多 99 件"）。
  r = await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctx)
  check('无规格商品可以加购（原「已售罄」拦截已删除）', r.code === 0, r)

  r = await dispatch('cartAdd', { goodsId: 'g_plain', number: 500, sku: [] }, ctx)
  check('★ 单次加购超过 99 件被拒（与下单同口径，不是库存限制）',
    r.code !== 0 && /最多购买 99 件/.test(r.msg), r)

  r = await dispatch('cartAdd', { goodsId: 'g_plain', number: 98, sku: [] }, ctx)
  check('累加到 99 件可以加购（本店仍无库存概念）',
    r.code === 0 && r.data.items.some((i) => i.goodsId === 'g_plain' && i.number === 99), r.data)

  r = await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctx)
  check('★ 累加超过 99 件被拒（否则购物车里会出现下不了单的行）',
    r.code !== 0 && /最多购买 99 件/.test(r.msg), r)

  r = await dispatch('cartAdd', { goodsId: 'g_plain', number: 'abc', sku: [] }, ctx)
  check('★ 非数字数量被拒（原来会把购物车合计算成 NaN → 页面显示 ¥0）',
    r.code !== 0, r)

  r = await dispatch('cartModifyNumber', { key: 'no_such_key', number: 'abc' }, ctx)
  check('改数量时 key 不存在仍先报"购物车项不存在"', r.code !== 0, r)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 's6' }] }, ctx)
  check('缺规格组时报错（应为请选择口味）', r.code !== 0 && /口味/.test(r.msg), r)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 'BAD' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)
  check('规格值非法时报错', r.code !== 0, r)

  const cartRes = await dispatch('cartInfo', {}, ctx)
  const firstKey = cartRes.data.items[0].key
  r = await dispatch('cartModifyNumber', { key: firstKey, number: 1 }, ctx)
  check('修改数量成功', r.code === 0 && r.data.items.some((i) => i.key === firstKey && i.number === 1), r.data)
  r = await dispatch('cartModifyNumber', { key: firstKey, number: 0 }, ctx)
  check('数量为 0 时删除该项', r.code === 0 && !r.data.items.some((i) => i.key === firstKey), r.data)

  // ---- 用户隔离 ----
  console.log('\n=== 6) 多用户隔离 ===')
  const ctxB = { db, openid: 'user_B' }
  r = await dispatch('cartInfo', {}, ctxB)
  check('用户 B 看不到用户 A 的购物车', r.data.number === 0, r.data)

  // ---- 下单 ----
  console.log('\n=== 7) 下单 ===')
  // 先把 A 的购物车清空重来
  await dispatch('cartRemoveAll', {}, ctx)
  await dispatch('cartAdd', { goodsId: 'g_musi', number: 2, sku: [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)

  r = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 2, propertyChildIds: 'size:s6,flavor:f_choco' }]),
    remark: '少糖',
    extJsonStr: JSON.stringify({ 配送方式: '自提', 自取时间: '15时30分' }),
    shopIdZt: 0,
    shopNameZt: '卿欢蛋糕'
  }, ctx)
  check('下单成功', r.code === 0, r)
  check('金额服务端重算 = 98*2 = 196', r.data.amountReal === 196, r.data)
  check('生成取餐码（订单号后 4 位）', /^\d{4}$/.test(r.data.pickupCode), r.data)
  const orderId = r.data.id

  r = await dispatch('goodsDetail', { id: 'g_musi' }, ctx)
  // 2026-10-09：库存概念整体删除 —— 下单不再扣减任何库存字段
  check('下单后商品数据不受影响（无库存可扣）', r.code === 0 && r.data.basicInfo.stores === undefined, r.data.basicInfo)

  r = await dispatch('cartInfo', {}, ctx)
  check('下单后购物车已清空', r.data.number === 0, r.data)

  // ---- 订单查询 ----
  console.log('\n=== 8) 订单查询 ===')
  r = await dispatch('orderList', { statusBatch: '0' }, ctx)
  check('订单列表返回 1 条', r.code === 0 && r.data.orderList.length === 1, r.data.orderList)
  check('goodsMap 有商品快照', !!r.data.goodsMap[orderId] && r.data.goodsMap[orderId].length === 1, r.data.goodsMap)
  check('订单含 property（规格文字）', r.data.goodsMap[orderId][0].property === '6寸 / 巧克力', r.data.goodsMap[orderId][0].property)

  r = await dispatch('orderDetail', { id: orderId }, ctx)
  check('订单详情可取', r.code === 0, r)
  check('extJson 保留配送方式', r.data.extJson['配送方式'] === '自提', r.data.extJson)
  const orderIdB = orderId
  r = await dispatch('orderDetail', { id: orderIdB }, ctxB)
  check('用户 B 无权查看 A 的订单', r.code !== 0 && /无权/.test(r.msg), r)

  // ---- 取消订单 ----
  // 2026-10-09：库存概念已删除，取消订单不再回补库存，只校验状态流转
  console.log('\n=== 9) 取消订单 ===')
  r = await dispatch('orderClose', { id: orderId }, ctx)
  check('取消成功', r.code === 0, r)
  r = await dispatch('orderDetail', { id: orderId }, ctx)
  check('订单状态为已取消', r.data.orderInfo.status === -1, r.data.orderInfo)

  // ---- 完成订单（2026-10-10 取代原扫码核销）----
  // 原第 10 节用下单用户直接核销未支付订单 —— 那正是被修掉的漏洞（任何人可核销他人订单）。
  // 现在：只有店主白名单能完成订单，且只允许 status 1 → 3。
  // 边界用例见 tests/test-security.js 的 SEC-2 小节。
  console.log('\n=== 10) 完成订单（需店主 + 已付款）===')
  r = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }]),
    extJsonStr: '{}', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
  }, ctx)
  const finishOrderId = r.data.id
  const SHOP_CFG = require('../cloudfunctions/api/shop-config')

  // (1) 普通用户完成 → 必须被拒（白名单为空）
  r = await dispatch('orderFinish', { id: finishOrderId }, ctx)
  check('普通用户完成订单被拒（无权限）', r.code !== 0, r)

  // (2) 加入白名单，但订单仍为「待支付」→ 仍必须被拒
  SHOP_CFG.adminOpenids.push(ctx.openid)
  r = await dispatch('orderFinish', { id: finishOrderId }, ctx)
  check('未支付订单不可完成', r.code !== 0, r)

  // (3) 模拟支付成功（status=1）后完成 → 成功
  const finishDoc = db._store.order.find((o) => o._id === finishOrderId)
  finishDoc.status = 1
  finishDoc.statusStr = '制作中'
  r = await dispatch('orderFinish', { id: finishOrderId }, ctx)
  check('已支付订单完成成功', r.code === 0, r)
  check('  记录完成人 finishBy', finishDoc.finishBy === ctx.openid, finishDoc.finishBy)
  r = await dispatch('orderFinish', { id: finishOrderId }, ctx)
  check('重复完成被拒', r.code !== 0 && /已完成/.test(r.msg), r)
  // 收尾：把白名单还原，避免影响后续小节
  SHOP_CFG.adminOpenids.length = 0

  // ---- 防改价 ----
  console.log('\n=== 11) 安全性：服务端不信任前端价格 ===')
  const db2 = createMockDb(seedData())
  const ctx2 = { db: db2, openid: 'user_hacker' }
  r = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s8,flavor:f_choco', price: 0.01, amount: 0.01 }]),
    extJsonStr: '{}', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
  }, ctx2)
  check('前端传 price:0.01 被忽略，服务端算 138', r.code === 0 && r.data.amountReal === 138, r.data)

  // ---- 错误处理 ----
  console.log('\n=== 12) 错误处理 ===')
  r = await dispatch('notExistAction', {}, ctx)
  check('未知 action 返回 404', r.code === 404, r)
  r = await dispatch('goodsDetail', {}, ctx)
  check('缺参数返回错误', r.code !== 0, r)

  // ---- 外送订单：服务端重算配送费 ----
  console.log('\n=== 13) 外送订单的配送费（服务端重算）===')
  {
    const SHOP = require('../shop-config').shop
    // 构造：距门店约 2 公里、在配送区域内的地址
    const nearAddr = {
      name: '张三',
      phone: '13800138000',
      province: '云南省',
      city: '昆明市',
      district: '安宁市',
      detail: '太平新城某小区1栋101',
      latitude: SHOP.latitude + 2 / 111.19,
      longitude: SHOP.longitude
    }
    const farAddr = Object.assign({}, nearAddr, {
      latitude: SHOP.latitude + 5 / 111.19
    })
    const outAddr = {
      name: '李四', phone: '13900139000',
      province: '云南省', city: '昆明市', district: '五华区', detail: '某路1号'
    }

    const dbD = createMockDb(seedData())
    const ctxD = { db: dbD, openid: 'user_delivery' }
    const goodsJson = JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s4,flavor:f_straw' }])
    // 注意：g_musi 的 4寸草莓 = 54 元
    // 有磅数规格 → 被识别为蛋糕，但 4寸 < 6寸，不享受蛋糕免运费
    // 54 元 >= 35 元门槛 → 3km 内免运费

    // (1) 2km + 54 元（满 35）→ 免运费
    let rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: nearAddr, freightAmount: 0,
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD)
    check('外送下单成功', rd.code === 0, rd)
    check('  满35元 → 运费 0', rd.data.freight === 0, rd.data)
    check('  总价 = 商品金额', rd.data.amountReal === 54, rd.data)
    check('  返回距离约 2km', Math.abs(rd.data.distanceKm - 2) < 0.15, rd.data.distanceKm)

    // (2) 篡改运费：前端声称运费 99，服务端应忽略
    const dbD2 = createMockDb(seedData())
    const ctxD2 = { db: dbD2, openid: 'user_hack2' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: nearAddr, freightAmount: 99,
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD2)
    check('前端传运费99被忽略（满35元应为0）', rd.code === 0 && rd.data.freight === 0, rd.data)

    // (3) 距离阶梯（店主 2026-10-14 给的规则）：5km → 10 元 / 6km+ → 18 元 / >8km → 待确认
    // 商品是 g_musi 的 4 寸草莓 = 54 元
    const dbD3 = createMockDb(seedData())
    const ctxD3 = { db: dbD3, openid: 'user_far' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: farAddr,
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD3)
    check('5km 仍可下单（3–5 公里档）', rd.code === 0, rd)
    check('★ 5km 按第二档收 10 元', rd.data.freight === 10, rd.data)
    check('  总额 = 商品 54 + 运费 10', rd.data.amountReal === 64, rd.data.amountReal)
    check('  文案为 ¥10', rd.data.freightText === '¥10', rd.data.freightText)

    // (3b) 6km → 第三档 18 元
    const dbD3b = createMockDb(seedData())
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery',
      address: Object.assign({}, nearAddr, { latitude: SHOP.latitude + 6 / 111.19 }),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbD3b, openid: 'user_far6' })
    check('★ 6km 按第三档收 18 元', rd.code === 0 && rd.data.freight === 18, rd.data)

    // (3c) 9km → 超出 8 公里：不拒绝下单，运费"待确认"（店主说要打电话沟通）
    const dbD3c = createMockDb(seedData())
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery',
      address: Object.assign({}, nearAddr, { latitude: SHOP.latitude + 9 / 111.19 }),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbD3c, openid: 'user_far9' })
    check('★ 9km 仍可下单（不拒绝）', rd.code === 0, rd)
    check('  运费待确认时金额按 0 计（不预收）', rd.data.freight === 0, rd.data)
    check('★ 标记 needsFreightConfirm（前端据此不拉起收银台，P1-5）',
      rd.data.needsFreightConfirm === true, rd.data)
    check('  文案说明要电话确认',
      String(rd.data.freightText).indexOf('确认') >= 0, rd.data.freightText)

    // (4) 区域外 → 拒绝下单
    const dbD4 = createMockDb(seedData())
    const ctxD4 = { db: dbD4, openid: 'user_out' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: outAddr,
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD4)
    check('区域外拒绝外送下单', rd.code !== 0, rd)
    // 2026-10-10：提示文案由配置决定（原来是含糊的「超出配送范围」），
    // 用配置值比对，改文案时不会false失败。
    check('  提示与配置的区域外文案一致',
      rd.msg === require('../cloudfunctions/api/delivery-config').area.outOfAreaTip,
      { msg: rd.msg })

    // (5) 外送但缺地址 → 拒绝
    const dbD5 = createMockDb(seedData())
    const ctxD5 = { db: dbD5, openid: 'user_noaddr' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery',
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD5)
    check('外送缺地址被拒绝', rd.code !== 0 && /地址/.test(rd.msg), rd)

    // (6) 自提订单不受配送规则影响
    const dbD6 = createMockDb(seedData())
    const ctxD6 = { db: dbD6, openid: 'user_pickup' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'pickup',
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD6)
    check('自提下单成功且运费 0', rd.code === 0 && rd.data.freight === 0, rd.data)
    check('  自提总价 = 商品金额', rd.data.amountReal === 54, rd.data)

    // (7) 订单里保存了地址快照
    const orderDoc = dbD._store.order[0]
    check('订单保存了收货地址', !!orderDoc.address && orderDoc.address.name === '张三', orderDoc.address)
    check('订单保存了配送方式', orderDoc.deliveryMode === 'delivery', orderDoc.deliveryMode)
    check('订单保存了商品金额与运费', orderDoc.goodsAmount === 54 && orderDoc.freight === 0, {
      goodsAmount: orderDoc.goodsAmount, freight: orderDoc.freight
    })
    check('订单金额 = 商品 + 运费', orderDoc.amountReal === orderDoc.goodsAmount + orderDoc.freight)
    check('订单无敏感内部字段 _goodsForQuote', !JSON.stringify(orderDoc.goods).includes('_goodsForQuote'))
  }

  // ---- 商品接口返回 isCake ----
  console.log('\n=== 14) 商品接口返回 isCake ===')
  {
    const dbE = createMockDb(seedData())
    const ctxE = { db: dbE, openid: 'user_goods' }
    let re = await dispatch('goodsList', {}, ctxE)
    const musi = re.data.result.find((g) => g.id === 'g_musi')
    check('列表返回 isCake 字段', musi && musi.isCake !== undefined, musi)
    check('有磅数规格的商品识别为蛋糕', musi.isCake === true, musi && musi.isCake)
    check('列表返回 properties 供解析尺寸', Array.isArray(musi.properties) && musi.properties.length > 0)

    re = await dispatch('goodsDetail', { id: 'g_musi' }, ctxE)
    check('详情返回 isCake', re.data.basicInfo.isCake === true, re.data.basicInfo)
  }

  // ---- 阶段 8：云库配送规则（app_config.delivery_rule）----
  console.log('\n=== 15) 阶段 8：云库配送规则在服务端生效 ===')
  {
    const SHOP = require('../shop-config').shop
    const CLOD_CFG = require('../cloudfunctions/api/delivery-config')
    const mkAddr = (km, detail) => ({
      name: '张三',
      phone: '13800138000',
      province: '云南省',
      city: '昆明市',
      district: '安宁市',
      detail: detail || '太平新城某小区1栋101',
      latitude: SHOP.latitude + km / 111.19,
      longitude: SHOP.longitude
    })
    const goodsJson = JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s4,flavor:f_straw' }])
    // g_musi 4寸草莓 = 54 元（< 6寸，不享受蛋糕免运费）
    const RULE = {
      area: { excludeKeywords: ['山水间'], excludedTip: '该小区暂不支持外送，请改自提' },
      freight: {
        tiers: [
          { maxKm: 3, fee: 5, freeAmount: 35 },
          { maxKm: 5, fee: 8, freeAmount: 60 },
          { maxKm: null, fee: null, freeAmount: null, tip: '运费待确认' }
        ]
      }
    }
    const dbWithRule = () => {
      const db = createMockDb(seedData())
      db._store.app_config = [{ _id: 'cfg_rule', key: 'delivery_rule', value: RULE }]
      return db
    }

    // (1) 4km + 54 元 → 命中第二档 8 元（默认规则下是"待确认" → 0）
    let dbR = dbWithRule()
    let rr = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: mkAddr(4),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbR, openid: 'user_rule1' })
    check('云库规则生效：4km 按第二档收 8 元', rr.code === 0 && rr.data.freight === 8, rr.data)
    check('  总额 = 商品 54 + 运费 8', rr.data.amountReal === 62, rr.data.amountReal)
    check('  订单里记下了运费与理由',
      dbR._store.order[0].freight === 8 && dbR._store.order[0].deliveryQuote.reason === 'within_paid',
      dbR._store.order[0].deliveryQuote)

    // (2) 不送区域黑名单 → 服务端拒单（前端改不掉）
    dbR = dbWithRule()
    rr = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: mkAddr(2, '太平新城山水间小区3栋'),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbR, openid: 'user_rule2' })
    check('★ 黑名单地址被服务端拒绝', rr.code !== 0, rr)
    check('  提示取自云库配置的 excludedTip', rr.msg === RULE.area.excludedTip, rr.msg)
    check('  没有生成订单', dbR._store.order.length === 0, dbR._store.order.length)

    // (3) 云库里没有规则 → 回退代码默认值（2km + 54 元 → 满 35 免运费）
    const dbNoRule = createMockDb(seedData())
    rr = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: mkAddr(2),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbNoRule, openid: 'user_rule3' })
    check('无规则时回退代码默认值（2km/54 元 → 免运费）',
      rr.code === 0 && rr.data.freight === 0, rr.data)

    // (4) 半截规则：只给了黑名单，其余仍按默认值（不能整体丢弃）
    const dbHalf = createMockDb(seedData())
    dbHalf._store.app_config = [{ _id: 'cfg_half', key: 'delivery_rule', value: { area: { excludeKeywords: ['某某花园'] } } }]
    rr = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: mkAddr(2),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbHalf, openid: 'user_rule4' })
    check('半截规则：未覆盖的运费仍用默认值（2km/54 元 → 免运费）',
      rr.code === 0 && rr.data.freight === 0, rr.data)

    // (5) 上一条规则不能污染下一个请求（云函数容器会复用）
    rr = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: mkAddr(2),
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: createMockDb(seedData()), openid: 'user_rule5' })
    check('★ 规则不跨请求残留（前一条是黑名单规则，这里仍能下单）',
      rr.code === 0 && rr.data.freight === 0, rr.data)

    // (6) appConfig 把完整规则下发给前端（前端据此显示运费）
    const cfgRes = await dispatch('appConfig', {}, { db: dbWithRule(), openid: 'user_rule6' })
    const dr = (cfgRes.data || []).find((x) => x.key === 'delivery_rule')
    check('★ appConfig 下发 delivery_rule', !!(dr && dr.value), cfgRes.data)
    check('  下发的是完整规则（含 area/distance/freight/cake/advance）',
      !!dr.value.area && !!dr.value.distance && !!dr.value.freight && !!dr.value.cake && !!dr.value.advance,
      dr.value && Object.keys(dr.value))
    check('  下发的是归一化后的阶梯（云库值已生效）',
      Array.isArray(dr.value.freight.tiers) && dr.value.freight.tiers[1].fee === 8,
      dr.value && dr.value.freight.tiers)
    check('  云库黑名单随之下发',
      JSON.stringify(dr.value.area.excludeKeywords) === JSON.stringify(['山水间']),
      dr.value.area.excludeKeywords)

    // (7) 无规则时下发的就是代码默认值（前端不必自己拼默认值）
    const cfgRes2 = await dispatch('appConfig', {}, { db: createMockDb(seedData()), openid: 'user_rule7' })
    const dr2 = (cfgRes2.data || []).find((x) => x.key === 'delivery_rule')
    check('无云库规则时下发代码默认阶梯',
      dr2.value.freight.tiers[0].fee === CLOD_CFG.freight.tiers[0].fee &&
      dr2.value.freight.tiers.length === CLOD_CFG.freight.tiers.length,
      dr2.value.freight.tiers)
  }

  // ---- 阶段 9：渠道差价 / 打包费 / 最少购买（默认关闭）----
  console.log('\n=== 16) 阶段 9：自取立减 / 打包费 / 最少购买 ===')
  {
    const SHOP = require('../shop-config').shop
    const nearAddr = {
      name: '张三', phone: '13800138000',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城某小区1栋101',
      latitude: SHOP.latitude + 1 / 111.19, longitude: SHOP.longitude
    }
    // g_musi 的 4寸草莓 = 54 元（不享受蛋糕免运费：4寸 < 6寸）
    const sku4 = [{ optionId: 'size', optionValueId: 's4' }, { optionId: 'flavor', optionValueId: 'f_straw' }]
    const cartKey = 'g_musi|flavor:f_straw,size:s4'
    const goodsJson = JSON.stringify([{ goodsId: 'g_musi', number: 2, propertyChildIds: 'size:s4,flavor:f_straw' }])

    // 每个用例一份独立库，并按需给 g_musi 打上阶段 9 的字段
    const mkDb = (patch) => {
      const db = createMockDb(seedData())
      if (patch) Object.assign(db._store.goods.find((g) => g._id === 'g_musi'), patch)
      return db
    }

    // (1) 默认关闭：没有新字段时，自提/外送金额一模一样（老行为不变）
    let dbS = mkDb()
    let ctxS = { db: dbS, openid: 'user_s9a' }
    let rs = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: sku4 }, ctxS)
    check('无新字段：cartAdd 成功且价 54', rs.code === 0 && rs.data.price === 54, rs.data)
    rs = await dispatch('cartInfo', { deliveryMode: 'pickup' }, ctxS)
    check('  自提模式下金额不变（pickupDiscount 未配置）', rs.data.price === 54, rs.data)
    check('  打包费合计为 0', rs.data.packingFee === 0, rs.data.packingFee)

    // (2) 自取立减 pickupDiscount = 10
    dbS = mkDb({ pickupDiscount: 10 })
    ctxS = { db: dbS, openid: 'user_s9b' }
    await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: sku4 }, ctxS)
    rs = await dispatch('cartInfo', { deliveryMode: 'delivery' }, ctxS)
    check('外送模式：按列表价 54', rs.data.price === 54, rs.data.price)
    rs = await dispatch('cartInfo', { deliveryMode: 'pickup' }, ctxS)
    check('★ 自提模式：立减 10 → 44', rs.data.price === 44, rs.data.price)
    check('  单个商品行也带上了 this 价格', rs.data.items[0].price === 44, rs.data.items[0])
    rs = await dispatch('cartInfo', {}, ctxS)
    check('★ 不带 deliveryMode：购物车与下单**同口径**（都按自提 → 立减后 44）',
      rs.data.price === 44, rs.data.price)

    // 自提下单：服务端按自提口径算 → 与 cartInfo(pickup) 一致
    const dbS2 = mkDb({ pickupDiscount: 10 })
    let r9 = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'pickup', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbS2, openid: 'user_s9c' })
    check('★ 自提下单：单价 44 × 2 = 88', r9.code === 0 && r9.data.amountReal === 88, r9.data)
    check('  订单快照里 item.price 也是 44（对账一致）',
      dbS2._store.order[0].goods[0].price === 44, dbS2._store.order[0].goods[0].price)

    // 外送下单：不立减（54×2=108 + 运费）
    const dbS3 = mkDb({ pickupDiscount: 10 })
    r9 = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: nearAddr, shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbS3, openid: 'user_s9d' })
    check('★ 外送下单：不立减（108 + 运费）',
      r9.code === 0 && r9.data.goodsAmount === 108, r9.data)

    // (3) 打包费 packingFee = 2 元/件
    const dbP = mkDb({ packingFee: 2 })
    const ctxP = { db: dbP, openid: 'user_s9e' }
    await dispatch('cartAdd', { goodsId: 'g_musi', number: 2, sku: sku4 }, ctxP)
    let rp = await dispatch('cartInfo', { deliveryMode: 'pickup' }, ctxP)
    check('★ 打包费合计 = 2 元/件 × 2 件 = 4', rp.data.packingFee === 4, rp.data.packingFee)
    check('  商品行也带每件打包费（前端提示用）', rp.data.items[0].packingFee === 2, rp.data.items[0].packingFee)
    rp = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'pickup', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbP, openid: 'user_s9f' })
    check('★ 自提下单总额 = 54×2 + 打包费 4 = 112', rp.code === 0 && rp.data.amountReal === 112, rp.data)
    check('  订单里单独记了 packingFee', rp.data.packingFee === 4, rp.data.packingFee)
    check('  订单文档也存了 packingFee（订单详情页据此单列一行）',
      dbP._store.order[0].packingFee === 4, dbP._store.order[0].packingFee)

    // 打包费 + 自取立减 + 外送运费 三者叠加
    const dbMix = mkDb({ pickupDiscount: 10, packingFee: 2 })
    rp = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'pickup', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: dbMix, openid: 'user_s9g' })
    check('★ 立减与打包费叠加：44×2 + 2×2 = 92', rp.code === 0 && rp.data.amountReal === 92, rp.data)
    const mixOrder = dbMix._store.order[0]
    check('  订单快照三者齐全（goodsAmount / packingFee / freight）',
      mixOrder.goodsAmount === 88 && mixOrder.packingFee === 4 && mixOrder.freight === 0, mixOrder)

    // (4) 最少购买份数 minBuyNumber = 2
    const dbM = mkDb({ minBuyNumber: 2 })
    const ctxM = { db: dbM, openid: 'user_s9h' }
    let rm = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: sku4 }, ctxM)
    check('★ 加购 1 份（少于起购量 2）→ 拒绝', rm.code !== 0 && rm.msg.indexOf('最少购买 2 份') >= 0, rm)
    rm = await dispatch('cartAdd', { goodsId: 'g_musi', number: 2, sku: sku4 }, ctxM)
    check('  加购 2 份 → 成功', rm.code === 0, rm)
    rm = await dispatch('cartModifyNumber', { key: cartKey, number: 1 }, ctxM)
    check('★ 把数量改成 1（低于起购量）→ 拒绝', rm.code !== 0 && rm.msg.indexOf('最少购买 2 份') >= 0, rm)
    rm = await dispatch('cartModifyNumber', { key: cartKey, number: 3 }, ctxM)
    check('  改成 3 → 成功', rm.code === 0 && rm.data.items[0].number === 3, rm.data)
    rm = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s4,flavor:f_straw' }]),
      extJsonStr: '{}', deliveryMode: 'pickup', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db: mkDb({ minBuyNumber: 2 }), openid: 'user_s9i' })
    check('★ 绕过前端直接下单 1 份 → 服务端也拒绝（兜底）',
      rm.code !== 0 && rm.msg.indexOf('最少购买 2 份') >= 0, rm)

    // 商家后来调高起购量 → 购物车里旧的行要能被提前标出"不可下单"
    const dbOld = createMockDb(seedData())
    await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: sku4 }, { db: dbOld, openid: 'user_s9j' })
    Object.assign(dbOld._store.goods.find((g) => g._id === 'g_musi'), { minBuyNumber: 3 })
    const rOld = await dispatch('cartInfo', { deliveryMode: 'pickup' }, { db: dbOld, openid: 'user_s9j' })
    check('★ 起购量被调高后，购物车该项标记为不可下单并说明原因',
      rOld.data.items[0].unavailable === true &&
      String(rOld.data.items[0].unavailableReason).indexOf('最少购买 3 份') >= 0,
      rOld.data.items[0])

    // (5) 边界：立减大于等于价格时不能出现负价
    const H = require('../cloudfunctions/api/handlers')
    check('★ 立减 ≥ 价格 → 按 0 计，不出负价',
      H.calcPrice({ minPrice: 10, pickupDiscount: 30 }, [], 'pickup') === 0,
      H.calcPrice({ minPrice: 10, pickupDiscount: 30 }, [], 'pickup'))
    check('  未配置时 packingFeeOf / minBuyNumberOf 回落到 0 / 1',
      H.packingFeeOf({}) === 0 && H.minBuyNumberOf({}) === 1 &&
      H.packingFeeOf({ packingFee: -1 }) === 0 && H.minBuyNumberOf({ minBuyNumber: 0 }) === 1)
  }

  // ---- 阶段 10 第一块：店主视角订单列表（T-3）----
  console.log('\n=== 17) 店主视角订单列表（orderAdminList）===')
  {
    const SHOP = require('../shop-config').shop
    const SHOP_CFG = require('../cloudfunctions/api/shop-config')
    const db = createMockDb(seedData())
    const goodsJson = JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }])
    const nearAddr = {
      name: '张三', phone: '13800138000',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城某小区1栋101',
      latitude: SHOP.latitude + 1 / 111.19, longitude: SHOP.longitude
    }
    const extDelivery = JSON.stringify({
      配送方式: '外送', 收货人: '张三', 收货电话: '13800138000',
      收货地址: '云南省昆明市安宁市太平新城某小区1栋101',
      期望送达时间: '2026-10-15 15:00', 配送距离: '1公里', 运费: '免配送费'
    })
    const extPickup = JSON.stringify({
      配送方式: '自提', 自提门店: '卿欢蛋糕', 联络电话: '13900139000', 自取时间: '2026-10-15 16:00'
    })

    // 顾客 A：外送单；顾客 B：自提单
    const ra = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: extDelivery,
      deliveryMode: 'delivery', address: nearAddr, shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db, openid: 'user_cust_A' })
    check('前置：顾客 A 外送下单成功', ra.code === 0, ra)
    const rb = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: extPickup,
      deliveryMode: 'pickup', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, { db, openid: 'user_cust_B' })
    check('前置：顾客 B 自提下单成功', rb.code === 0, rb)

    // (1) 普通用户 → 拒绝（白名单为空）
    const ctxShop = { db, openid: 'user_shop_owner' }
    let r = await dispatch('orderAdminList', {}, ctxShop)
    check('★ 非店主调用被拒（服务端鉴权）', r.code !== 0, r)
    r = await dispatch('orderAdminList', {}, { db, openid: 'user_cust_A' })
    check('  顾客自己也不能用这个接口看别人的单', r.code !== 0, r)

    // (2) 加入白名单后：能看到**所有顾客**的订单
    SHOP_CFG.adminOpenids.push('user_shop_owner')
    r = await dispatch('orderAdminList', {}, ctxShop)
    check('★ 店主能看到全部顾客订单（2 单）', r.code === 0 && r.data.total === 2, r.data && r.data.total)
    const dates = r.data.orderList.map((o) => o.dateAdd)
    check('  按时间倒序（dateAdd 非递增；同一毫秒下顺序不保证）',
      dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates)

    const deliv = r.data.orderList.find((o) => o.deliveryMode === 'delivery')
    const pick = r.data.orderList.find((o) => o.deliveryMode === 'pickup')
    check('★ 外送单带上收货人/电话/地址（店主才能送或叫跑腿）',
      deliv.contactName === '张三' && deliv.contactPhone === '13800138000' &&
      deliv.addressText.indexOf('太平新城') >= 0, deliv)
    check('  外送单带上结构化地址（含经纬度，供一键导航）',
      !!deliv.address && typeof deliv.address.latitude === 'number', deliv.address)
    check('★ 自提单回退用联络电话，且期望时间取自「自取时间」',
      pick.contactPhone === '13900139000' && pick.expectTime === '2026-10-15 16:00', pick)
    check('  带上取餐码与状态文案', !!pick.pickupCode && pick.statusStr === '待支付', pick)
    check('  带上商品摘要（列表页一行显示）', !!pick.goodsSummary && pick.goodsSummary.indexOf('×1') >= 0, pick.goodsSummary)
    check('  金额字段齐全（实付/商品/打包费/运费）',
      typeof pick.amountReal === 'number' && typeof pick.goodsAmount === 'number' &&
      typeof pick.packingFee === 'number' && typeof pick.freight === 'number', pick)
    check('★ 不返回顾客 _openid（店主不需要，少一份可泄露标识）',
      pick._openid === undefined && deliv._openid === undefined)
    check('  各状态数量（statusCounts）随列表一起返回',
      r.data.statusCounts && r.data.statusCounts['0'] === 2, r.data.statusCounts)

    // (3) 状态过滤
    const paidOrder = db._store.order.find((o) => o.orderNumber === rb.data.orderNumber)
    paidOrder.status = 1
    paidOrder.statusStr = '制作中'
    r = await dispatch('orderAdminList', { statusBatch: '1' }, ctxShop)
    check('★ 按状态过滤（只看制作中）', r.data.total === 1 && r.data.orderList[0].status === 1, r.data.total)
    check('  状态文案由服务端现算（不信任库里的 statusStr）', r.data.orderList[0].statusStr === '制作中')
    r = await dispatch('orderAdminList', { statusBatch: '0,1' }, ctxShop)
    check('  多状态过滤', r.data.total === 2, r.data.total)

    // (4) 分页与上限
    r = await dispatch('orderAdminList', { pageSize: 1 }, ctxShop)
    check('★ 分页：pageSize=1 → 返回 1 条但 total=2',
      r.data.orderList.length === 1 && r.data.total === 2, r.data)
    r = await dispatch('orderAdminList', { pageSize: 1, page: 2 }, ctxShop)
    check('  第 2 页返回剩下的 1 条', r.data.orderList.length === 1 && r.data.page === 2, r.data.page)
    r = await dispatch('orderAdminList', { pageSize: 999 }, ctxShop)
    check('★ pageSize 上限 50（防止一次拉爆）', r.data.pageSize === 50, r.data.pageSize)

    // (5) 读取兜底：店主视角会把**别人**超时未支付的单也取消掉
    const staleOrder = db._store.order.find((o) => o.deliveryMode === 'pickup')
    staleOrder.dateAdd = Date.now() - 60 * 60 * 1000 // 1 小时前
    staleOrder.status = 0
    r = await dispatch('orderAdminList', {}, ctxShop)
    check('★ 店主打开列表时，超时未支付的顾客订单被自动取消（不依赖定时触发器）',
      db._store.order.find((o) => o._id === staleOrder._id).status === -1,
      db._store.order.map((o) => o.status))

    // 收尾：还原白名单，避免影响后续小节
    SHOP_CFG.adminOpenids.length = 0
  }

  // ---- 2026-10-14 用户端全面审查的整改回归 ----
  console.log('\n=== 18) 审查整改：规格/配送方式/期望时间/输入校验/清车 ===')
  {
    const SHOP = require('../shop-config').shop
    const H = require('../cloudfunctions/api/handlers')
    const SHOP_CFG = require('../cloudfunctions/api/shop-config')
    const nearAddr = {
      name: '张三', phone: '13800138000',
      province: '云南省', city: '昆明市', district: '安宁市',
      detail: '太平新城某小区1栋101',
      latitude: SHOP.latitude + 1 / 111.19, longitude: SHOP.longitude
    }
    const oneGoods = (num) => JSON.stringify([{ goodsId: 'g_musi', number: num || 1, propertyChildIds: 'size:s4,flavor:f_straw' }])
    // 明天中午 12:00（营业时间内、且远超 3 小时）——用于"合法期望时间"的用例
    const tomorrowNoon = (() => {
      const d = new Date(Date.now() + 24 * 3600 * 1000)
      d.setHours(12, 0, 0, 0)
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' 12:00'
    })()
    const mkCtx = (patch) => {
      const db = createMockDb(seedData())
      if (patch) Object.assign(db._store.goods.find((g) => g._id === 'g_musi'), patch)
      return { db, openid: 'user_audit' }
    }

    // (1) 同一规格组多值 → 必须拒绝（原来能下单、且订单规格文字与计价不一致）
    let r = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s4,size:s8,flavor:f_straw' }]),
      extJsonStr: '{}', deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('★ 同一规格组选了两项 → 拒绝（原来能下单、还按 4 寸计价却写"4寸/8寸"）',
      r.code !== 0 && /只能选一项/.test(r.msg), r)
    r = await dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s4,size:s4,flavor:f_straw' }]),
      extJsonStr: '{}', deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('  同组同一个值重复传也算多选 → 拒绝', r.code !== 0, r)

    // (2) cartAdd 伪造多余规格组 → 与 orderCreate 同口径拒绝（原来能加购，随后整单下不了）
    r = await dispatch('cartAdd', {
      goodsId: 'g_musi', number: 1,
      sku: [{ optionId: 'size', optionValueId: 's4' }, { optionId: 'flavor', optionValueId: 'f_straw' }, { optionId: 'fake', optionValueId: 'x' }]
    }, mkCtx())
    check('★ 加购时伪造规格组 → 拒绝（原来能加进购物车，然后整单被拦死）',
      r.code !== 0 && /规格参数有误/.test(r.msg), r)

    // (3) 配送方式：非枚举值拒绝；缺省时按"有没有地址"推断（不再静默丢地址）
    check('★ deliveryMode 非枚举值（DELIVERY）→ 拒绝，不再静默当自提把地址丢掉',
      H.resolveDeliveryMode({ deliveryMode: 'DELIVERY', address: nearAddr }) === null)
    check('  缺省 + 带地址 → 按外送（地址不会被丢）',
      H.resolveDeliveryMode({ address: nearAddr }) === 'delivery')
    check('  缺省 + 无地址 → 按自提', H.resolveDeliveryMode({}) === 'pickup')
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'DELIVERY',
      address: nearAddr, expectTime: tomorrowNoon
    }, mkCtx())
    check('  非法 deliveryMode 下单 → 明确报错', r.code !== 0 && /配送方式/.test(r.msg), r)
    let dbAddr = createMockDb(seedData())
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', address: nearAddr, expectTime: tomorrowNoon
    }, { db: dbAddr, openid: 'user_audit2' })
    check('  缺省 deliveryMode + 带地址 → 落库为外送且保留地址',
      r.code === 0 && dbAddr._store.order[0].deliveryMode === 'delivery' && !!dbAddr._store.order[0].address,
      dbAddr._store.order[0] && dbAddr._store.order[0].deliveryMode)

    // (4) 期望时间的服务端权威校验（原来服务端一行都不校验）
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup',
      expectTime: '2000-01-01 03:00'
    }, mkCtx())
    check('★ 过去时间 + 非营业时间下单 → 服务端拒绝（原来直接成功）', r.code !== 0, r)
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup', expectTime: 'not-a-time'
    }, mkCtx())
    check('★ 期望时间格式非法 → 拒绝', r.code !== 0 && /期望时间/.test(r.msg), r)
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('  合法的明天中午 → 通过', r.code === 0, r)

    // (4b) 2026-10-19 P1-4 补漏：含蛋糕但**省略**期望时间 → 拒绝（原来只 warn，可绕过 3 小时）
    r = await H.dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup'
    }, mkCtx())
    check('★ 含蛋糕但没带期望时间 → 拒绝（不再只 warn）',
      r.code !== 0 && /期望时间/.test(r.msg), r)

    // (4c) 2026-10-19 P1-4：行数上限 / extJson 超长 / 外送电话校验
    r = await H.dispatch('orderCreate', {
      goodsJsonStr: JSON.stringify(Array.from({ length: 51 }, () => ({ goodsId: 'g_plain', number: 1 }))),
      extJsonStr: '{}', deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('★ 单次下单行数超过 50 → 拒绝（防恶意放大数据库调用）',
      r.code !== 0 && /最多 50/.test(r.msg), r)
    r = await H.dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1),
      extJsonStr: JSON.stringify({ x: 'y'.repeat(5000) }),
      deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('★ extJson 超长（>4KB）→ 拒绝', r.code !== 0 && /扩展信息过长/.test(r.msg), r)
    r = await H.dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'delivery',
      address: Object.assign({}, nearAddr, { phone: '123' }), expectTime: tomorrowNoon
    }, mkCtx())
    check('★ 外送收货电话不是 11 位手机号 → 拒绝（P1-4）',
      r.code !== 0 && /收货电话/.test(r.msg), r)
    r = await H.dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: JSON.stringify({ 联络电话: 'abc' }),
      deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('★ 自提联系电话格式非法 → 拒绝（P1-4）',
      r.code !== 0 && /联系电话/.test(r.msg), r)

    // (5) 备注类型/长度（原来 30 万字符也能入库并把店主端响应撑到 5MB+）
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup',
      expectTime: tomorrowNoon, remark: 'x'.repeat(300000)
    }, mkCtx())
    check('★ 超长备注（30 万字符）→ 拒绝', r.code !== 0 && /备注/.test(r.msg), r)
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup',
      expectTime: tomorrowNoon, remark: { evil: true }
    }, mkCtx())
    check('  备注传对象 → 拒绝', r.code !== 0, r)
    r = await dispatch('orderCreate', {
      goodsJsonStr: oneGoods(1), extJsonStr: JSON.stringify(['not-an-object']),
      deliveryMode: 'pickup', expectTime: tomorrowNoon
    }, mkCtx())
    check('  extJson 传数组 → 归一化成 {}，不影响下单', r.code === 0, r)

    // (6) 只清本单的商品行（原来清整车 → 顾客没下单的商品凭空消失）
    {
      const db = createMockDb(seedData())
      const ctx = { db, openid: 'user_audit3' }
      await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 's4' }, { optionId: 'flavor', optionValueId: 'f_straw' }] }, ctx)
      await dispatch('cartAdd', { goodsId: 'g_plain', number: 3, sku: [] }, ctx)
      const before = db._store.cart.length
      const rc = await dispatch('orderCreate', {
        goodsJsonStr: oneGoods(1), extJsonStr: '{}', deliveryMode: 'pickup', expectTime: tomorrowNoon
      }, ctx)
      check('前置：下单成功', rc.code === 0, rc)
      check('★ 只清掉本单的商品行，购物车里其它商品保留（原来清整车）',
        db._store.cart.length === before - 1 && db._store.cart.every((c) => c.goodsId !== 'g_musi'),
        db._store.cart.map((c) => c.goodsId))
    }

    // (7) 分发层加固：原型链、身份缺失、内部错误不外显
    r = await dispatch('constructor', {}, { db: createMockDb(seedData()), openid: 'u' })
    check('★ action="constructor" → 404（原来会把 payload 原样回显）', r.code === 404, r)
    r = await dispatch('goodsList', {}, { db: createMockDb(seedData()) })
    check('★ ctx.openid 缺失 → 401（原来会写出 _openid: undefined 的订单）',
      r.code === 401 && /身份/.test(r.msg), r)
    r = await dispatch('orderCreate', { goodsJsonStr: '{"length":2}' }, { db: createMockDb(seedData()), openid: 'u' })
    check('★ 非法结构（非数组）→ 业务错误，且不泄露实现细节',
      r.code !== 0 && r.msg.indexOf('iterable') < 0 && r.msg.indexOf('商品数据') >= 0, r)
  }

  // ---- 2026-10-14 backlog：并发加购不丢数量 + 下单幂等（弱网重试不出两张单）----
  console.log('\n=== 19) 并发与幂等（backlog：原子加购 / clientOrderToken）===')
  {
    const H = require('../cloudfunctions/api/handlers')
    const tomorrowNoon = (() => {
      const d = new Date(Date.now() + 24 * 3600 * 1000)
      d.setHours(12, 0, 0, 0)
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' 12:00'
    })()
    const sku = [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_choco' }]
    // 下单载荷工厂：默认带幂等键，便于逐条覆盖
    const mkOrder = (token, extra) => Object.assign({
      goodsJsonStr: JSON.stringify([{ goodsId: 'g_musi', number: 1, propertyChildIds: 'size:s6,flavor:f_choco' }]),
      extJsonStr: '{}',
      deliveryMode: 'pickup',
      expectTime: tomorrowNoon,
      clientOrderToken: token
    }, extra || {})

    // ===== (1) 并发加购：空车两路同时（原来是"两个请求都读到没有 → 各插一行"）=====
    const dbC = createMockDb(seedData())
    const ctxC = { db: dbC, openid: 'user_conc' }
    const conc = await Promise.all([
      dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku }, ctxC),
      dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku }, ctxC)
    ])
    check('并发加购：两个请求都返回成功', conc[0].code === 0 && conc[1].code === 0, conc)
    check('★ 并发加购不丢数量：只有一行、数量 = 2（原来会插出两行）',
      dbC._store.cart.length === 1 && dbC._store.cart[0].number === 2,
      dbC._store.cart.map((c) => ({ id: c._id, n: c.number })))
    check('★ 购物车行的 _id 由 (openid,key) 稳定生成（并发插入才挡得住第二行）',
      /^c[0-9a-f]{24}$/.test(String(dbC._store.cart[0]._id)), dbC._store.cart[0]._id)

    // ===== (2) 行已存在时并发累加（原来是"都读到 2、各自写 3"）=====
    const inc2 = await Promise.all([
      dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku }, ctxC),
      dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku }, ctxC)
    ])
    check('★ 行已存在时并发累加不丢数量：2 + 1 + 1 = 4（不是 3）',
      inc2[0].code === 0 && inc2[1].code === 0 &&
      dbC._store.cart.length === 1 && dbC._store.cart[0].number === 4,
      dbC._store.cart.map((c) => c.number))

    // ===== (3) 并发下不得越过单次上限 99 =====
    const dbMax = createMockDb(seedData())
    const ctxMax = { db: dbMax, openid: 'user_max' }
    await dispatch('cartAdd', { goodsId: 'g_plain', number: 98, sku: [] }, ctxMax)
    const maxRes = await Promise.all([
      dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxMax),
      dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxMax)
    ])
    check('★ 并发下不会超上限：一个成功、一个被拒，最终正好 99',
      (maxRes[0].code === 0) !== (maxRes[1].code === 0) && dbMax._store.cart[0].number === 99,
      { codes: maxRes.map((x) => x.code), msgs: maxRes.map((x) => x.msg), n: dbMax._store.cart[0].number })

    // ===== (4) 历史行（自动 _id）仍走原子累加，不新增行 =====
    const dbLegacy = createMockDb(seedData())
    const legacyKey = H.makeCartKey('g_musi', sku)
    dbLegacy._store.cart = [{
      _id: 'id_legacy', _openid: 'user_legacy', key: legacyKey, goodsId: 'g_musi',
      price: 98, number: 3, sku: sku, dateAdd: 1
    }]
    const legRes = await dispatch('cartAdd', { goodsId: 'g_musi', number: 2, sku }, { db: dbLegacy, openid: 'user_legacy' })
    check('★ 历史行（自动 _id）照样原子累加、不新增行：3 + 2 = 5',
      legRes.code === 0 && dbLegacy._store.cart.length === 1 &&
      dbLegacy._store.cart[0]._id === 'id_legacy' && dbLegacy._store.cart[0].number === 5,
      dbLegacy._store.cart)

    // ===== (5) 幂等：同一 token 顺序重试 = 弱网"响应丢了再点一次" =====
    const dbI = createMockDb(seedData())
    const ctxI = { db: dbI, openid: 'user_idem' }
    const first = await dispatch('orderCreate', mkOrder('tok_idem_00001'), ctxI)
    check('幂等：首次下单成功且 duplicated=false',
      first.code === 0 && first.data.duplicated === false, first)
    const again = await dispatch('orderCreate', mkOrder('tok_idem_00001'), ctxI)
    check('★ 幂等：同一 token 再提交 → 返回同一张单，不新建',
      again.code === 0 && again.data.duplicated === true &&
      again.data.id === first.data.id && again.data.orderNumber === first.data.orderNumber,
      { again: again.data, first: first.data })
    check('★ 幂等：库里只有 1 张单', dbI._store.order.length === 1, dbI._store.order.length)
    check('幂等键落库（便于排查与重放）',
      dbI._store.order[0].clientOrderToken === 'tok_idem_00001', dbI._store.order[0].clientOrderToken)

    // ===== (6) 幂等：真·并发重复提交（两个请求同时到）=====
    const dbR = createMockDb(seedData())
    const ctxR = { db: dbR, openid: 'user_race' }
    const race = await Promise.all([
      dispatch('orderCreate', mkOrder('tok_race_00001'), ctxR),
      dispatch('orderCreate', mkOrder('tok_race_00001'), ctxR)
    ])
    check('★ 并发同一 token：库里只落一张单', dbR._store.order.length === 1,
      dbR._store.order.map((o) => o._id))
    check('★ 并发同一 token：两个响应都成功且指向同一张单',
      race[0].code === 0 && race[1].code === 0 && race[0].data.id === race[1].data.id,
      race.map((x) => ({ code: x.code, id: x.data && x.data.id })))
    check('并发同一 token：恰好一个是重放（duplicated 一真一假）',
      race[0].data.duplicated !== race[1].data.duplicated,
      race.map((x) => x.data.duplicated))

    // ===== (7) 不同 token = 两笔不同的单（幂等键不会把正常下单合并掉）=====
    const dbTwo = createMockDb(seedData())
    const ctxTwo = { db: dbTwo, openid: 'user_two' }
    const t1 = await dispatch('orderCreate', mkOrder('tok_two_000001'), ctxTwo)
    const t2 = await dispatch('orderCreate', mkOrder('tok_two_000002'), ctxTwo)
    check('不同 token 生成两张单',
      t1.code === 0 && t2.code === 0 && t1.data.id !== t2.data.id && dbTwo._store.order.length === 2,
      dbTwo._store.order.length)

    // ===== (8) 兼容：不带幂等键（老客户端）仍能下单 =====
    const dbNoTok = createMockDb(seedData())
    const noTok = await dispatch('orderCreate', mkOrder(undefined), { db: dbNoTok, openid: 'user_notok' })
    check('不带幂等键仍能下单（兼容老客户端，只记日志）',
      noTok.code === 0 && noTok.data.duplicated === false && dbNoTok._store.order.length === 1, noTok)

    // ===== (9) 非法幂等键 → 拒绝（不能靠塞坏值绕过幂等）=====
    const dbBad = createMockDb(seedData())
    const ctxBad = { db: dbBad, openid: 'user_badtok' }
    const badShort = await dispatch('orderCreate', mkOrder('abc'), ctxBad)
    check('★ 幂等键过短 → 拒绝，且不生成订单',
      badShort.code !== 0 && dbBad._store.order.length === 0, badShort)
    const badLong = await dispatch('orderCreate', mkOrder('x'.repeat(65)), ctxBad)
    check('★ 幂等键过长 → 拒绝，且不生成订单',
      badLong.code !== 0 && dbBad._store.order.length === 0, badLong)
    const badChar = await dispatch('orderCreate', mkOrder('bad token!'), ctxBad)
    check('★ 幂等键含非法字符 → 拒绝', badChar.code !== 0 && dbBad._store.order.length === 0, badChar)

    // ===== (10) 幂等重放不做副作用：不再清购物车 =====
    const dbS = createMockDb(seedData())
    const ctxS = { db: dbS, openid: 'user_side' }
    const pSide = mkOrder('tok_side_00001')
    const s1 = await dispatch('orderCreate', pSide, ctxS)
    await dispatch('cartAdd', { goodsId: 'g_plain', number: 1, sku: [] }, ctxS)
    const s2 = await dispatch('orderCreate', pSide, ctxS)
    check('★ 幂等重放不再清购物车（顾客后来加的商品不会被误删）',
      s1.code === 0 && s2.code === 0 && s2.data.duplicated === true &&
      dbS._store.order.length === 1 && dbS._store.cart.length === 1,
      { orders: dbS._store.order.length, cart: dbS._store.cart })

    // ===== (11) 幂等键按用户隔离：B 拿不到 A 的单 =====
    const dbIso = createMockDb(seedData())
    const isoA = await dispatch('orderCreate', mkOrder('tok_iso_000001'), { db: dbIso, openid: 'user_iso_a' })
    const isoB = await dispatch('orderCreate', mkOrder('tok_iso_000001'), { db: dbIso, openid: 'user_iso_b' })
    check('★ 幂等键按 openid 隔离：B 用同一 token 不会拿到 A 的单',
      isoA.code === 0 && isoB.code === 0 && isoB.data.id !== isoA.data.id &&
      isoB.data.duplicated === false && dbIso._store.order.length === 2,
      { a: isoA.data.id, b: isoB.data.id, n: dbIso._store.order.length })

    // ===== (12) 平台不支持自定义 _id 时必须降级，而不是让顾客加不了购/下不了单 =====
    {
      const dbDeg = createMockDb(seedData())
      const origAdd = dbDeg.add.bind(dbDeg)
      dbDeg.add = async (col, data) => {
        if (data && data._id) throw new Error('custom _id not allowed')
        return origAdd(col, data)
      }
      const ctxDeg = { db: dbDeg, openid: 'user_degrade' }
      const d1 = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku }, ctxDeg)
      check('★ 环境不支持自定义 _id → 加购自动降级为默认 _id（不会加不了购）',
        d1.code === 0 && dbDeg._store.cart.length === 1, d1)
      const d2 = await dispatch('orderCreate', mkOrder('tok_deg_000001'), ctxDeg)
      check('★ 环境不支持自定义 _id → 下单自动降级（不会下不了单）',
        d2.code === 0 && dbDeg._store.order.length === 1, d2)
      const d3 = await dispatch('orderCreate', mkOrder('tok_deg_000001'), ctxDeg)
      check('  降级后顺序重试仍幂等（靠 token 查重兜底）',
        d3.code === 0 && d3.data.duplicated === true && dbDeg._store.order.length === 1, d3)
    }
  }

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
