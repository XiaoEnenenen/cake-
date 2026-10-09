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
        stores: 20,
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
        _id: 'g_soldout',
        categoryId: 'cat_fruit',
        name: '售罄的商品',
        pic: 'p3.jpg',
        pics: [{ pic: 'p3.jpg' }],
        minPrice: 10,
        unit: '个',
        stores: 0,
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
        stores: 5,
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
  check('商品含前端所需字段', ['id', 'name', 'pic', 'minPrice', 'stores'].every((k) => item[k] !== undefined), item)

  r = await dispatch('goodsList', { categoryId: '' }, ctx)
  check('categoryId 为空 = 全部商品（3 个）', r.data.result.length === 3, r.data.result.length)
  r = await dispatch('goodsList', { categoryId: '0' }, ctx)
  check("categoryId='0' 也视为全部", r.data.result.length === 3)

  // ---- 商品详情 ----
  console.log('\n=== 4) 商品详情 ===')
  r = await dispatch('goodsDetail', { id: 'g_musi' }, ctx)
  check('返回 basicInfo', r.code === 0 && !!r.data.basicInfo, r)
  check('含前端读取的全部字段', ['id', 'name', 'minPrice', 'unit', 'stores', 'purchaseNotes'].every((k) => r.data.basicInfo[k] !== undefined), r.data.basicInfo)
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

  r = await dispatch('cartAdd', { goodsId: 'g_soldout', number: 1, sku: [] }, ctx)
  check('售罄商品不能加购', r.code !== 0 && /售罄/.test(r.msg), r)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 's6' }] }, ctx)
  check('缺规格组时报错（应为请选择口味）', r.code !== 0 && /口味/.test(r.msg), r)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 1, sku: [{ optionId: 'size', optionValueId: 'BAD' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)
  check('规格值非法时报错', r.code !== 0, r)

  r = await dispatch('cartAdd', { goodsId: 'g_musi', number: 999, sku: [{ optionId: 'size', optionValueId: 's6' }, { optionId: 'flavor', optionValueId: 'f_choco' }] }, ctx)
  check('超库存时报错', r.code !== 0 && /库存/.test(r.msg), r)

  const key = r.data && r.data.items ? null : null
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
  check('生成核销码', !!r.data.hxNumber, r.data)
  const orderId = r.data.id

  r = await dispatch('goodsDetail', { id: 'g_musi' }, ctx)
  check('库存已扣减 20→18', r.data.basicInfo.stores === 18, r.data.basicInfo.stores)

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

  // ---- 取消订单回补库存 ----
  console.log('\n=== 9) 取消订单回补库存 ===')
  r = await dispatch('orderClose', { id: orderId }, ctx)
  check('取消成功', r.code === 0, r)
  r = await dispatch('goodsDetail', { id: 'g_musi' }, ctx)
  check('库存回补 18→20', r.data.basicInfo.stores === 20, r.data.basicInfo.stores)
  r = await dispatch('orderDetail', { id: orderId }, ctx)
  check('订单状态为已取消', r.data.orderInfo.status === -1, r.data.orderInfo)

  // ---- 核销 ----
  console.log('\n=== 10) 核销 ===')
  r = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_ice', number: 1, propertyChildIds: '' }]),
    extJsonStr: '{}', shopIdZt: 0, shopNameZt: '卿欢蛋糕'
  }, ctx)
  const hx = r.data.hxNumber
  r = await dispatch('orderHx', { hxNumber: hx }, ctx)
  check('核销成功', r.code === 0, r)
  r = await dispatch('orderHx', { hxNumber: hx }, ctx)
  check('重复核销被拒', r.code !== 0 && /已核销/.test(r.msg), r)

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

    // (3) 不满 35 元 → 收 5 元（用售罄以外的低价商品不便构造，改用数量控制金额）
    //     g_ice 88 元无规格，1 件已满 35；用它反而不合适。
    //     这里用 4寸草莓 54 元无法低于 35，所以直接验证「距离 5km」分支。
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
    check('  提示超出配送范围', /超出配送范围/.test(rd.msg), rd.msg)

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

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
