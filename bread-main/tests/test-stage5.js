/**
 * 阶段 5 数据正确性回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 覆盖《实施步骤清单》阶段 5 的两条**数据**缺陷（页面体验另见 test-stage5-page.js）：
 *
 *   5.1 购物车价与结算价一致（报告 D-01）
 *       原实现：cartSummary 返回**加购时的价格快照**，orderCreate 按**数据库现价**重算
 *       → 探针实测「购物车显示 108 元、实付 400 元」。
 *       本测试用真实内存库复现该场景，并断言两处口径完全一致。
 *
 *   5.2 门店名单一来源（报告 D-06）
 *       原实现：云函数副本 shop-config.js **没有 name 字段** →
 *       `(SHOP.shop && SHOP.shop.name) || '卿欢蛋糕'` 永远走硬编码分支 →
 *       "门店名三个来源互不同步，改根目录配置首页标题不变"。
 *       本测试断言：副本与根配置的门店名一致、appConfig 下发值来自配置、
 *       handlers.js 里不再有硬编码店名。
 *
 * 运行：node tests/test-stage5.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const { dispatch } = require('../cloudfunctions/api/handlers')
const CLOUD_SHOP = require('../cloudfunctions/api/shop-config')
const ROOT_SHOP = require('../shop-config')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

// ===== 内存数据库（与 test-cloud-api.js / test-security.js 同一套）=====
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

// ===== 假数据：一个带规格的蛋糕（minPrice 54，6寸 +34 → 88）=====
function seedData() {
  return {
    goods: [
      {
        _id: 'g_cake',
        categoryId: 'cat_fruit',
        name: '慕斯围边水果小蛋糕',
        pic: 'p1.jpg',
        minPrice: 54,
        unit: '个',
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
          }
        ]
      }
    ],
    cart: [],
    order: []
  }
}

const SKU_6 = [{ optionId: 'size', optionValueId: 's6' }]

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
  console.log('=== 5.1 购物车价与结算价一致（缺陷 D-01）===')
  // =========================================================================
  const db = createMockDb(seedData())
  const ctx = { db, openid: 'user_A' }

  // 顾客加购：此时单价 88（54 + 6寸 34）
  let r = await dispatch('cartAdd', { goodsId: 'g_cake', number: 2, sku: SKU_6 }, ctx)
  check('加购成功，快照单价 = 88', r.code === 0 && r.data.items[0].price === 88, r.data && r.data.items)
  check('加购的 cart 文档里存的是当时的快照价 88', db._store.cart[0].price === 88, db._store.cart[0])
  check('没有改价：priceChanged 为 false', r.data.priceChanged === false, r.data.priceChanged)
  check('仍返回 snapshotPrice 供前端展示', r.data.items[0].snapshotPrice === 88, r.data.items[0])

  // 商家把基础价从 54 改到 200（加价不变 → 现价 234）
  await db.update('goods', 'g_cake', { minPrice: 200 })

  const cart = await dispatch('cartInfo', {}, ctx)
  check('★ 改价后购物车单价按**现价**重算 = 234（不再是快照 88）',
    cart.data.items[0].price === 234, cart.data.items[0])
  check('★ 改价后购物车合计 = 234 × 2 = 468（与下单同口径）',
    cart.data.price === 468, cart.data.price)
  check('priceChanged = true（前端据此提示"价格已更新"）', cart.data.priceChanged === true)
  check('priceChangedNames 带上商品名', (cart.data.priceChangedNames || []).indexOf('慕斯围边水果小蛋糕') >= 0,
    cart.data.priceChangedNames)
  check('snapshotPrice 仍是加购时的 88（可对比展示）', cart.data.items[0].snapshotPrice === 88)

  // ★ 核心：下单金额必须与购物车展示金额一致（这就是 D-01 的原始复现路径）
  const created = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_cake', number: 2, propertyChildIds: 'size:s6' }]),
    remark: '',
    extJsonStr: '{}',
    deliveryMode: 'pickup',
    // 2026-10-19 P1-4：含蛋糕订单必须带期望时间（远未来、营业时间内）
    expectTime: '2099-01-01 12:00'
  }, ctx)
  check('下单成功', created.code === 0, created)
  check('★ 实付金额 = 购物车展示金额（468），不再出现"看到 108 实付 400"',
    created.data.amountReal === cart.data.price && created.data.amountReal === 468,
    { amountReal: created.data.amountReal, cartPrice: cart.data.price })
  check('订单里的商品单价同样是现价 234',
    created.data && db._store.order[db._store.order.length - 1].goods[0].price === 234,
    db._store.order[db._store.order.length - 1].goods[0])

  // 改价后前端不再提示"价格变动"
  await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx)
  const cartAfter = await dispatch('cartInfo', {}, ctx)
  check('按新价重新加购后 priceChanged 归 false', cartAfter.data.priceChanged === false, cartAfter.data.priceChanged)

  // 商品被删除：只能退回快照价，并标注已下架
  const db2 = createMockDb(seedData())
  const ctx2 = { db: db2, openid: 'user_B' }
  await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx2)
  db2._store.goods = []
  const gone = await dispatch('cartInfo', {}, ctx2)
  check('商品被删除后退回快照价（否则整个购物车都算不出价）', gone.data.items[0].price === 88, gone.data.items[0])
  check('商品被删除时名称标注「（商品已下架）」', /已下架/.test(gone.data.items[0].name), gone.data.items[0].name)
  check('商品被删除时 priceChanged 不置 true（避免误导为"改价"）', gone.data.priceChanged === false)
  check('★ 商品被删除 → unavailable=true（前端据此禁止提交）', gone.data.items[0].unavailable === true, gone.data.items[0])
  check('★ 商品被删除 → 汇总 unavailable=true 并给出原因', gone.data.unavailable === true && /已下架/.test((gone.data.unavailableNames || []).join('')), gone.data.unavailableNames)

  // =========================================================================
  console.log('\n=== 5.1 边界（复核整改）：购物车里的项必须真的能下单 ===')
  // =========================================================================
  const db5 = createMockDb(seedData())
  const ctx5 = { db: db5, openid: 'user_E' }

  // ① 数量口径：与 orderCreate 同上限，且累加后也要在上限内
  let q = await dispatch('cartAdd', { goodsId: 'g_cake', number: 99, sku: SKU_6 }, ctx5)
  check('一次加 99 件可以（上限内）', q.code === 0 && q.data.items[0].number === 99, q.data && q.data.items)
  q = await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx5)
  check('★ 累加到 100 件被拒（购物车不允许出现"永远下不了单"的行）',
    q.code !== 0 && /最多购买 99 件/.test(q.msg), q)
  q = await dispatch('cartModifyNumber', { key: db5._store.cart[0].key, number: 150 }, ctx5)
  check('★ 改数量到 150 被拒（原来可以，之后 orderCreate 必然拒绝）',
    q.code !== 0 && /最多购买 99 件/.test(q.msg), q)
  q = await dispatch('cartModifyNumber', { key: db5._store.cart[0].key, number: 'abc' }, ctx5)
  check('★ 改数量传入非数字被拒（原来会把字符串写进库 → 合计算成 NaN）',
    q.code !== 0 && /数量不正确/.test(q.msg), q)
  q = await dispatch('cartAdd', { goodsId: 'g_cake', number: -1, sku: SKU_6 }, ctx5)
  check('加购负数被拒', q.code !== 0, q)

  // ② 下架商品：加购被拒 + 已在购物车里的项标 unavailable
  const db6 = createMockDb(seedData())
  const ctx6 = { db: db6, openid: 'user_F' }
  await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx6)
  await db6.update('goods', 'g_cake', { enabled: false })
  const off = await dispatch('cartInfo', {}, ctx6)
  check('★ 商品下架后购物车项 unavailable=true', off.data.items[0].unavailable === true, off.data.items[0])
  check('★ 下架原因明确（不是含糊的"改价"）',
    /已下架/.test(off.data.items[0].unavailableReason) && off.data.items[0].priceChanged === false,
    off.data.items[0])
  check('下架商品不能再加购', (await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx6)).code !== 0)
  const offOrder = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_cake', number: 1, propertyChildIds: 'size:s6' }]),
    deliveryMode: 'pickup'
  }, ctx6)
  check('下架商品下单仍被拒（与购物车标记一致）', offOrder.code !== 0 && /已下架/.test(offOrder.msg), offOrder)

  // ③ 规格被商家删掉：不能既显示一个假价格、又永远下不了单
  const db7 = createMockDb(seedData())
  const ctx7 = { db: db7, openid: 'user_G' }
  await dispatch('cartAdd', { goodsId: 'g_cake', number: 1, sku: SKU_6 }, ctx7)
  await db7.update('goods', 'g_cake', {
    properties: [{ id: 'size', name: '磅数', childsCurGoods: [{ id: 's4', name: '4寸', priceDelta: 0 }] }]
  })
  const badSku = await dispatch('cartInfo', {}, ctx7)
  check('★ 规格选项被删后购物车项 unavailable=true', badSku.data.items[0].unavailable === true, badSku.data.items[0])
  check('★ 原因指向"规格已变更"（顾客知道要去重新选规格）',
    /规格已变更/.test(badSku.data.items[0].unavailableReason), badSku.data.items[0].unavailableReason)
  check('规格失效时不再假装"价格已更新"', badSku.data.items[0].priceChanged === false)
  const badOrder = await dispatch('orderCreate', {
    goodsJsonStr: JSON.stringify([{ goodsId: 'g_cake', number: 1, propertyChildIds: 'size:s6' }]),
    deliveryMode: 'pickup'
  }, ctx7)
  check('规格失效下单被拒（与购物车标记一致）', badOrder.code !== 0, badOrder)

  // ④ 正常商品不受影响
  const db8 = createMockDb(seedData())
  const ctx8 = { db: db8, openid: 'user_H' }
  const normal = await dispatch('cartAdd', { goodsId: 'g_cake', number: 2, sku: SKU_6 }, ctx8)
  check('正常商品的项 unavailable=false', normal.data.items[0].unavailable === false && normal.data.unavailable === false,
    normal.data.items[0])

  // =========================================================================
  console.log('\n=== 5.2 门店名单一来源（缺陷 D-06）===')
  // =========================================================================
  check('根配置有门店名', !!(ROOT_SHOP.shop && ROOT_SHOP.shop.name), ROOT_SHOP.shop)
  check('★ 云函数副本 shop-config.js 也必须有 name（之前缺失导致硬编码兜底）',
    !!(CLOUD_SHOP.shop && CLOUD_SHOP.shop.name), CLOUD_SHOP.shop)
  check('★ 两处门店名完全一致', CLOUD_SHOP.shop.name === ROOT_SHOP.shop.name,
    { cloud: CLOUD_SHOP.shop.name, root: ROOT_SHOP.shop.name })
  check('门店名非空', String(CLOUD_SHOP.shop.name || '').trim().length > 0)

  const db3 = createMockDb({ goods: [], cart: [], order: [] })
  const ctx3 = { db: db3, openid: 'user_C' }
  const cfg = await dispatch('appConfig', {}, ctx3)
  const mall = (cfg.data || []).find((x) => x.key === 'mallName')
  check('appConfig 返回 mallName', !!mall, cfg.data)
  check('★ 下发的 mallName 来自配置文件（与两处 shop-config 一致）',
    mall && mall.value === ROOT_SHOP.shop.name, mall)
  check('下发的 mallName 不为空（不再靠字面量兜底）', !!(mall && String(mall.value).trim()))

  // 云库 app_config 仍然可以覆盖（这是既有设计，不能因为本次改动被破坏）
  const db4 = createMockDb({
    goods: [], cart: [], order: [],
    app_config: [{ _id: 'c1', key: 'mallName', value: '后台覆盖的门店名' }]
  })
  const cfg2 = await dispatch('appConfig', {}, { db: db4, openid: 'user_D' })
  const mall2 = (cfg2.data || []).find((x) => x.key === 'mallName')
  check('app_config 集合仍能覆盖 mallName（保留既有覆盖能力）',
    mall2 && mall2.value === '后台覆盖的门店名', mall2)

  // ---- 源码级：门店名不能再有第二份字面量 ----
  const handlersJs = src('cloudfunctions/api/handlers.js')
  // 注释里允许出现（用来解释"这里原来写死了什么"），所以先剥掉注释再查代码
  const handlersCode = handlersJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★ handlers.js 的**代码**里不再出现硬编码店名（唯一出处是 shop-config.js）',
    handlersCode.indexOf(ROOT_SHOP.shop.name) < 0,
    'handlers.js 代码中仍出现：' + ROOT_SHOP.shop.name)
  check('appConfig 的 mallName 取自 SHOP.shop.name',
    /mallName:\s*\(SHOP\.shop && SHOP\.shop\.name\)\s*\|\|\s*''/.test(handlersJs))
  check('importData 的种子数据 mallName 同样取自 shop-config（不再写字面量）',
    /key:\s*'mallName',\s*value:\s*\(require\('\.\/shop-config'\)\.shop \|\| \{\}\)\.name/.test(handlersJs))

  // ---- 文档：cloud-data/app-config.jsonl 与配置一致 ----
  const jsonl = fs.readFileSync(path.join(ROOT, 'cloud-data/app-config.jsonl'), 'utf8')
  const mallLine = jsonl.trim().split(/\r?\n/).map((l) => JSON.parse(l)).find((x) => x.key === 'mallName')
  check('cloud-data/app-config.jsonl 的 mallName 与配置一致',
    mallLine && mallLine.value === ROOT_SHOP.shop.name, mallLine)

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
