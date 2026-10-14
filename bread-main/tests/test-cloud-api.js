/**
 * 云函数逻辑本地测试（用完可删）
 * ---------------------------------------------------------------------------
 * 目的：在没有 AppID、没有云环境的情况下，验证 handlers.js 的业务逻辑正确。
 * 原理：handlers.js 不依赖 wx-server-sdk，只要给它一个内存版 db 就能跑。
 * ---------------------------------------------------------------------------
 */
const { dispatch, calcPrice } = require('../cloudfunctions/api/handlers')

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

    // (3) 不满 35 元 → 收 5 元：本店最便宜的商品是 10 元的无规格小商品，
    //     但为保持既有用例的金额口径，这里直接验证「距离 5km」分支。
    // 2026-10-09：原文案里的「售罄」已随库存概念删除，仅更新说明，断言不变。
    // (3) 5km → 运费待确认（null → 服务端按 0 计，不阻塞下单）
    const dbD3 = createMockDb(seedData())
    const ctxD3 = { db: dbD3, openid: 'user_far' }
    rd = await dispatch('orderCreate', {
      goodsJsonStr: goodsJson, extJsonStr: '{}',
      deliveryMode: 'delivery', address: farAddr,
      shopIdZt: 0, shopNameZt: '卿欢蛋糕'
    }, ctxD3)
    check('5km 外仍可下单', rd.code === 0, rd)
    check('  运费待确认时金额按 0 计', rd.data.freight === 0, rd.data)
    check('  文案为运费待确认', rd.data.freightText === '运费待确认', rd.data.freightText)

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

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
