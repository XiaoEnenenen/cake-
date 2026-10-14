/**
 * 点单页「分类切换」回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 背景（店主实测反馈）：
 *   「首次点进点单界面全部商品会显示，但切到别的标签再切回全部商品就显示不出来商品」
 *
 * 查到的根因是**两个缺陷叠加**（审计报告 5.4 只记了第一个）：
 *   ① pages/orders/index.js 的 onCategoryClick 在「全部商品」(data-id=0) 时
 *      直接 return，**从不重新拉取商品** → 列表里剩的还是上一个分类的结果。
 *   ② 上一个分类恰好没有商品时后端返回 result: []，而 wxml 的空状态写的是
 *      `wx:if="{{ !goodsList }}"` —— `![]` 是 false，于是既不渲染商品也不显示
 *      「暂无商品」，整块白屏。所以店主看到的是「空白」而不是「暂无商品」。
 *
 * 这一份测试同时守住后来补的两个洞：
 *   ③ 快速连点分类时旧请求后返回，会把列表覆盖成上一个分类的商品（竞态）
 *   ④ 切换分类后右侧列表必须滚回顶部，否则新分类沿用旧滚动位置，同样像空白
 *
 * 做法：把页面文件在受控沙箱里**真正执行**，用桩 API 驱动 onCategoryClick，
 *      断言真实行为；涉及 wxml/wxss 的部分用源码级断言（node 里跑不了模板）。
 *      （沙箱骨架与 tests/test-order-countdown.js 一致）
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const JS = 'pages/orders/index.js'
const WXML = 'pages/orders/index.wxml'
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

/**
 * 在沙箱里加载点单页，返回页面实例。
 * @param {object} api 桩 API（至少要能应答 goodsv2）
 */
function loadOrdersPage(api) {
  let pageObj = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Page: (o) => {
      pageObj = o
    },
    getApp: () => ({ configLoadOK() {}, tabbarChange() {}, globalData: {} }),
    require: (p) => {
      if (/api-map$/.test(p)) return api
      if (/auth$/.test(p)) return { checkHasLogined: async () => true, authorize: () => Promise.resolve() }
      if (/delivery$/.test(p)) {
        return {
          isDelivery: () => false,
          isDeliveryEnabled: () => false,
          setMode: () => 'pickup',
          DELIVERY: 'delivery',
          PICKUP: 'pickup'
        }
      }
      if (/shop-config$/.test(p)) return { shop: { id: 0 }, delivery: {} }
      return {}
    },
    wx: {
      showLoading() {},
      hideLoading() {},
      showToast() {},
      getStorageSync() {
        return ''
      },
      setStorageSync() {},
      navigateTo() {},
      reLaunch() {}
    }
  }
  vm.runInNewContext(src(JS), vm.createContext(sandbox), { filename: JS })
  if (!pageObj) throw new Error('Page() 没有被调用：' + JS)
  const inst = Object.create(pageObj)
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (o, cb) {
    Object.assign(this.data, o)
    if (cb) cb()
  }
  return inst
}

const ALL_GOODS = [
  { id: 'g1', name: '蛋仔派对卡通蛋糕', minPrice: 178 },
  { id: 'g2', name: '软萌星星人蛋糕', minPrice: 168 }
]
const CAT_A_GOODS = [{ id: 'g3', name: '某个分类的商品', minPrice: 99 }]

/** 桩：按 categoryId 返回不同结果，并记录每次请求的 categoryId */
function makeApi(opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    goodsCategoryV2: async () => ({ code: 0, data: [{ id: 'cat_a', name: '分类A' }] }),
    goodsv2: async (params) => {
      calls.push(params.categoryId)
      if (o.goods) return o.goods(params.categoryId)
      if (!params.categoryId) return { code: 0, data: { result: ALL_GOODS } }
      if (params.categoryId === 'cat_a') return { code: 0, data: { result: CAT_A_GOODS } }
      return { code: 0, data: { result: [] } }
    },
    __isCloudMode: () => true,
    shippingCarInfo: async () => ({ code: 0, data: { items: [], number: 0, price: 0 } })
  }
}

const click = (id) => ({ currentTarget: { dataset: { id: id } } })

async function main() {
  console.log('=== 0) 页面文件可编译 ===')
  let err = null
  try {
    new vm.Script(src(JS), { filename: JS })
  } catch (e) {
    err = e
  }
  check('可编译：' + JS, err === null, err && err.message)

  console.log('\n=== 1) 复现并修复：切走再切回「全部商品」 ===')
  {
    const api = makeApi()
    const page = loadOrdersPage(api)

    // 首次进入（onLoad 的行为）
    await page.getGoodsList()
    check('首次进入「全部商品」能拿到商品', page.data.goodsList === ALL_GOODS || page.data.goodsList.length === 2)
    check('首次请求 categoryId 是空串（= 全部商品）', api.calls[0] === '', api.calls[0])

    // 切到一个有商品的分类
    await page.onCategoryClick(click('cat_a'))
    check('切到分类A 拉到该分类商品', page.data.goodsList.length === 1 && page.data.goodsList[0].id === 'g3')
    check('cid 记为分类A', page.data.cid === 'cat_a')

    // ★ 核心回归：切回「全部商品」
    await page.onCategoryClick(click('0'))
    check('★ 点回「全部商品」会重新请求后端（缺陷 5.4 的根因）', api.calls[api.calls.length - 1] === '', api.calls)
    check(
      '★ 点回「全部商品」后列表恢复为全部商品（不再是上一个分类的结果）',
      page.data.goodsList.length === 2 && page.data.goodsList[0].id === 'g1',
      page.data.goodsList
    )
    check('cid 复位为空串（左侧高亮回到「全部商品」）', page.data.cid === '')
  }

  console.log('\n=== 2) 空分类：切到没有商品的分类，再切回全部商品 ===')
  {
    const api = makeApi()
    const page = loadOrdersPage(api)

    await page.onCategoryClick(click('cat_empty'))
    check('空分类返回空数组（不是 null）', Array.isArray(page.data.goodsList) && page.data.goodsList.length === 0)

    await page.onCategoryClick(click('0'))
    check('★ 从空分类切回「全部商品」能重新拉到商品', page.data.goodsList.length === 2, page.data.goodsList)
  }

  console.log('\n=== 3) 竞态：慢的旧请求后返回，不能覆盖新分类 ===')
  {
    let releaseSlow = null
    const api = makeApi({
      goods: (cid) => {
        if (cid === 'cat_slow') {
          return new Promise((resolve) => {
            releaseSlow = () => resolve({ code: 0, data: { result: [{ id: 'slow', name: '慢请求结果' }] } })
          })
        }
        return Promise.resolve({ code: 0, data: { result: ALL_GOODS } })
      }
    })
    const page = loadOrdersPage(api)

    const p1 = page.onCategoryClick(click('cat_slow')) // 先发，挂住不返回
    const p2 = page.onCategoryClick(click('0')) // 后发，立刻返回
    await p2
    check('后发的请求结果已生效', page.data.goodsList.length === 2)
    releaseSlow()
    await p1
    check('★ 慢的旧请求返回时被丢弃，不覆盖新分类结果', page.data.goodsList[0].id === 'g1', page.data.goodsList)
  }

  console.log('\n=== 4) 切换分类后列表滚回顶部 ===')
  {
    const api = makeApi()
    const page = loadOrdersPage(api)
    await page.getGoodsList()
    page.data.listScrollTarget = 'goods-list-top' // 模拟已经滚过
    await page.onCategoryClick(click('cat_a'))
    check('切换分类后 listScrollTarget 回到锚点（会触发滚动）', page.data.listScrollTarget === 'goods-list-top')
    const wxml = src(WXML)
    check('wxml 的列表绑定了 scroll-into-view', /scroll-into-view="\{\{\s*listScrollTarget\s*\}\}"/.test(wxml))
    check('wxml 存在顶部锚点 id="goods-list-top"', /id="goods-list-top"/.test(wxml))
  }

  console.log('\n=== 5) wxml 空状态与错误态（2026-10-14 审查：加载失败 ≠ 没有商品）===')
  {
    const wxml = src(WXML)
    const nodes = wxml.match(/<view[^>]*class="goods-empty"[^>]*>/g) || []
    check('空状态与错误态节点都存在', nodes.length >= 2, nodes)
    // 错误态节点：由 goodsLoadError 为真时显示
    const errNode = nodes.find((n) => /goodsLoadError/.test(n) && !/!\s*goodsLoadError/.test(n)) || ''
    // 空状态节点：带 `!goodsLoadError`（失败时不显示"暂无商品"）
    const emptyNode = nodes.find((n) => /!\s*goodsLoadError/.test(n)) || ''
    check('★ 错误态节点由 goodsLoadError 控制', /goodsLoadError/.test(errNode), errNode)
    check('  错误态带重试入口（bindtap=retryGoodsList）', /bindtap="retryGoodsList"/.test(wxml))
    check(
      '★ 空状态判断含 goodsList.length == 0（否则空数组时白屏）',
      /goodsList\.length\s*==\s*0/.test(emptyNode),
      emptyNode
    )
    check('空状态同时兼容 goodsList 为 null', /!\s*goodsList/.test(emptyNode), emptyNode)
    check('★ 空状态不会再在"加载失败"时误显示（否则顾客以为店里没货）',
      /!\s*goodsLoadError/.test(emptyNode), emptyNode)
  }

  console.log('\n=== 6) 源码级防御：不再有「全部商品提前 return」 ===')
  {
    const js = src(JS)
    check('不再用 e.target.dataset 取分类（target 可能是子节点）', !/e\.target\.dataset\.id/.test(js))
    const body = (js.match(/onCategoryClick\s*\(e\)\s*\{[\s\S]*?\n\s{2}\},/) || [''])[0]
    check('onCategoryClick 里一定调用 getGoodsList', /getGoodsList\(/.test(body), body.slice(0, 60))
    // 缺陷形态是「还没拉取就 return」（不论点哪个分类）。
    // 函数末尾把 promise 返回出去（return this.getGoodsList(cid)）是允许的，
    // 所以按行判断：调用 getGoodsList 那一行**之前**不允许出现 return。
    const lines = body.split('\n')
    const callLine = lines.findIndex((l) => l.indexOf('getGoodsList(') >= 0)
    const earlyReturns = lines.slice(0, callLine < 0 ? 0 : callLine).filter((l) => /\breturn\b/.test(l))
    check(
      'onCategoryClick 在拉取之前没有 return（缺陷 5.4 的形态）',
      callLine >= 0 && earlyReturns.length === 0,
      { callLine, earlyReturns }
    )
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过：' : '存在失败：') + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main()
