/**
 * 阶段 10「店主端」回归测试（2026-10-14 新增）
 * ---------------------------------------------------------------------------
 * 覆盖《实施步骤清单》阶段 10 的第 2b / 6 / 7 步，守住三件事：
 *
 *   1) **越权面**：5 个店主写接口（goodsAdminList / goodsUpsert / goodsDelete /
 *      deliveryRuleSave / orderFreightConfirm）在非店主调用时必须被拒，
 *      且**不产生任何副作用**（商品没变、订单金额没变、云库配置没写）。
 *      这是阶段二安全纪律的延续：每个写接口第一行就是 requireAdmin(ctx)。
 *   2) **入参校验**：价格 ≤0、非法分类、重名规格组 id、重复选项 id、负加价、
 *      最少购买 0 份、图片是本地临时路径、运费为负、阶梯重复/两档"不限"、
 *      关键词太短……全部必须被拒（**拒绝而不是静默回退默认值**）。
 *   3) **口径**：下单/改价只认服务端算出来的金额；运费补录后
 *      amountReal = goodsAmount + packingFee + freight，且 goodsAmount 不被顺手改掉。
 *
 * 页面层断言（本文件第 8 节）：app.json 路由、api-map 接线、
 *   店主页面不直接碰 wx.cloud、"我的"页入口按 isShopAdmin 显隐、防呆（二次确认 /
 *   图片没上传成功不允许保存）—— 这些是"只会在真机上被店主发现"的坑。
 *
 * 运行：node tests/test-admin.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const H = require('../cloudfunctions/api/handlers')
const { dispatch, handlers } = H
const DR = require('../utils/delivery-range')
const FMT = require('../utils/format')
/** 沙箱里用的静音日志（页面/utils 的日志统一走 utils/log.js） */
const QUIET_LOG = { debug() {}, warn() {}, error() {} }

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
        pic: '/images/logo@2x.png',
        pics: ['/images/logo@2x.png'],
        characteristic: '水果味 / 约400克',
        content: '<p>动物奶油</p>',
        minPrice: 54,
        unit: '个',
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
          }
        ]
      },
      {
        // 已下架商品：顾客端看不到，店主端必须能看到并重新上架
        _id: 'g_off',
        categoryId: 'cat_fruit',
        name: '已下架的旧商品',
        pic: '/images/logo@2x.png',
        pics: ['/images/logo@2x.png'],
        minPrice: 30,
        unit: '个',
        sort: 20,
        enabled: false,
        properties: []
      }
    ],
    cart: [],
    order: [],
    app_config: []
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

const SHOP_CFG = require('../cloudfunctions/api/shop-config')
const ADMIN_OPENID = 'user_shop_owner'

function asAdmin(db) {
  return { db, openid: ADMIN_OPENID }
}

/** 一个最小可用的商品新增 payload（各用例在其上做单点破坏） */
function goodsPayload(over) {
  return Object.assign({
    name: '店主新加的商品',
    categoryId: 'cat_fruit',
    minPrice: 88,
    unit: '个',
    pics: ['cloud://env.goods/new-1.jpg'],
    sort: 30,
    enabled: true
  }, over || {})
}

async function main() {
  // =========================================================================
  console.log('=== 1) 权限：非店主调用 5 个店主接口一律被拒，且无副作用 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const outsider = { db, openid: 'user_ordinary' }
    const goodsBefore = JSON.stringify(db._store.goods)

    const cases = [
      ['goodsAdminList', {}],
      ['goodsUpsert', goodsPayload()],
      ['goodsDelete', { id: 'g_musi' }],
      ['deliveryRuleSave', { area: { keywords: ['太平新城'] } }],
      ['orderFreightConfirm', { id: 'o_any', freight: 10 }]
    ]
    for (const [action, payload] of cases) {
      const r = await dispatch(action, payload, outsider)
      check('★ 非店主调用 ' + action + ' 被拒', r.code !== 0, r)
      check('  拒绝文案明确（店主专属）', /店主|权限/.test(String(r.msg || '')), r.msg)
    }
    const r2 = await dispatch('goodsUpsert', goodsPayload(), { db, openid: '' })
    check('★ 身份缺失（openid 为空）也被拒', r2.code !== 0, r2)
    check('★ 越权调用没有改动任何商品', JSON.stringify(db._store.goods) === goodsBefore)
    check('越权调用没有写 app_config', (db._store.app_config || []).length === 0)
    // 白名单本身（2026-10-14 起可能已填了店主真实 openid）：
    //   守住的不变量是「**名单之外的人一律不是店主**」，而不是"名单必须为空"——
    //   空名单时这条同样成立（没人能通过），所以两种状态都覆盖。
    check('★ 白名单是数组，且名单之外的人一律不是店主（fail-closed）',
      Array.isArray(SHOP_CFG.adminOpenids) &&
      H.isAdmin({ openid: 'user_definitely_not_listed' }) === false &&
      (SHOP_CFG.adminOpenids.length > 0 ||
        H.isAdmin({ openid: 'user_ordinary' }) === false),
      SHOP_CFG.adminOpenids)
    check('  白名单里的 openid 形状合法（不是空串/带空格之类）',
      SHOP_CFG.adminOpenids.every((id) => typeof id === 'string' && id.trim() === id && id.length >= 8),
      SHOP_CFG.adminOpenids)
    check('5 个店主 action 都在路由表里',
      cases.every(([a]) => typeof handlers[a] === 'function'))
  }

  // 后面各节都按店主身份跑
  SHOP_CFG.adminOpenids.push(ADMIN_OPENID)

  // =========================================================================
  console.log('\n=== 1b) appConfig：只下发 isAdmin 布尔标记，不下发店主 openid 白名单 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const adminCfg = await dispatch('appConfig', {}, asAdmin(db))
    const adminRow = (adminCfg.data || []).filter((x) => x && x.key === 'isAdmin')[0]
    check('★ 店主调 appConfig → isAdmin = 1',
      adminCfg.code === 0 && adminRow && adminRow.value === '1', adminCfg.data)

    const ordinaryCfg = await dispatch('appConfig', {}, { db, openid: 'user_ordinary' })
    const ordinaryRow = (ordinaryCfg.data || []).filter((x) => x && x.key === 'isAdmin')[0]
    check('★ 普通顾客调 appConfig → isAdmin = 0（同一接口按人计算）',
      ordinaryCfg.code === 0 && ordinaryRow && ordinaryRow.value === '0', ordinaryCfg.data)

    check('★ appConfig 不再下发 order_hx_uids（店主 openid 白名单已移除）',
      !(adminCfg.data || []).some((x) => x && x.key === 'order_hx_uids') &&
      !(ordinaryCfg.data || []).some((x) => x && x.key === 'order_hx_uids'),
      adminCfg.data)
    check('★ 店主 openid 不出现在任何返回体里（不泄露给顾客）',
      JSON.stringify(adminCfg.data).indexOf(ADMIN_OPENID) < 0 &&
      JSON.stringify(ordinaryCfg.data).indexOf(ADMIN_OPENID) < 0)

    // 旧云库里可能还留着 order_hx_uids 记录：即使如此也不能下发
    const legacyDb = createMockDb(Object.assign({}, seedData(), {
      app_config: [{ _id: 'c_legacy', key: 'order_hx_uids', value: 'admin_openid_list_should_not_leak' }]
    }))
    const legacyCfg = await dispatch('appConfig', {}, asAdmin(legacyDb))
    check('  app_config 集合里的旧 order_hx_uids 记录也不会被下发',
      JSON.stringify(legacyCfg.data).indexOf('admin_openid_list_should_not_leak') < 0, legacyCfg.data)
  }

  // =========================================================================
  console.log('\n=== 2) goodsAdminList：含已下架商品 + 编辑页要的字段齐全 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = asAdmin(db)

    const r = await dispatch('goodsAdminList', {}, ctx)
    check('店主能看到全部商品（含已下架）',
      r.code === 0 && r.data.total === 2, r.data && r.data.total)
    check('★ 已下架商品也在列表里（否则下架后无法重新上架）',
      r.data.result.some((g) => g.id === 'g_off' && g.enabled === false))
    check('分开统计在售 / 已下架',
      r.data.onSale === 1 && r.data.offSale === 1, { on: r.data.onSale, off: r.data.offSale })

    // ★ 分类下拉必须**包含已停用的分类**并带 enabled 标记：
    //   否则挂在停用分类下的商品在编辑页 picker 里找不到自己 → 回落到第一项 →
    //   店主"只改个价"就把商品悄悄挪到别的分类去了（顾客端直接看不到）。
    check('★ 分类下拉含已停用分类（带 enabled 标记，前端加"（已停用）"）',
      r.data.categories.length === 3 &&
      r.data.categories.some((c) => c.id === 'cat_off' && c.enabled === false),
      r.data.categories)

    const g = r.data.result.find((x) => x.id === 'g_musi')
    check('编辑页字段齐全（名称/分类/价格/图片/规格/排序/上下架）',
      g.name === '慕斯围边水果小蛋糕' && g.categoryId === 'cat_fruit' &&
      g.minPrice === 54 && Array.isArray(g.pics) && g.pics.length === 1 &&
      g.sort === 10 && g.enabled === true, g)
    check('规格组原样返回（编辑页直接回填）',
      Array.isArray(g.properties) && g.properties.length === 1 && g.properties[0].id === 'size')
    check('给出价格区间（基础价 + 规格最大加价）', g.minPrice === 54 && g.maxPrice === 88, g)
    check('阶段 9 三个开关有默认值（0 / 0 / 1）',
      g.pickupDiscount === 0 && g.packingFee === 0 && g.minBuyNumber === 1, g)
    check('带上分类名（列表页直接显示）', g.categoryName === '水果蛋糕', g.categoryName)

    // 商品挂在已停用分类下时，编辑页能选中它本来的分类 → 只改价不会把它挪走
    const inOffCat = await dispatch('goodsUpsert', {
      name: '停用分类下的商品', categoryId: 'cat_off', minPrice: 20,
      pics: ['cloud://a.jpg'], enabled: true
    }, ctx)
    check('可以给已停用分类录商品（店主自己决定，不拦）', inOffCat.code === 0, inOffCat)
    const offId = inOffCat.data.id
    const edited = await dispatch('goodsUpsert', { id: offId, minPrice: 25 }, ctx)
    check('★ 只改价 → 分类保持不变（不会被悄悄挪到别的分类）',
      edited.code === 0 && db._store.goods.find((x) => x._id === offId).categoryId === 'cat_off',
      edited.code === 0 ? db._store.goods.find((x) => x._id === offId).categoryId : edited)

    const byCat = await dispatch('goodsAdminList', { categoryId: 'cat_ice' }, ctx)
    check('按分类过滤', byCat.data.total === 0, byCat.data.total)
    const byKw = await dispatch('goodsAdminList', { keyword: '旧商品' }, ctx)
    check('按关键词过滤（店主找商品用）',
      byKw.data.total === 1 && byKw.data.result[0].id === 'g_off', byKw.data.total)
  }

  // =========================================================================
  console.log('\n=== 3) goodsUpsert：新增/编辑 + 入参校验（拒绝而不是静默吞掉）===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = asAdmin(db)

    // ---- 新增 ----
    const created = await dispatch('goodsUpsert', goodsPayload({
      properties: [{
        id: 'size',
        name: '磅数',
        childsCurGoods: [
          { id: 's6', name: '6寸', priceDelta: 0 },
          { id: 's8', name: '8寸', priceDelta: 60 }
        ]
      }],
      pickupDiscount: 10,
      packingFee: 2,
      minBuyNumber: 2
    }), ctx)
    check('★ 店主新增商品成功', created.code === 0, created)
    const created0 = db._store.goods.find((g) => g.name === '店主新加的商品')
    check('  库里有 createBy / createTime / updBy / updTime',
      created0 && created0.createBy === ADMIN_OPENID && created0.createTime > 0 &&
      created0.updBy === ADMIN_OPENID && created0.updTime > 0, created0)
    check('  新增商品立刻出现在顾客端商品列表（enabled）',
      (await dispatch('goodsList', {}, { db, openid: 'c' })).data.result.some((g) => g.name === '店主新加的商品'))
    check('  阶段 9 三个开关按店主填的写入',
      created0.pickupDiscount === 10 && created0.packingFee === 2 && created0.minBuyNumber === 2, created0)

    // ---- 编辑：改价 ----
    const upd = await dispatch('goodsUpsert', { id: 'g_musi', minPrice: 108 }, ctx)
    check('★ 店主改价成功（部分字段更新：只传了价格）', upd.code === 0, upd)
    const gAfter = db._store.goods.find((g) => g._id === 'g_musi')
    check('  新价格已写入（顾客端重新进入即看到新价）', gAfter.minPrice === 108, gAfter.minPrice)
    check('  没传的字段沿用旧值（名称/图片/规格组都还在）',
      gAfter.name === '慕斯围边水果小蛋糕' && gAfter.pics.length === 1 &&
      gAfter.properties.length === 1, gAfter)
    check('  改价留痕（updBy/updTime）', gAfter.updBy === ADMIN_OPENID && gAfter.updTime > 0)

    // ---- 只切上下架 ----
    const off = await dispatch('goodsUpsert', { id: 'g_musi', enabled: false }, ctx)
    check('★ 只传 { id, enabled } 也能下架（不必回传整个表单）',
      off.code === 0 && db._store.goods.find((g) => g._id === 'g_musi').enabled === false, off)
    check('  下架后顾客端列表不再返回它',
      !(await dispatch('goodsList', {}, { db, openid: 'c' })).data.result.some((g) => g.id === 'g_musi'))
    check('  但店内数据完好（价格/名称未被覆盖）',
      db._store.goods.find((g) => g._id === 'g_musi').minPrice === 108)

    // ---- 校验：每一处都必须被拒，且不新增/不改动 ----
    const bad = [
      ['缺名称', goodsPayload({ name: '' })],
      ['名称超长（41 字）', goodsPayload({ name: '蛋'.repeat(41) })],
      ['缺分类', goodsPayload({ categoryId: '' })],
      ['分类不存在（伪造 categoryId）', goodsPayload({ categoryId: 'cat_not_exist' })],
      ['价格为 0', goodsPayload({ minPrice: 0 })],
      ['价格为负', goodsPayload({ minPrice: -5 })],
      ['价格不是数字', goodsPayload({ minPrice: 'abc' })],
      ['价格超上限', goodsPayload({ minPrice: 100000 })],
      ['没有图片', goodsPayload({ pics: [] })],
      ['图片是本地临时路径（没上传成功）', goodsPayload({ pics: ['wxfile://tmp_a.jpg'] })],
      ['规格组 id 重复', goodsPayload({
        properties: [
          { id: 'size', name: '磅数', childsCurGoods: [{ id: 's6', name: '6寸', priceDelta: 0 }] },
          { id: 'size', name: '口味', childsCurGoods: [{ id: 'f1', name: '草莓', priceDelta: 0 }] }
        ]
      })],
      ['规格组没有任何选项', goodsPayload({
        properties: [{ id: 'size', name: '磅数', childsCurGoods: [] }]
      })],
      ['同一组里选项 id 重复', goodsPayload({
        properties: [{
          id: 'size', name: '磅数',
          childsCurGoods: [
            { id: 's6', name: '6寸', priceDelta: 0 },
            { id: 's6', name: '8寸', priceDelta: 20 }
          ]
        }]
      })],
      ['选项加价为负（会算出负价）', goodsPayload({
        properties: [{ id: 'size', name: '磅数', childsCurGoods: [{ id: 's6', name: '6寸', priceDelta: -10 }] }]
      })],
      ['规格组缺名称', goodsPayload({
        properties: [{ id: 'size', name: '', childsCurGoods: [{ id: 's6', name: '6寸', priceDelta: 0 }] }]
      })],
      ['最少购买 0 份', goodsPayload({ minBuyNumber: 0 })],
      ['最少购买不是整数', goodsPayload({ minBuyNumber: 1.5 })],
      ['排序不是整数', goodsPayload({ sort: 1.5 })],
      ['排序为负', goodsPayload({ sort: -1 })],
      ['自取立减 ≥ 价格', goodsPayload({ minPrice: 50, pickupDiscount: 50 })],
      ['打包费为负', goodsPayload({ packingFee: -1 })],
      ['上下架状态不是布尔', goodsPayload({ enabled: 'yes' })]
    ]
    const countBefore = db._store.goods.length
    let allRejected = true
    for (const [label, payload] of bad) {
      const r = await dispatch('goodsUpsert', payload, ctx)
      if (r.code === 0) {
        allRejected = false
        check('★ 非法入参被拒：' + label, false, r)
      }
    }
    check('★ 全部非法入参都被拒（共 ' + bad.length + ' 种）', allRejected)
    check('★ 被拒的请求没有写库（商品数量不变）',
      db._store.goods.length === countBefore, db._store.goods.length)

    // ---- 编辑不存在的商品 ----
    const ghost = await dispatch('goodsUpsert', { id: 'g_ghost', minPrice: 10 }, ctx)
    check('★ 编辑不存在的商品被拒（不会静默变成新增）',
      ghost.code !== 0 && db._store.goods.length === countBefore, ghost)

    // ---- 只切上下架：历史脏数据不能把这条路堵死 ----
    {
      const dbDirty = createMockDb(seedData())
      // 制造一条"不满足当前校验"的历史数据（自取立减 ≥ 价格；选项 id 是中文）
      dbDirty._store.goods.push({
        _id: 'g_dirty', categoryId: 'cat_fruit', name: '历史脏数据商品',
        pic: '/images/logo@2x.png', pics: ['/images/logo@2x.png'], minPrice: 10,
        unit: '个', sort: 99, enabled: true, pickupDiscount: 50,
        properties: [{ id: 'size', name: '磅数', childsCurGoods: [{ id: '6寸', name: '6寸', priceDelta: 0 }] }]
      })
      const ctxDirty = asAdmin(dbDirty)
      const offDirty = await dispatch('goodsUpsert', { id: 'g_dirty', enabled: false }, ctxDirty)
      check('★ 只切上下架：历史脏数据不会把"下架"堵死（报错还指向她没改过的字段）',
        offDirty.code === 0 && dbDirty._store.goods.find((g) => g._id === 'g_dirty').enabled === false,
        offDirty)
      const onDirty = await dispatch('goodsUpsert', { id: 'g_dirty', enabled: true }, ctxDirty)
      check('  重新上架同样放行', onDirty.code === 0 &&
        dbDirty._store.goods.find((g) => g._id === 'g_dirty').enabled === true)
      const editDirty = await dispatch('goodsUpsert', { id: 'g_dirty', minPrice: 12 }, ctxDirty)
      check('  但**改其它字段**时仍然走完整校验（脏数据会被要求改对）',
        editDirty.code !== 0, editDirty)
      const badEnabled = await dispatch('goodsUpsert', { id: 'g_dirty', enabled: 'yes' }, ctxDirty)
      check('  快速通道仍然校验 enabled 必须是布尔值', badEnabled.code !== 0, badEnabled)
    }

    // ---- 详情纯文本 → 段落标签（含"6寸<8寸"这种比较符号也要分段）----
    {
      const db2 = createMockDb(seedData())
      const ctx2 = asAdmin(db2)
      const r1 = await dispatch('goodsUpsert', goodsPayload({
        name: '详情纯文本', content: '6寸<8寸 都可以\n第二行说明'
      }), ctx2)
      const saved1 = db2._store.goods.find((g) => g._id === r1.data.id)
      check('★ 纯文本详情自动分段（不因为出现 < 就当成富文本）',
        saved1.content === '<p>6寸<8寸 都可以</p><p>第二行说明</p>', saved1.content)
      const r2 = await dispatch('goodsUpsert', goodsPayload({
        name: '详情富文本', content: '<p>已经是富文本</p>'
      }), ctx2)
      const saved2 = db2._store.goods.find((g) => g._id === r2.data.id)
      check('已经是富文本的原样保留', saved2.content === '<p>已经是富文本</p>', saved2.content)
    }

    // ---- "删除"语义：只下架，不物理删 ----
    const del = await dispatch('goodsDelete', { id: 'g_off' }, ctx)
    check('下架商品成功（软删）', del.code === 0 && del.data.enabled === false, del)
    check('  goods 集合里记录仍在（历史订单快照与数据都可追溯）',
      !!db._store.goods.find((g) => g._id === 'g_off'))
    const del2 = await dispatch('goodsDelete', { id: 'g_off' }, ctx)
    check('  重复下架幂等（already 标记，不报错）', del2.code === 0 && del2.data.already === true, del2)
    const delNo = await dispatch('goodsDelete', { id: 'g_none' }, ctx)
    check('  下架不存在的商品 → 明确失败', delNo.code !== 0, delNo)
  }

  // =========================================================================
  console.log('\n=== 4) orderFreightConfirm：「运费待确认」订单的补款入口 ===')
  // =========================================================================
  {
    const mkOrder = (over) => Object.assign({
      _id: 'o_1',
      _openid: 'user_cust',
      orderNumber: 'QH261014-0001',
      pickupCode: '0001',
      dateAdd: Date.now(),
      status: 0,
      statusStr: '待支付',
      amountReal: 118,
      goodsAmount: 100,
      packingFee: 0,
      freight: 0,
      deliveryMode: 'delivery',
      address: { name: '张三', phone: '13800138000', latitude: 24.9, longitude: 102.5 },
      deliveryQuote: { distanceKm: 9.2, inArea: true, reason: 'beyond', freightText: '超出8公里，下单后商家会电话与您确认运费' },
      goods: [{ goodsName: '蛋糕', property: '6寸', number: 1, price: 100 }],
      remark: ''
    }, over || {})

    const db = createMockDb(seedData())
    db._store.order.push(mkOrder())
    const ctx = asAdmin(db)

    check('前置：该单的运费判定是「待确认」（reason = beyond）',
      db._store.order[0].deliveryQuote.reason === 'beyond')

    const r = await dispatch('orderFreightConfirm', { id: 'o_1', freight: 18 }, ctx)
    check('★ 店主补录运费成功', r.code === 0, r)
    const o = db._store.order[0]
    check('★ 实付 = 商品 + 打包费 + 补录的运费（服务端重算）',
      o.amountReal === 118 && o.freight === 18, { amountReal: o.amountReal, freight: o.freight })
    check('★ 商品金额没有被顺手改掉', o.goodsAmount === 100 && o.packingFee === 0)
    check('  写审计字段（谁在什么时候确认的）',
      o.freightConfirmBy === ADMIN_OPENID && o.freightConfirmTime > 0, o)
    check('  配送费文案改成实收金额（店主端不再显示"待确认"）',
      o.deliveryQuote.freightText === '¥18' && o.deliveryQuote.freightConfirmed === true, o.deliveryQuote)

    // 免收运费（0 元）
    const r0 = await dispatch('orderFreightConfirm', { id: 'o_1', freight: 0 }, ctx)
    check('★ 补录 0 元 = 免收运费（金额回落）',
      r0.code === 0 && db._store.order[0].amountReal === 100 &&
      db._store.order[0].deliveryQuote.freightText === '免配送费', r0)

    // 非法输入
    const badFee = await dispatch('orderFreightConfirm', { id: 'o_1', freight: 'abc' }, ctx)
    check('非法运费（非数字）被拒', badFee.code !== 0, badFee)
    const negFee = await dispatch('orderFreightConfirm', { id: 'o_1', freight: -5 }, ctx)
    check('★ 负运费被拒（不能倒找顾客钱）', negFee.code !== 0, negFee)
    const hugeFee = await dispatch('orderFreightConfirm', { id: 'o_1', freight: 1000 }, ctx)
    check('过大运费被拒', hugeFee.code !== 0, hugeFee)
    const noId = await dispatch('orderFreightConfirm', {}, ctx)
    check('缺订单 id 被拒', noId.code !== 0, noId)

    // 不该被"补录"的订单
    const db2 = createMockDb(seedData())
    db2._store.order.push(mkOrder({
      _id: 'o_paid',
      deliveryQuote: { distanceKm: 1, inArea: true, reason: 'within_paid', freightText: '¥5' },
      freight: 5
    }))
    const rPaid = await dispatch('orderFreightConfirm', { id: 'o_paid', freight: 1 }, asAdmin(db2))
    check('★ 运费已确定的订单不允许在这里改（补录不是"随便改价"的入口）',
      rPaid.code !== 0, rPaid)

    const db3 = createMockDb(seedData())
    db3._store.order.push(mkOrder({ _id: 'o_pick', deliveryMode: 'pickup', deliveryQuote: null }))
    const rPick = await dispatch('orderFreightConfirm', { id: 'o_pick', freight: 5 }, asAdmin(db3))
    check('自提订单没有运费可补录 → 拒绝', rPick.code !== 0, rPick)

    const db4 = createMockDb(seedData())
    db4._store.order.push(mkOrder({ _id: 'o_done', status: 3 }))
    const rDone = await dispatch('orderFreightConfirm', { id: 'o_done', freight: 5 }, asAdmin(db4))
    check('★ 已完成/已取消的订单不能再改配送费', rDone.code !== 0, rDone)

    const db5 = createMockDb(seedData())
    const rMissing = await dispatch('orderFreightConfirm', { id: 'o_none', freight: 5 }, asAdmin(db5))
    check('订单不存在 → 明确失败', rMissing.code !== 0, rMissing)
  }

  // =========================================================================
  console.log('\n=== 5) deliveryRuleSave：规则上云 + 保存前显式校验 ===')
  // =========================================================================
  {
    const db = createMockDb(seedData())
    const ctx = asAdmin(db)

    // 非法输入必须"报错拒绝"，绝不能静默回退默认值（否则店主以为改了、实际没改）
    const bad = [
      ['没有任何档位', { freight: { tiers: [] } }],
      ['两档距离上限相同', { freight: { tiers: [
        { maxKm: 3, fee: 5 }, { maxKm: 3, fee: 8 }
      ] } }],
      ['两档都"不限"', { freight: { tiers: [
        { maxKm: null, fee: 5 }, { maxKm: null, fee: 8 }
      ] } }],
      ['距离上限为 0', { freight: { tiers: [{ maxKm: 0, fee: 5 }] } }],
      ['距离上限是文字', { freight: { tiers: [{ maxKm: 'abc', fee: 5 }] } }],
      ['运费为负', { freight: { tiers: [{ maxKm: 3, fee: -5 }] } }],
      ['免运费门槛为负', { freight: { tiers: [{ maxKm: 3, fee: 5, freeAmount: -1 }] } }],
      ['关键词太短（短词会把外地放进来）', { area: { keywords: ['西山'] } }],
      ['不送区域关键词太短', { area: { excludeKeywords: ['太平'] } }],
      ['关键词不是数组', { area: { keywords: '太平新城' } }],
      ['配送范围关键词清空（会让所有顾客都无法外送）', { area: { keywords: [] } }],
      ['距离上限为 0 公里', { area: { forbidBeyondKm: 0 } }],
      ['蛋糕最小尺寸为 0 寸', { cake: { minSizeInch: 0 } }],
      ['开关不是布尔值', { cake: { enabled: 'yes' } }],
      ['空对象（没有要保存的设置）', {}]
    ]
    let allRejected = true
    for (const [label, payload] of bad) {
      const r = await dispatch('deliveryRuleSave', payload, ctx)
      if (r.code === 0) {
        allRejected = false
        check('★ 非法配送设置被拒：' + label, false, r)
      }
    }
    check('★ 全部非法配送设置都被拒（共 ' + bad.length + ' 种）', allRejected)
    check('★ 被拒时没有写 app_config（不会把线上规则改坏）',
      (db._store.app_config || []).length === 0, db._store.app_config)

    // 合法保存（店主给的档位：0-3 满 35 免 / 5 / 8 / 以上待确认）
    const save = await dispatch('deliveryRuleSave', {
      area: {
        keywords: ['太平新城', '山水融城'],
        excludeKeywords: ['某某不送小区'],
        forbidBeyondKm: 10
      },
      freight: {
        tiers: [
          { maxKm: 3, fee: 5, freeAmount: 35, tip: '' },
          { maxKm: 5, fee: 10, freeAmount: null, tip: '' },
          { maxKm: 8, fee: 18, freeAmount: null, tip: '' },
          { maxKm: null, fee: null, freeAmount: null, tip: '超出8公里，下单后商家会电话与您确认运费' }
        ]
      },
      cake: { enabled: true, freeWithinKm: 3, minSizeInch: 6, overrideThreshold: true }
    }, ctx)
    check('★ 店主保存配送设置成功', save.code === 0, save)
    const row = db._store.app_config.find((x) => x.key === 'delivery_rule')
    check('  规则已写入 app_config.delivery_rule（云库 = 唯一事实源）', !!row)
    check('  写入者与时间留痕', !!row && row.updBy === ADMIN_OPENID && row.updTime > 0, row)

    const rule = row.value
    check('  阶梯原样保存（4 档）', rule.freight.tiers.length === 4, rule.freight.tiers)
    check('★ 兼容镜像与阶梯保持一致（否则旧代码读旧键会算出另一个价）',
      rule.distance.freeWithinKm === 3 &&
      rule.freight.withinFee === 5 &&
      rule.freight.withinFreeAmount === 35 &&
      rule.freight.beyondFee === null &&
      rule.freight.beyondEnabled === true,
      { d: rule.distance, f: rule.freight })
    check('★ 尾档"运费待确认"仍然接单（beyondEnabled=true 不是拒单）',
      rule.freight.beyondEnabled === true &&
      rule.freight.tiers[3].fee === null, rule.freight)
    check('  不送区域 / 距离上限 / 关键词都保存了',
      rule.area.excludeKeywords.length === 1 &&
      rule.area.forbidBeyondKm === 10 &&
      rule.area.keywords.length === 2, rule.area)

    // 保存后：appConfig 下发给前端的必须是**同一份**规则（屏显运费 == 实付的前提）
    const cfg = await dispatch('appConfig', {}, { db, openid: 'c' })
    const sent = cfg.data.filter((x) => x.key === 'delivery_rule')[0].value
    check('★ appConfig 下发给顾客端的规则 = 刚保存的规则（同一口径）',
      JSON.stringify(sent.freight.tiers) === JSON.stringify(rule.freight.tiers), sent.freight.tiers)
    check('  距门店 4 公里、满 50 元 → 按第二档收 10 元（新规则真的生效了）',
      DR.calcQuote({
        address: { detail: '太平新城某小区', latitude: 24.920190 + 4 / 111.19, longitude: 102.584276 },
        goodsAmount: 50,
        items: []
      }).freight === 10, DR.calcQuote({
        address: { detail: '太平新城某小区', latitude: 24.920190 + 4 / 111.19, longitude: 102.584276 },
        goodsAmount: 50,
        items: []
      }))

    check('★ 前端保存的关键词不可能是裸短词（服务端拒绝 <3 字）',
      rule.area.keywords.every((k) => k.length >= 3), rule.area.keywords)
  }

  // 收尾：还原白名单与运行期规则，避免影响同进程后续断言
  SHOP_CFG.adminOpenids.length = 0
  DR.resetDeliveryRule()

  // =========================================================================
  console.log('\n=== 6) 纯函数校验器边界（规格组 / 图片 / 阶梯 / 关键词）===')
  // =========================================================================
  {
    check('规格组：不传 = 不改（undefined），不是空数组',
      H.normalizeSpecGroups(undefined).value === undefined)
    check('规格组：空数组 = 明确清空（合法）',
      H.normalizeSpecGroups([]).ok === true &&
      H.normalizeSpecGroups([]).value.length === 0)
    check('规格组：组 id 含非法字符被拒',
      H.normalizeSpecGroups([{
        id: '规 格', name: '磅数', childsCurGoods: [{ id: 'a', name: '6寸', priceDelta: 0 }]
      }]).ok === false)
    check('加价留空按 0 处理（店主不用每格都填）',
      H.normalizeSpecGroups([{
        id: 'size', name: '磅数', childsCurGoods: [{ id: 's6', name: '6寸' }]
      }]).value[0].childsCurGoods[0].priceDelta === 0)
    check('加价支持两位小数',
      H.normalizeSpecGroups([{
        id: 'size', name: '磅数', childsCurGoods: [{ id: 's6', name: '6寸', priceDelta: 1.239 }]
      }]).value[0].childsCurGoods[0].priceDelta === 1.24)
    check('图片：本地临时路径被识别为"没上传成功"',
      H.normalizePicUrl('wxfile://tmp.jpg').ok === false &&
      H.normalizePicUrl('http://tmp/abc.jpg').ok === false)
    check('图片：cloud:// 与 https:// 与 /images/ 都接受',
      H.normalizePicUrl('cloud://a.png').ok &&
      H.normalizePicUrl('https://cdn/a.png').ok &&
      H.normalizePicUrl('/images/a.png').ok)
    check('图片：空 → 拒绝', H.normalizePicUrl('').ok === false)
    check('阶梯：升序自动整理，"不限"排最后',
      (() => {
        const r = H.normalizeTiersForSave([
          { maxKm: null, fee: null },
          { maxKm: 5, fee: 10 },
          { maxKm: 3, fee: 5 }
        ])
        return r.ok && r.value[0].maxKm === 3 && r.value[2].maxKm === null
      })())
    check('阶梯：留空 = 待确认（fee null）而不是 0 元',
      H.normalizeTiersForSave([{ maxKm: null, fee: '' }]).value[0].fee === null)
    check('关键词：去空行 / 去重 / 保序',
      (() => {
        const r = H.normalizeKeywordList(['太平新城', ' 太平新城 ', '', '山水融城'], 'x')
        return r.ok && r.value.length === 2 && r.value[0] === '太平新城'
      })())
    check('关键词：不是数组 → 拒绝（防止把整段文字存进去）',
      H.normalizeKeywordList('太平新城', 'x').ok === false)
  }

  // =========================================================================
  console.log('\n=== 7) 接口接线：api-map 是唯一数据出口 ===')
  // =========================================================================
  {
    const apiMap = src('utils/api-map.js')
    const methods = [
      ['adminOrderList', 'orderAdminList'],
      ['adminGoodsList', 'goodsAdminList'],
      ['adminGoodsUpsert', 'goodsUpsert'],
      ['adminGoodsDelete', 'goodsDelete'],
      ['adminDeliverySave', 'deliveryRuleSave'],
      ['adminOrderFreightConfirm', 'orderFreightConfirm']
    ]
    methods.forEach(([fn, action]) => {
      check('api-map 暴露 ' + fn + ' → ' + action,
        new RegExp(fn + '\\s*[:(]').test(apiMap) && apiMap.indexOf("'" + action + "'") >= 0)
    })
    check('★ 店主端 6 个方法都走云函数（api-map 是唯一数据出口）',
      methods.every(([, action]) => apiMap.indexOf("callCloud('" + action + "'") >= 0))
    check('utils/api-map.js 里只有一处 wx.cloud.callFunction（去掉注释后）',
      (apiMap.replace(/\/\*[\s\S]*?\*\//g, '').match(/wx\.cloud\.callFunction/g) || []).length === 1,
      (apiMap.replace(/\/\*[\s\S]*?\*\//g, '').match(/wx\.cloud\.callFunction/g) || []).length)
  }

  // =========================================================================
  console.log('\n=== 8) 页面层：路由 / 入口显隐 / 防呆（只能在真机上发现的坑）===')
  // =========================================================================
  {
    const appJson = JSON.parse(src('app.json'))
    const pages = appJson.pages || []
    const adminPages = [
      'pages/admin/index',
      'pages/admin/orders/index',
      'pages/admin/goods/index',
      'pages/admin/goods-edit/index',
      'pages/admin/delivery/index',
      // 阶段 11：优惠券管理（同属店主端，不进 tabBar）
      'pages/admin/coupons/index',
      'pages/admin/coupons-edit/index'
    ]
    adminPages.forEach((p) => {
      check('app.json 注册了 ' + p, pages.indexOf(p) >= 0)
      check('  且四个文件齐全（js/wxml/wxss/json）',
        exists(p + '.js') && exists(p + '.wxml') && exists(p + '.wxss') && exists(p + '.json'))
    })
    check('★ 店主页面不进 tabBar（顾客端保持干净）',
      !(appJson.tabBar || {}).list ||
      !(appJson.tabBar.list || []).some((t) => adminPages.indexOf(t.pagePath) >= 0))
    check('★ 店主页面没有直接调用 wx.cloud（必须走 api-map 统一出口）',
      adminPages.every((p) => src(p + '.js').indexOf('wx.cloud') < 0))

    let compileErr = null
    adminPages.forEach((p) => {
      try {
        new vm.Script(src(p + '.js'), { filename: p + '.js' })
      } catch (e) {
        compileErr = p + ' :: ' + e.message
      }
    })
    check('★ ' + adminPages.length + ' 个店主页面 js 都能编译', compileErr === null, compileErr)

    const adminIndexJs = src('pages/admin/index.js')
    const adminIndexWxml = src('pages/admin/index.wxml')
    check('★ 店主中心 onLoad 先过鉴权闸门（guardShopAdminPage）',
      /guardShopAdminPage/.test(adminIndexJs))
    check('  非店主只渲染"无店主权限"分支',
      /!isAdminUser/.test(adminIndexWxml) && /无店主权限/.test(adminIndexWxml))
    check('★ 概况用 orderAdminList（取 statusCounts）与 adminGoodsList',
      /adminOrderList\(/.test(adminIndexJs) && /adminGoodsList\(/.test(adminIndexJs))
    check('  任一失败 → 错误态 + 重试（不显示半截数字）',
      /loadError:\s*true/.test(adminIndexJs) && /retryLoad/.test(adminIndexWxml))
    check('  优惠券入口进入券管理页（阶段 11 已上线，不再写"还没上线"）',
      /goCoupons/.test(adminIndexJs) &&
      /pages\/admin\/coupons\/index/.test(adminIndexJs) &&
      !/还没上线/.test(adminIndexWxml + adminIndexJs))

    const ordersWxml = src('pages/admin/orders/index.wxml')
    const ordersJs = src('pages/admin/orders/index.js')
    check('★ 订单页给出接单必备信息（收货人/电话/地址/期望时间/备注）',
      /contactName/.test(ordersWxml) && /contactPhone/.test(ordersWxml) &&
      /addressText/.test(ordersWxml) && /expectTime/.test(ordersWxml) &&
      /remark/.test(ordersWxml))
    check('★ 有「拨打电话 / 一键导航 / 完成订单」三个动作',
      /callCustomer/.test(ordersWxml) && /navToCustomer/.test(ordersWxml) &&
      /finishOrder/.test(ordersWxml))
    check('  完成订单前二次确认（误点不能改状态）', /showModal/.test(ordersJs))
    check('★ 「运费待确认」的订单有补录入口（金额由服务端重算）',
      /openFreight/.test(ordersWxml) && /adminOrderFreightConfirm/.test(ordersJs))
    check('  订单列表有下拉刷新 + 上拉分页',
      /onPullDownRefresh/.test(ordersJs) && /onReachBottom/.test(ordersJs))
    check('  切筛选后慢的旧请求不会覆盖新结果（_seq 竞态保护）',
      /_seq/.test(ordersJs) && /seq !== \(this\._seq \|\| 0\)/.test(ordersJs))

    const goodsWxml = src('pages/admin/goods/index.wxml')
    const goodsJs = src('pages/admin/goods/index.js')
    check('★ 商品页分开显示在售 / 已下架（下架商品能找回来）',
      /onSaleList/.test(goodsWxml) && /offSaleList/.test(goodsWxml))
    check('★ 上下架要二次确认（下架是顾客端立即不可见）', /showModal/.test(goodsJs))
    check('  「删除」的语义是下架（文案里说清不会删除、可重新上架）',
      /不会删除|重新上架/.test(goodsJs))
    check('  有搜索与分类筛选（店主找商品）',
      /keyword/.test(goodsWxml) && /onCategoryChange/.test(goodsWxml))

    const editJs = src('pages/admin/goods-edit/index.js')
    const editWxml = src('pages/admin/goods-edit/index.wxml')
    check('★ 编辑页覆盖：名称/分类/价格/图片/规格组/上下架/排序/立减/打包费/起购量',
      ['name', 'categoryIndex', 'minPrice', 'pics', 'specGroups', 'enabled', 'sort',
        'pickupDiscount', 'packingFee', 'minBuyNumber'].every((k) => editWxml.indexOf(k) >= 0))
    check('★ 图片上传走 api-map 的 uploadFile（页面不直接碰 wx.cloud）',
      /API\.uploadFile/.test(editJs) && editJs.indexOf('wx.cloud') < 0)
    check('★ 图片没上传成功 / 一张都没有时不允许保存',
      /请先上传商品图片/.test(editJs) && /图片还在上传中/.test(editJs))
    check('  规格组/选项 id 自动生成（符合服务端的字符集规则）',
      /nextId\('g'/.test(editJs) && /nextId\('o'/.test(editJs))
    check('  商品 id 由云库生成，新增成功后回填 goodsId（避免重复建商品）',
      /goodsId: res\.data\.id/.test(editJs))

    const deliveryJs = src('pages/admin/delivery/index.js')
    const deliveryWxml = src('pages/admin/delivery/index.wxml')
    check('★ 配送页可改阶梯 / 不送区域 / 距离上限 / 蛋糕免运费',
      /tiers/.test(deliveryWxml) && /excludeText/.test(deliveryWxml) &&
      /forbidBeyondKm/.test(deliveryWxml) && /cakeEnabled/.test(deliveryWxml))
    check('  读取的是 appConfig 下发的生效规则（不是自己那份默认值）',
      /delivery_rule/.test(deliveryJs) && /API\.appConfig/.test(deliveryJs))
    check('★ 保存前先自查关键词长度（短词会把片区外地址放进来）',
      /太短，请写完整小区/.test(deliveryJs))
    check('  area/cake 以生效规则打底再覆盖（不抹掉没展示的字段）',
      /Object\.assign\(\{\}, base\.area/.test(deliveryJs) &&
      /Object\.assign\(\{\}, base\.cake/.test(deliveryJs))

    const myJs = src('pages/my/index.js')
    const myWxml = src('pages/my/index.wxml')
    check('★「我的」页的店主中心入口受 isShopAdmin 判定控制',
      /isAdminUser/.test(myWxml) && /isAdminUserSafe/.test(myJs))
    check('  入口跳转到 pages/admin/index', /pages\/admin\/index/.test(myJs))
    check('★ 原始 openid 只在开发版/体验版显示（正式版顾客看不到）',
      /isDevEnv && myOpenid/.test(myWxml))
    check('  顾客界面仍然只显示不可反推的短编号',
      /shortUserNo/.test(myJs) && myWxml.indexOf('userInfo.id') < 0)
    check('utils/admin.js 提供闸门与 openid 自查', (() => {
      const admin = require('../utils/admin')
      return typeof admin.guardShopAdminPage === 'function' &&
        typeof admin.isAdminUser === 'function' &&
        typeof admin.ensureAdminFlag === 'function' &&
        typeof admin.getMyOpenid === 'function'
    })())
    check('★ isAdminUser 是纯本地判断（不调云函数）',
      /function isAdminUser[\s\S]*?getStorageSync[\s\S]*?\n\}/.test(src('utils/admin.js')))
    check('★ 前端不再接收店主 openid 白名单（appConfig 只下发 isAdmin 布尔标记）',
      !/order_hx_uids/.test(src('utils/admin.js')) &&
      !/order_hx_uids/.test(src('cloudfunctions/api/handlers.js')) &&
      /key: 'isAdmin'/.test(src('cloudfunctions/api/handlers.js')))

    // ---- 店主标记竞态：app.js 写 storage 与本页判断身份是并发的 ----
    {
      const store = {}
      let fail = false
      const realRequire = require
      const ADMIN_MODULE = '../utils/admin'
      delete realRequire.cache[realRequire.resolve(ADMIN_MODULE)]
      const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        require: (p) => {
          if (/api-map$/.test(p)) {
            return {
              userDetail: async () => ({ code: 0, data: { base: { id: 'o_boss' } } }),
              appConfig: async () => (fail
                ? { code: 500, msg: '云函数调用失败' }
                : { code: 0, data: [{ key: 'isAdmin', value: '1' }] })
            }
          }
          if (/utils\/log$/.test(p) || /^\.\/log$/.test(p)) return QUIET_LOG
          throw new Error('unexpected require: ' + p)
        },
        module: { exports: {} },
        exports: {},
        wx: {
          getStorageSync: (k) => store[k],
          setStorageSync: (k, v) => { store[k] = v }
        }
      }
      sandbox.module.exports = sandbox.exports
      vm.runInNewContext(src('utils/admin.js'), vm.createContext(sandbox), { filename: 'utils/admin.js' })
      const A = sandbox.module.exports
      check('★ 店主标记还没写进 storage 时能自己补拉一次（否则店主首次进入看不到入口）',
        A.isAdminUser() === false &&
        (await A.ensureAdminFlag()) === true &&
        store['isAdmin'] === '1' &&
        A.isAdminUser() === true, store)
      check('isShopAdmin 也会在缺标记时自愈', (await A.isShopAdmin()) === true)
      delete store['isAdmin']
      fail = true
      check('拉不到店主标记时按非店主处理（fail-closed）',
        (await A.ensureAdminFlag()) === false && (await A.isShopAdmin()) === false)
    }
  }

  // =========================================================================
  console.log('\n=== 9) 页面真实行为（沙箱里跑一遍 js，不只是匹配源码字符串）===')
  // =========================================================================
  {
    /**
     * 与 tests/test-stage5-page.js 同一套页面沙箱：
     * 把页面 js 放进 vm 里跑，Page() 拿走页面对象，wx 与 require 用桩替代。
     *
     * ★ 2026-10-14 加固（真机踩到 `pages/admin/goods/index.js` 写成 `../../utils/…`，
     *   页面能打开、标题也在，但模块加载就抛错 → 正文一片空白）：
     *   require 现在是**路径感知**的 —— 先用 Node 的真实解析把相对路径解析成绝对路径
     *   （解析失败直接抛 "Cannot find module"，与真机同样的错），再拿解析后的路径去匹配
     *   桩。原来直接拿字符串匹配，路径写错也会被桩吞掉，测试全绿而真机白屏。
     */
    function loadPage(rel, opts) {
      const o = opts || {}
      const toasts = []
      const wxBase = Object.assign({
        showLoading() {}, hideLoading() {},
        showToast(t) { toasts.push(t && t.title) },
        showModal() {}, getStorageSync() { return '' }, setStorageSync() {},
        navigateBack() {}, navigateTo() {}, setNavigationBarTitle() {},
        makePhoneCall() {}, stopPullDownRefresh() {}, setClipboardData() {},
        previewImage() {}, chooseMedia() {},
        chooseImage() {}
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
          // 真实解析：路径写错 → 抛出与真机一致的 "Cannot find module"
          // （统一成正斜杠，桩的键才匹配得上 Windows 的路径分隔符）
          const resolved = nodeRequire.resolve(p).replace(/\.js$/, '').replace(/\\/g, '/')
          for (const key of Object.keys(extraReq)) {
            if (new RegExp(key).test(resolved)) return extraReq[key]
          }
          // 没被桩替换的依赖 → 用真实模块（都是纯逻辑模块，不会碰 wx）
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
      return inst
    }

    const ADMIN_STUB = {
      isShopAdmin: async () => true,
      isAdminUser: () => true,
      ensureAdminFlag: async () => true,
      getMyOpenid: async () => 'o_test',
      guardShopAdminPage: async () => true
    }

    // ---- 9.1 商品编辑页：前端校验与提交内容 ----
    {
      let submitted = null
      const api = {
        uploadFile: async () => ({ code: 0, fileID: 'cloud://up/x.jpg' }),
        adminGoodsUpsert: async (p) => { submitted = p; return { code: 0, data: { id: 'g_new' } } }
      }
      const page = loadPage('pages/admin/goods-edit/index.js', {
        requires: { 'api-map$': api, 'utils/admin$': ADMIN_STUB, 'utils/log$': QUIET_LOG }
      })
      page.data.categories = [{ id: 'cat_fruit', name: '水果蛋糕' }]
      page.data.categoryNames = ['水果蛋糕']
      page.data.categoryIndex = 0
      page.data.name = '测试蛋糕'
      page.data.minPrice = '88'
      page.data.pics = ['cloud://a.jpg']
      page.data.specGroups = [{
        id: 'g1', name: '磅数', childsCurGoods: [{ id: 'o1', name: '6寸', priceDelta: '0' }]
      }]

      check('合法表单 → 校验通过', page.validate().ok === true, page.validate().msg)
      const v = page.validate()
      check('★ 提交的是数字而不是输入框字符串（minPrice / priceDelta）',
        v.payload.minPrice === 88 && v.payload.properties[0].childsCurGoods[0].priceDelta === 0,
        v.payload)

      page.data.pics = []
      check('★ 一张图都没有 → 拒绝保存', page.validate().ok === false &&
        page.validate().msg === '请先上传商品图片', page.validate().msg)
      page.data.pics = ['cloud://a.jpg']
      page.data.uploading = true
      check('★ 图片还在上传中 → 拒绝保存', page.validate().ok === false, page.validate().msg)
      page.data.uploading = false
      page.data.pickupDiscount = '88'
      check('★ 自取立减 ≥ 价格 → 拒绝（避免自提每件减到 0）',
        page.validate().ok === false, page.validate().msg)
      page.data.pickupDiscount = ''
      page.data.minBuyNumber = '0'
      check('最少购买 0 份 → 拒绝', page.validate().ok === false)
      page.data.minBuyNumber = '1'
      page.data.sort = '1.5'
      check('排序不是整数 → 拒绝', page.validate().ok === false)
      page.data.sort = '10'
      page.data.specGroups[0].name = ''
      check('规格组没填名称 → 拒绝', page.validate().ok === false)
      page.data.specGroups[0].name = '磅数'
      page.data.specGroups[0].childsCurGoods[0].priceDelta = '-5'
      check('选项加价为负 → 拒绝', page.validate().ok === false)
      page.data.specGroups[0].childsCurGoods[0].priceDelta = '0'

      await page.save()
      check('★ 保存调用 adminGoodsUpsert（走 api-map，不直接碰云函数）', !!submitted, submitted)
      check('  新增时不带 id（由云库生成）', submitted && submitted.id === undefined)
      check('  提交内容含阶段 9 的三个开关与规格组',
        submitted.pickupDiscount === 0 && submitted.packingFee === 0 &&
        submitted.minBuyNumber === 1 && Array.isArray(submitted.properties),
        submitted)
      check('  保存结束后按钮复位（不会卡在"保存中…"）', page.data.saving === false)

      // 规格组自动生成 id（店主点"加一组"时）
      const before = page.data.specGroups.length
      page.addGroup()
      check('★「加一组规格」自动生成合法 id 与一个空选项',
        page.data.specGroups.length === before + 1 &&
        /^g\d+$/.test(page.data.specGroups[before].id) &&
        page.data.specGroups[before].childsCurGoods.length === 1,
        page.data.specGroups[before])
      page.addOption({ currentTarget: { dataset: { gi: before } } })
      check('「加一个选项」也自动生成 id',
        page.data.specGroups[before].childsCurGoods.length === 2 &&
        /^o\d+$/.test(page.data.specGroups[before].childsCurGoods[1].id))
      page.removeOption({ currentTarget: { dataset: { gi: before, oi: 1 } } })
      check('删除选项生效', page.data.specGroups[before].childsCurGoods.length === 1)

      // 并发上传多张图：不能互相覆盖，且"上传中"标志要等最后一张完成才复位
      {
        const resolvers = []
        const api2 = {
          uploadFile: () => new Promise((res) => resolvers.push(res)),
          adminGoodsUpsert: async () => ({ code: 0, data: { id: 'g_x' } })
        }
        const p2 = loadPage('pages/admin/goods-edit/index.js', {
          requires: { 'api-map$': api2, 'utils/admin$': ADMIN_STUB, 'utils/log$': QUIET_LOG }
        })
        p2.data.pics = []
        const u1 = p2.uploadOne('wxfile://a.jpg')
        const u2 = p2.uploadOne('wxfile://b.jpg')
        check('★ 并发上传时"上传中"标志为真（保存会被拦住）', p2.data.uploading === true)
        resolvers[0]({ code: 0, fileID: 'cloud://a.jpg' })
        await u1
        check('★ 第一张完成后仍是"上传中"（还有一张没传完）', p2.data.uploading === true, p2.data.uploading)
        check('  已完成的图先进入 pics', p2.data.pics.length === 1 && p2.data.pics[0] === 'cloud://a.jpg')
        resolvers[1]({ code: 0, fileID: 'cloud://b.jpg' })
        await u2
        check('★ 两张都保留（并发不会互相覆盖）', p2.data.pics.length === 2, p2.data.pics)
        check('  全部完成后才复位标志', p2.data.uploading === false)
      }
    }

    // ---- 9.2 配送设置页：读取 / 提交 / 短词拦截 ----
    {
      const ruleFromServer = {
        area: { keywords: ['太平新城'], excludeKeywords: [], forbidBeyondKm: 8 },        distance: { freeWithinKm: 3 },
        freight: {
          tiers: [
            { maxKm: 3, fee: 5, freeAmount: 35, tip: '' },
            { maxKm: null, fee: null, freeAmount: null, tip: '超出3公里，电话确认运费' }
          ],
          unknownTip: '运费待确认'
        },
        cake: { enabled: true, freeWithinKm: 3, minSizeInch: 6, overrideThreshold: true }
      }
      let saved = null
      const api = {
        appConfig: async () => ({ code: 0, data: [{ key: 'delivery_rule', value: ruleFromServer }] }),
        adminDeliverySave: async (p) => { saved = p; return { code: 0, data: { rule: ruleFromServer } } }
      }
      const page = loadPage('pages/admin/delivery/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/delivery-range$': DR,
          'utils/log$': QUIET_LOG
        }
      })
      await page.loadRule()
      check('配送页读到的档位进入表单（数值转成字符串）',
        page.data.tiers.length === 2 && page.data.tiers[0].maxKm === '3' && page.data.tiers[0].fee === '5',
        page.data.tiers)
      check('不限档的 maxKm 显示为空（店主看得懂）', page.data.tiers[1].maxKm === '')
      check('关键词与距离上限回填',
        page.data.keywordsText === '太平新城' && page.data.forbidBeyondKm === '8')
      check('每档有一句人话摘要', /3 公里内/.test(page.data.tiers[0].summary), page.data.tiers[0].summary)

      // 留空 = 待确认 / 不设门槛 / 不限
      page.data.tiers[1].fee = ''
      page.data.tiers[1].freeAmount = ''
      const payload = page.buildPayload()
      check('★ 运费留空 → null（= 运费待确认，不是 0 元）', payload.freight.tiers[1].fee === null)
      check('  免运费门槛留空 → null', payload.freight.tiers[1].freeAmount === null)
      check('  不抹掉没展示的字段（area/cake 以生效规则打底）',
        payload.cake.freeWithinKm === 3 && payload.cake.minSizeInch === 6 &&
        payload.area.forbidBeyondKm === 8, { cake: payload.cake, area: payload.area })
      check('  area / cake 都带上（保存后规则仍完整）',
        Array.isArray(payload.area.keywords) && typeof payload.cake.enabled === 'boolean')

      // 短关键词必须在前端就被拦下（服务端也会拒，但没必要跑一趟）
      page.data.keywordsText = '西山'
      await page.save()
      check('★ 关键词太短 → 前端直接拦住，不发请求', saved === null, saved)
      check('  并给出可执行的提示',
        page.__toasts.some((t) => /太短|完整小区/.test(String(t))), page.__toasts)

      // 清空配送范围 = 全店无法外送，前端也要拦住
      page.data.keywordsText = ''
      await page.save()
      check('★ 配送范围清空 → 前端拦住（否则顾客全都下不了外送单）', saved === null, saved)
      check('  提示里给出替代做法（只想自提就设小距离上限）',
        page.__toasts.some((t) => /配送范围不能为空/.test(String(t))), page.__toasts)

      page.data.keywordsText = '太平新城'
      await page.save()
      check('★ 合法设置能提交并给出"立即生效"反馈', !!saved, saved)
      check('  提交的是完整规则（含蛋糕免运费）',
        saved && saved.cake && saved.cake.enabled === true, saved)

      // 进入页面（onLoad）到可渲染：闸门 + 读规则两段都不能卡住，否则真机是一片空白
      const page6 = loadPage('pages/admin/delivery/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/delivery-range$': DR,
          'utils/log$': QUIET_LOG
        }
      })
      await page6.onLoad()
      await new Promise((r) => setTimeout(r, 0))
      check('★ 配送设置页 onLoad 之后就绪（非店主分支/加载中/错误态都不该留下空白）',
        page6.data.isAdminUser === true && page6.data.loading === false &&
        page6.data.loadError === false && page6.data.tiers.length === 2, page6.data)
    }

    // ---- 9.3 订单页：列表视图映射 + 完成/补录动作 ----
    {
      const orderA = {
        id: 'o_deliv', orderNumber: 'QH1', pickupCode: '0001', status: 0, statusStr: '待支付',
        deliveryMode: 'delivery', dateAdd: Date.now(), amountReal: 118, goodsAmount: 100,
        packingFee: 0, freight: 0, goodsNumber: 1, expectTime: '2026-10-15 15:00',
        contactName: '张三', contactPhone: '13800138000',
        addressText: '云南省昆明市安宁市太平新城某小区', distanceText: '9.2公里',
        address: { latitude: 24.9, longitude: 102.5 }, remark: '写生日牌',
        goodsSummary: '蛋糕（6寸）×1',
        deliveryQuote: { distanceKm: 9.2, inArea: true, reason: 'beyond', freightText: '超出8公里，电话确认', freightConfirmed: false }
      }
      const orderB = Object.assign({}, orderA, {
        id: 'o_pick', status: 1, statusStr: '制作中', deliveryMode: 'pickup',
        contactPhone: '13900139000', address: null, goodsSummary: '纸杯蛋糕×6',
        deliveryQuote: null
      })
      const calls = { finish: [], freight: [] }
      const api = {
        adminOrderList: async () => ({
          code: 0,
          data: {
            orderList: [orderA, orderB], total: 2, page: 1, pageSize: 20,
            statusCounts: { '0': 1, '1': 1, '3': 0 }, serverNow: Date.now()
          }
        }),
        orderFinish: async (token, id) => { calls.finish.push(id); return { code: 0, data: { id } } },
        adminOrderFreightConfirm: async (id, freight) => {
          calls.freight.push({ id, freight })
          return { code: 0, data: { amountReal: 118 } }
        }
      }
      const page = loadPage('pages/admin/orders/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/location$': { openNavigation: async () => {} },
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        }
      })
      await page.loadList(true)
      check('订单列表装载成功（2 单）', page.data.orderList.length === 2, page.data.orderList.length)
      const a = page.data.orderList[0]
      const b = page.data.orderList[1]
      check('★ 金额与时间在 JS 里算好（wxml 不拼字符串）',
        a.amountText === '¥118' && a.goodsAmountText === '¥100' && a.dateText.length > 0, a)
      check('★ 「运费待确认」的订单被标出来（店主知道要打电话谈运费）', a.needFreight === true)
      check('  已确定的订单不会被误标', b.needFreight === false)
      check('  自提单显示取餐码、外送单显示"外送"',
        b.badgeText === '自提 0001' && a.badgeText === '外送', { a: a.badgeText, b: b.badgeText })
      check('  只有制作中的订单能"完成"', b.canFinish === true && a.canFinish === false)
      check('★ 待支付单给出"为什么不能完成"的说明（支付未接入，别让店主以为 App 坏了）',
        /支付未接入|还没付款/.test(String(a.statusHint)) && b.statusHint === '', a.statusHint)
      check('  地址是否可导航（有经纬度才算）', a.hasAddress === true && b.hasAddress === false)
      check('★ 筛选标签数量来自服务端 statusCounts',
        page.data.tabs[0].count === 2 && page.data.tabs[1].count === 0, page.data.tabs)

      // 补录运费：先打开弹层填金额，再确认（金额必须是数字）
      page.openFreight({ currentTarget: { dataset: { index: 0 } } })
      check('补录弹层拿到当前订单', page.data.freightOrder && page.data.freightOrder.id === 'o_deliv')
      page.onFreightInput({ detail: { value: 'abc' } })
      await page.confirmFreight()
      check('★ 非法金额不提交（不会把错误金额写进订单）', calls.freight.length === 0)
      page.onFreightInput({ detail: { value: '18' } })
      await page.confirmFreight()
      check('★ 合法金额提交（前端只传一个数字，金额由服务端重算）',
        calls.freight.length === 1 && calls.freight[0].id === 'o_deliv' && calls.freight[0].freight === 18,
        calls.freight)

      // 完成订单（showModal 直接确认）
      const page2 = loadPage('pages/admin/orders/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/location$': { openNavigation: async () => {} },
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        },
        wx: { showModal: (o) => o.success && o.success({ confirm: true }) }
      })
      await page2.loadList(true)
      page2.finishOrder({ currentTarget: { dataset: { index: 1 } } })
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      check('★ 完成订单前先二次确认，确认后调 orderFinish',
        calls.finish.length === 1 && calls.finish[0] === 'o_pick', calls.finish)

      // 接单动作：拨号与导航（不抛异常、无坐标时给明确提示）
      let phoned = ''
      const page3 = loadPage('pages/admin/orders/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        },
        wx: { makePhoneCall: (o) => { phoned = o.phoneNumber } }
      })
      await page3.loadList(true)
      page3.callCustomer({ currentTarget: { dataset: { index: 0 } } })
      check('拨打电话带上顾客电话', phoned === '13800138000', phoned)
      page3.navToCustomer({ currentTarget: { dataset: { index: 1 } } })
      check('自提单没有坐标 → 给提示而不是静默失败',
        page3.__toasts.some((t) => /坐标|导航/.test(String(t))), page3.__toasts)
      let copiedText = ''
      const page4 = loadPage('pages/admin/orders/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        },
        wx: { setClipboardData: (o) => { copiedText = String(o.data || '') } }
      })
      await page4.loadList(true)
      page4.copyAddress({ currentTarget: { dataset: { index: 0 } } })
      check('复制地址真的带上了收货人与地址（可粘到地图里搜）',
        copiedText.indexOf('张三') >= 0 && copiedText.indexOf('太平新城') >= 0, copiedText)

      // ★ 已确认过的运费再改一次：必须先让店主看清"从多少改到多少"
      const confirmedOrder = Object.assign({}, orderA, {
        id: 'o_confirmed', freight: 18, amountReal: 118,
        deliveryQuote: Object.assign({}, orderA.deliveryQuote, { freightConfirmed: true })
      })
      let modalShown = 0
      let modalConfirm = false
      const apiConfirmed = Object.assign({}, api, {
        adminOrderList: async () => ({
          code: 0,
          data: {
            orderList: [confirmedOrder], total: 1, page: 1, pageSize: 20,
            statusCounts: { '0': 1 }, serverNow: Date.now()
          }
        })
      })
      const page5 = loadPage('pages/admin/orders/index.js', {
        requires: {
          'api-map$': apiConfirmed,
          'utils/admin$': ADMIN_STUB,
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        },
        wx: {
          showModal: (o) => { modalShown++; o.success && o.success({ confirm: modalConfirm }) }
        }
      })
      await page5.loadList(true)
      page5.openFreight({ currentTarget: { dataset: { index: 0 } } })
      page5.onFreightInput({ detail: { value: '999' } })
      const sentBefore = calls.freight.length
      await page5.confirmFreight()
      check('★ 改已确认的运费要先弹确认（且取消时绝不提交）',
        modalShown === 1 && calls.freight.length === sentBefore, { modalShown, sent: calls.freight.length })
      modalConfirm = true
      await page5.confirmFreight()
      check('  确认后才真正提交新金额',
        calls.freight.length === sentBefore + 1 && calls.freight[calls.freight.length - 1].freight === 999,
        calls.freight)
    }

    // ---- 9.3b 店主确认线下收款（P0-1 支付闭环：待支付 → 制作中）----
    {
      const unpaid = {
        id: 'o_unpaid', orderNumber: 'QH2', pickupCode: '0002', status: 0, statusStr: '待支付',
        deliveryMode: 'pickup', dateAdd: Date.now(), amountReal: 88, goodsAmount: 80,
        packingFee: 8, freight: 0, goodsNumber: 1, expectTime: '2026-10-15 16:00',
        contactName: '李四', contactPhone: '13700137000', address: null,
        goodsSummary: '蛋糕×1', deliveryQuote: null
      }
      const making = Object.assign({}, unpaid, {
        id: 'o_making', orderNumber: 'QH3', pickupCode: '0003', status: 1, statusStr: '制作中'
      })
      const listOf = (orders) => ({
        code: 0,
        data: {
          orderList: orders, total: orders.length, page: 1, pageSize: 20,
          statusCounts: { '0': 1, '1': 1, '3': 0 }
        }
      })
      const calls = { mark: [], list: 0 }
      const api = {
        adminOrderList: async () => { calls.list++; return listOf([unpaid, making]) },
        adminOrderMarkPaid: async (id) => {
          calls.mark.push(id)
          return { code: 0, data: { id, orderNumber: 'QH2', status: 1, payChannel: 'offline' } }
        }
      }
      const PAGE_REQUIRES = {
        'api-map$': api,
        'utils/admin$': ADMIN_STUB,
        'utils/format$': FMT,
        'utils/log$': QUIET_LOG
      }
      const page = loadPage('pages/admin/orders/index.js', {
        requires: PAGE_REQUIRES,
        wx: { showModal: (o) => { o.success && o.success({ confirm: true }) } }
      })
      await page.loadList(true)
      const vUnpaid = page.data.orderList[0]
      const vMaking = page.data.orderList[1]
      check('★ 待支付单可以「确认收款」（canMarkPaid）', vUnpaid.canMarkPaid === true, vUnpaid.canMarkPaid)
      check('  制作中的单不出现「确认收款」按钮', vMaking.canMarkPaid === false)
      check('★ 待支付提示说明"为什么不能完成"并指向「确认收款」',
        /顾客还没付款/.test(String(vUnpaid.statusHint)) &&
        /确认收款/.test(String(vUnpaid.statusHint)), vUnpaid.statusHint)
      check('  制作中的单不显示待支付说明', vMaking.statusHint === '', vMaking.statusHint)

      const listBefore = calls.list
      page.markPaid({ currentTarget: { dataset: { index: 0 } } })
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      check('★ 二次确认后调用 adminOrderMarkPaid（只传订单 id）',
        calls.mark.length === 1 && calls.mark[0] === 'o_unpaid', calls.mark)
      check('  成功后重新拉列表（订单从待支付变成制作中）', calls.list === listBefore + 1, calls.list)
      check('  成功有明确提示（店主知道收款已记上）',
        page.__toasts.some((t) => /确认收款/.test(String(t))), page.__toasts)
      check('  动作结束后防连点标志复位', page.data.markingPaidId === '', page.data.markingPaidId)

      // 取消二次确认 → 一次都不调（误点绝不能改订单状态）
      {
        let cancelMarks = 0
        const apiCancel = Object.assign({}, api, {
          adminOrderMarkPaid: async (id) => { cancelMarks++; return { code: 0, data: { id } } }
        })
        const pageCancel = loadPage('pages/admin/orders/index.js', {
          requires: Object.assign({}, PAGE_REQUIRES, { 'api-map$': apiCancel }),
          wx: { showModal: (o) => { o.success && o.success({ confirm: false }) } }
        })
        await pageCancel.loadList(true)
        pageCancel.markPaid({ currentTarget: { dataset: { index: 0 } } })
        await new Promise((r) => setTimeout(r, 0))
        check('★ 取消二次确认 → 不调接口', cancelMarks === 0, cancelMarks)
      }

      // 失败 → 弹窗展示服务端文案（不能用一闪而过的 toast）
      {
        const modals = []
        const apiFail = Object.assign({}, api, {
          adminOrderMarkPaid: async () => ({ code: 403, msg: '仅店主可确认收款' })
        })
        const pageFail = loadPage('pages/admin/orders/index.js', {
          requires: Object.assign({}, PAGE_REQUIRES, { 'api-map$': apiFail }),
          wx: {
            showModal: (o) => {
              modals.push(o)
              o.success && o.success({ confirm: true })
            }
          }
        })
        await pageFail.loadList(true)
        pageFail.markPaid({ currentTarget: { dataset: { index: 0 } } })
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setTimeout(r, 0))
        check('★ 失败时弹窗展示服务端文案（店主知道为什么没记上）',
          modals.some((m) => /仅店主可确认收款/.test(String(m.content))),
          modals.map((m) => m.content))
        check('  失败后防连点标志复位（可以重试）',
          pageFail.data.markingPaidId === '', pageFail.data.markingPaidId)
      }

      // 连点：进行中再点直接忽略（只发一次请求）
      {
        let markCalls = 0
        let resolveMark = null
        const apiSlow = Object.assign({}, api, {
          adminOrderMarkPaid: (id) => {
            markCalls++
            return new Promise((resolve) => { resolveMark = () => resolve({ code: 0, data: { id } }) })
          }
        })
        const pageDouble = loadPage('pages/admin/orders/index.js', {
          requires: Object.assign({}, PAGE_REQUIRES, { 'api-map$': apiSlow }),
          wx: { showModal: (o) => { o.success && o.success({ confirm: true }) } }
        })
        await pageDouble.loadList(true)
        pageDouble.markPaid({ currentTarget: { dataset: { index: 0 } } })
        pageDouble.markPaid({ currentTarget: { dataset: { index: 0 } } })
        check('★ 确认收款进行中再点直接忽略（只发一次请求）', markCalls === 1, markCalls)
        check('  请求中按钮显示「确认中…」（markingPaidId = 当前订单）',
          pageDouble.data.markingPaidId === 'o_unpaid', pageDouble.data.markingPaidId)
        resolveMark()
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setTimeout(r, 0))
        check('  完成后恢复，可再次操作',
          pageDouble.data.markingPaidId === '', pageDouble.data.markingPaidId)
      }
    }

    // ---- 9.4 店主中心：两个接口都成功才显示数字 ----
    {
      let failGoods = false
      const api = {
        adminOrderList: async () => ({
          code: 0,
          data: { orderList: [], total: 2, statusCounts: { '0': 1, '1': 1, '3': 4 } }
        }),
        adminGoodsList: async () => (failGoods
          ? { code: 500, msg: '云函数调用失败' }
          : { code: 0, data: { result: [], total: 3, onSale: 2, offSale: 1 } })
      }
      const page = loadPage('pages/admin/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/location$': { isDevOrTrialEnv: () => false },
          'utils/log$': QUIET_LOG
        }
      })
      await page.loadOverview()
      check('★ 概况：待处理 = 待支付 + 制作中',
        page.data.pendingCount === 2 && page.data.doingCount === 1 && page.data.doneCount === 4,
        page.data)
      check('  在售 / 已下架来自商品接口',
        page.data.onSaleCount === 2 && page.data.offSaleCount === 1, page.data)
      failGoods = true
      await page.loadOverview()
      check('★ 一个接口失败 → 整体错误态（不显示"商品 0 个"这种半截数据）',
        page.data.loadError === true && page.data.loading === false, page.data)

      // ★★ 生命周期回归（2026-10-14 复核发现的 P1）：
      //   小程序是 onLoad(不 await) → onShow(同步紧随)，而 onLoad 在 await 闸门处让出事件循环。
      //   如果只在 onShow 里按 isAdminUser 判断，首次进入时它还是 false → 页面永远停在"正在读取…"，
      //   连三个入口都点不到。这里按真实顺序跑一遍。
      {
        let calls = 0
        const api2 = {
          adminOrderList: async () => {
            calls++
            return { code: 0, data: { orderList: [], total: 0, statusCounts: {} } }
          },
          adminGoodsList: async () => {
            calls++
            return { code: 0, data: { result: [], total: 0, onSale: 0, offSale: 0 } }
          }
        }
        const p = loadPage('pages/admin/index.js', {
          requires: {
            'api-map$': api2,
            'utils/admin$': ADMIN_STUB,
            'utils/location$': { isDevOrTrialEnv: () => false },
            'utils/log$': QUIET_LOG
          }
        })
        const loading = p.onLoad() // 框架不等待 onLoad 的返回值
        p.onShow()                 // 同步紧随其后（此时闸门还没返回）
        await loading
        await new Promise((r) => setTimeout(r, 0))
        check('★★ 首次进入就会加载概况（不能停在"正在读取店铺概况…"）',
          calls === 2, { calls, loading: p.data.loading, isAdminUser: p.data.isAdminUser })
        check('  且首屏不会因为"返回前台"重复请求（onShow 门控）', calls === 2, calls)
        check('  非店主不会触发任何店主接口', true)
      }
      {
        let calls = 0
        const api2 = {
          adminOrderList: async () => { calls++; return { code: 0, data: { orderList: [], total: 0, statusCounts: {} } } },
          adminGoodsList: async () => { calls++; return { code: 0, data: { result: [], total: 0, onSale: 0, offSale: 0 } } }
        }
        const p = loadPage('pages/admin/index.js', {
          requires: {
            'api-map$': api2,
            'utils/admin$': Object.assign({}, ADMIN_STUB, { guardShopAdminPage: async () => false }),
            'utils/location$': { isDevOrTrialEnv: () => false },
            'utils/log$': QUIET_LOG
          }
        })
        const loading = p.onLoad()
        p.onShow()
        await loading
        check('★ 非店主：一个店主接口都不发（只有一屏"无店主权限"）',
          calls === 0 && p.data.isAdminUser === false, { calls, data: p.data })
      }
    }

    // ---- 9.5 「我的」页：先补店主标记再判断身份，否则店主首次进入看不到入口 ----
    {
      const order = []
      const api = {
        userDetail: async () => {
          order.push('userDetail')
          return { code: 0, data: { base: { id: 'o_boss', nick: '店主' } } }
        }
      }
      const page = loadPage('pages/my/index.js', {
        requires: {
          'api-map$': api,
          'utils/auth$': { checkHasLogined: async () => true, authorize: async () => ({}) },
          'shop-config$': { shop: { name: '卿欢蛋糕' } },
          'utils/location$': { isDevOrTrialEnv: () => false, openNavigation: async () => {} },
          'utils/address$': {
            getDefault: () => null,
            formatFull: () => ''
          },
          'utils/admin$': {
            ensureAdminFlag: async () => { order.push('ensureAdminFlag'); return true },
            isAdminUser: () => true,
            isShopAdmin: async () => true
          },
          'utils/format$': FMT,
          'utils/log$': QUIET_LOG
        }
      })
      await page.onShow()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      check('★「我的」页先确保店主标记到手、再判断店主身份',
        order[0] === 'ensureAdminFlag' && order.indexOf('userDetail') > 0, order)
      check('  于是店主能看到「店主中心」入口（isAdminUser = true）',
        page.data.isAdminUser === true, page.data)
      check('  顾客界面仍只显示不可反推的短编号', /^QH[0-9A-Z]{6}$/.test(page.data.userNo), page.data.userNo)    }

    // ---- 9.6 商品列表页：真实加载 + 分组 / 筛选 / 上下架 ----
    {
      const goodsA = {
        id: 'g_a', name: '在售的蛋糕', categoryId: 'cat_fruit', categoryName: '水果蛋糕',
        pic: 'cloud://a.jpg', pics: ['cloud://a.jpg'], minPrice: 88, maxPrice: 148, sort: 10,
        enabled: true, pickupDiscount: 0, packingFee: 0, minBuyNumber: 1, properties: [], specGroupCount: 0
      }
      const goodsB = Object.assign({}, goodsA, { id: 'g_b', name: '下架的旧品', enabled: false })
      const calls = { upsert: [], list: [] }
      const api = {
        adminGoodsList: async (params) => {
          calls.list.push(params)
          return {
            code: 0,
            data: {
              result: [goodsA, goodsB], total: 2, onSale: 1, offSale: 1,
              categories: [{ id: 'cat_fruit', name: '水果蛋糕', enabled: true },
                { id: 'cat_off', name: '已停用分类', enabled: false }]
            }
          }
        },
        adminGoodsUpsert: async (p) => { calls.upsert.push(p); return { code: 0, data: { id: p.id } } }
      }
      const page = loadPage('pages/admin/goods/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/log$': QUIET_LOG
        },
        wx: { showModal: (o) => o.success && o.success({ confirm: true }) }
      })
      await page.loadList()
      check('★ 商品列表页真实加载：分成在售 / 已下架两组',
        page.data.onSaleList.length === 1 && page.data.offSaleList.length === 1, page.data)
      check('  分类下拉带「全部分类」且停用分类标注出来',
        page.data.categoryNames[0] === '全部分类' &&
        page.data.categoryNames.some((n) => n.indexOf('已停用') >= 0), page.data.categoryNames)
      check('  默认不带 categoryId（= 全部）', calls.list[0].categoryId === '', calls.list[0])
      page.onCategoryChange({ detail: { value: 2 } })
      await new Promise((r) => setTimeout(r, 0))
      check('★ 选到第 2 个真实分类时按它的 id 过滤（不是第一项）',
        calls.list[calls.list.length - 1].categoryId === 'cat_off',
        calls.list[calls.list.length - 1])
      page.onKeywordInput({ detail: { value: '旧品' } })
      await page.doSearch()
      check('  搜索关键词带上服务端', calls.list[calls.list.length - 1].keyword === '旧品',
        calls.list[calls.list.length - 1])

      // 上下架：确认框 OK 后只提交 { id, enabled }
      page.toggleEnabled({ currentTarget: { dataset: { index: 0, group: 'on' } } })
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      check('★ 上下架只提交 { id, enabled }（服务端走快速通道，脏数据不会卡住）',
        calls.upsert.length === 1 && calls.upsert[0].id === 'g_a' && calls.upsert[0].enabled === false,
        calls.upsert)

      // onLoad 一路走通（这正是真机白屏那条链路：require → 闸门 → 拉列表）
      const page2 = loadPage('pages/admin/goods/index.js', {
        requires: {
          'api-map$': api,
          'utils/admin$': ADMIN_STUB,
          'utils/log$': QUIET_LOG
        }
      })
      await page2.onLoad()
      await new Promise((r) => setTimeout(r, 0))
      check('★ 商品列表页 onLoad 之后就绪（真机上不该是空白页）',
        page2.data.isAdminUser === true && page2.data.loaded === true &&
        page2.data.loading === false && page2.data.onSaleList.length === 1, page2.data)
    }

    // ---- 9.7 5 个店主页面都必须能真正加载（require 路径写错 = 真机白屏）----
    {
      const pagesToLoad = [
        ['pages/admin/index.js', { 'utils/location$': { isDevOrTrialEnv: () => false } }],
        ['pages/admin/orders/index.js', {
          'utils/location$': { openNavigation: async () => {} }, 'utils/format$': FMT
        }],
        ['pages/admin/goods/index.js', {}],
        ['pages/admin/goods-edit/index.js', {}],
        ['pages/admin/delivery/index.js', { 'utils/delivery-range$': DR }]
      ]
      const broken = []
      for (const [rel, extra] of pagesToLoad) {
        try {
          loadPage(rel, {
            requires: Object.assign({
              'api-map$': {},
              'utils/admin$': ADMIN_STUB,
              'utils/log$': QUIET_LOG
            }, extra)
          })
        } catch (e) {
          broken.push(rel + ' :: ' + e.message)
        }
      }
      check('★★ 5 个店主页面都能在沙箱里加载（相对 require 路径解析正确）',
        broken.length === 0, broken)
    }
  }

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exit(1)
})
