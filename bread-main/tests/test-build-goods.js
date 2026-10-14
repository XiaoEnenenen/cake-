/**
 * 商品录入工具回归测试（2026-10-14 阶段 9 第 1 步新增）
 * ---------------------------------------------------------------------------
 * 被测对象：cloud-data/tools/build-goods.js（源文件 → 云端商品记录）
 *
 * 覆盖三件事：
 *   1) **生成物与源文件同步**：磁盘上的 goods-real.jsonl 必须等于"用当前源文件重新生成"
 *      的结果 —— 改了 goods-real.source.json 忘记跑脚本，这里就会红
 *      （导入旧数据这种坑，在"价格/规格"上表现为顾客看到过期价格）；
 *   2) **specGroups（任意多组加价型规格）**：夹心一/夹心二/奶油类型… 的组 id、选项 id、
 *      加价累加，以及跟 sizes/flavors 混用时的顺序与唯一性；
 *   3) **与真实服务端逻辑的契约**：生成的 properties 直接喂给
 *      cloudfunctions/api/handlers.js 的 resolveOrderSku / calcPrice，
 *      验证"每组必选""伪造规格组被拒""加价累加"都对得上。
 *
 * 做法：build-goods.js 已把"逐条构建"抽成纯函数 buildRecords() 并导出（不读盘、不写文件），
 *      测试直接调用它，错误/警告用注入的收集器捕获。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const TOOL = require('../cloud-data/tools/build-goods')
const { resolveOrderSku, calcPrice } = require('../cloudfunctions/api/handlers')

const ROOT = path.join(__dirname, '..')
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

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

// ---- 真实分类映射（与工具在同一份 categories.jsonl 上工作）----
const cats = src('cloud-data/categories.jsonl').trim().split(/\r?\n/).map((l) => JSON.parse(l))
const catByName = {}
const catById = {}
cats.forEach((c) => {
  catByName[c.name] = c._id
  catById[c._id] = c.name
})

/** 跑一遍 buildRecords，返回记录 + 错误 + 警告 */
function build(list, imageBase) {
  const errors = []
  const warnings = []
  const res = TOOL.buildRecords(list, {
    catByName,
    catById,
    imageBase: imageBase || '',
    err: (m) => errors.push(m),
    warn: (m) => warnings.push(m)
  })
  return { records: res.records, errors, warnings }
}

// 一个最小的合法商品（绝对价规格 → 决定 minPrice）
const BASE_GOODS = {
  name: '测试蛋糕',
  category: '水果蛋糕',
  sizes: [{ name: '6寸', price: 100 }, { name: '8寸', price: 160 }]
}

// ===========================================================================
console.log('=== 1) 生成物与源文件必须同步 ===')
// ===========================================================================
{
  const raw = JSON.parse(src('cloud-data/goods-real.source.json'))
  const r = build(raw.goods, raw.imageBase)
  check('现有源文件的 5 个商品全部通过校验', r.errors.length === 0, r.errors)
  check('生成 5 条记录', r.records.length === 5, r.records.length)

  const onDisk = src('cloud-data/goods-real.jsonl')
  const regenerated = r.records.map((x) => JSON.stringify(x)).join('\n') + '\n'
  check('★ 磁盘上的 goods-real.jsonl == 用当前源文件重新生成的结果（改了源文件忘跑脚本会红）',
    onDisk === regenerated)
  check('  goods-real.json（控制台导入用）与 .jsonl 同内容',
    src('cloud-data/goods-real.json') === onDisk)

  // 现有线上商品确实还没有夹心/奶油这些组（阶段 9 第 2 步要补的数据）
  const groupCounts = r.records.map((x) => x.properties.length)
  check('现有商品都只有 1 组规格（尺寸）—— 夹心/奶油数据待店主确认后补',
    groupCounts.every((n) => n === 1), groupCounts)
}

// ===========================================================================
console.log('\n=== 2) specGroups：任意多组加价型规格（夹心一 / 夹心二 / 奶油类型）===')
// ===========================================================================
let cakeGoods = null
{
  const g = Object.assign({}, BASE_GOODS, {
    specGroups: [
      { name: '夹心一', options: [{ name: '芒果' }, { name: '奥利奥', delta: 5 }] },
      { name: '奶油类型', options: [{ name: '动物奶油' }, { name: '老奶油', delta: 10 }] }
    ]
  })
  const r = build([g])
  check('校验通过', r.errors.length === 0, r.errors)
  cakeGoods = r.records[0]
  const p = cakeGoods.properties

  check('共 3 组规格（磅数 + 夹心一 + 奶油类型）', p.length === 3, p.map((x) => x.name))
  check('组顺序：尺寸在前，自定义组按书写顺序在后',
    p[0].id === 'size' && p[1].name === '夹心一' && p[2].name === '奶油类型',
    p.map((x) => x.id))
  check('★ 夹心一 → 组 id filling1（可读、稳定，不是随机串）', p[1].id === 'filling1', p[1].id)
  check('★ 奶油类型 → 组 id cream', p[2].id === 'cream', p[2].id)
  check('芒果 → 选项 id f_mango（与口味同一套命名）',
    p[1].childsCurGoods[0].id === 'f_mango', p[1].childsCurGoods[0].id)
  check('未写 delta 的选项加价为 0', p[1].childsCurGoods[0].priceDelta === 0)
  check('奥利奥 +5 → priceDelta 5', p[1].childsCurGoods[1].priceDelta === 5)
  check('★ minPrice 仍由 sizes 决定（100，加价型组不影响基础价）',
    cakeGoods.minPrice === 100, cakeGoods.minPrice)
  check('尺寸组仍是"绝对价 → 加价"（8寸 +60）', p[0].childsCurGoods[1].priceDelta === 60)
  check('isCake 仍为 true（有磅数规格）', cakeGoods.isCake === true)

  // 未命中词典的组名 → spec_<短哈希>，且稳定
  const g2 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '生日插件', options: [{ name: '皇冠', delta: 3 }] }]
  })])
  check('词典命中：生日插件 → decoration', g2.records[0].properties[1].id === 'decoration',
    g2.records[0].properties[1].id)
  const g3 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '自定义组甲', options: [{ name: '甲一' }] }]
  })])
  const gid3 = g3.records[0].properties[1].id
  check('未命中词典 → spec_<短哈希>', /^spec_[a-z0-9]+$/.test(gid3), gid3)
  const g4 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '自定义组甲', options: [{ name: '甲一' }] }]
  })])
  check('★ 同一个组名每次都得到同一个 id（购物车/订单快照不会错位）',
    g4.records[0].properties[1].id === gid3, { a: gid3, b: g4.records[0].properties[1].id })
}

// ===========================================================================
console.log('\n=== 3) 契约：生成的规格能被真实服务端逻辑消费 ===')
// ===========================================================================
{
  check('前置：拿到了带 3 组规格的商品', !!cakeGoods)

  const okSku = resolveOrderSku(cakeGoods, 'size:s6,filling1:f_mango,cream:f_freshcream')
  check('★ 服务端 resolveOrderSku 接受这 3 组规格', okSku.ok === true, okSku)

  const miss = resolveOrderSku(cakeGoods, 'size:s6,filling1:f_mango')
  check('★ 少选一组（夹心选了、奶油没选）→ 拒绝，且提示缺失的组名',
    miss.ok === false && String(miss.msg).indexOf('奶油类型') >= 0, miss)

  const noneSel = resolveOrderSku(cakeGoods, '')
  check('  完全没选规格 → 拒绝', noneSel.ok === false, noneSel)

  const fakeGroup = resolveOrderSku(cakeGoods, 'size:s6,filling1:f_mango,cream:f_freshcream,fake:x')
  check('  伪造规格组 → 拒绝', fakeGroup.ok === false, fakeGroup)

  const fakeOpt = resolveOrderSku(cakeGoods, 'size:s6,filling1:f_不存在,cream:f_freshcream')
  check('  组内伪造选项 → 拒绝', fakeOpt.ok === false, fakeOpt)

  check('  最低价组合 = 100（minPrice + 0 + 0）', calcPrice(cakeGoods, okSku.sku) === 100,
    calcPrice(cakeGoods, okSku.sku))

  const maxSku = resolveOrderSku(cakeGoods, 'size:s8,filling1:f_oreo,cream:f_oldcream')
  check('★ 加价累加：8寸(+60) + 奥利奥(+5) + 老奶油(+10) = 175',
    calcPrice(cakeGoods, maxSku.sku) === 175, calcPrice(cakeGoods, maxSku.sku))
}

// ===========================================================================
console.log('\n=== 4) 校验规则：写错了必须报错（而不是悄悄生成错价格）===')
// ===========================================================================
{
  // ① 磅数这类绝对价规格写进 specGroups → 必须报错（否则 minPrice 算不出来）
  const r1 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '磅数', options: [{ name: '10寸', delta: 20 }] }]
  })])
  check('★ 把「磅数」写进 specGroups → 报错并指向 sizes',
    r1.errors.length > 0 && r1.errors.join(' ').indexOf('sizes') >= 0, r1.errors)

  // ② 显式 id 想抢 'size' → 同样拦下
  const r2 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ id: 'size', name: '夹心一', options: [{ name: '芒果' }] }]
  })])
  check('  显式 id="size" 抢尺寸组 → 报错', r2.errors.length > 0, r2.errors)

  // ③ 组名重复（flavors 的「口味」与 specGroups 的「口味」）
  const r3 = build([Object.assign({}, BASE_GOODS, {
    flavors: [{ name: '巧克力', delta: 10 }],
    specGroups: [{ name: '口味', options: [{ name: '芒果' }] }]
  })])
  check('★ 组名重复（口味 vs 口味）→ 报错',
    r3.errors.some((e) => e.indexOf('重复') >= 0), r3.errors)

  // ④ options 为空 / 缺 name
  const r4 = build([Object.assign({}, BASE_GOODS, { specGroups: [{ name: '夹心一', options: [] }] })])
  check('  options 为空 → 报错', r4.errors.length > 0, r4.errors)
  const r5 = build([Object.assign({}, BASE_GOODS, { specGroups: [{ options: [{ name: '芒果' }] }] })])
  check('  组缺 name → 报错', r5.errors.length > 0, r5.errors)
  const r6 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '夹心一', options: [{ delta: 3 }] }]
  })])
  check('  选项缺 name → 报错', r6.errors.length > 0, r6.errors)

  // ⑤ delta 非数字 → 报错；负加价 → 只是警告
  const r7 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '夹心一', options: [{ name: '芒果', delta: 'abc' }] }]
  })])
  check('  delta 非数字 → 报错', r7.errors.length > 0, r7.errors)
  const r8 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '夹心一', options: [{ name: '芒果', delta: -5 }] }]
  })])
  check('  负加价 → 只警告不报错（允许促销场景）',
    r8.errors.length === 0 && r8.warnings.some((w) => w.indexOf('负加价') >= 0), { e: r8.errors, w: r8.warnings })

  // ⑥ specGroups 不是数组
  const r9 = build([Object.assign({}, BASE_GOODS, { specGroups: { name: '夹心一' } })])
  check('  specGroups 不是数组 → 报错', r9.errors.length > 0, r9.errors)

  // ⑦ 组内选项重名 → 报错（会撞 id）
  const r10 = build([Object.assign({}, BASE_GOODS, {
    specGroups: [{ name: '夹心一', options: [{ name: '芒果' }, { name: '芒果' }] }]
  })])
  check('  组内选项重名 → 报错', r10.errors.some((e) => e.indexOf('选项 id') >= 0), r10.errors)

  // ⑧ 允许：不同组里出现同名选项（购物车 key 用的是"组:选项"对）
  const r11 = build([Object.assign({}, BASE_GOODS, {
    flavors: [{ name: '芒果', delta: 0 }],
    specGroups: [{ name: '夹心一', options: [{ name: '芒果' }] }]
  })])
  check('不同组里同名选项（口味芒果 + 夹心芒果）→ 允许，两组 id 都是 f_mango',
    r11.errors.length === 0 &&
      r11.records[0].properties[1].childsCurGoods[0].id === 'f_mango' &&
      r11.records[0].properties[2].childsCurGoods[0].id === 'f_mango',
    { e: r11.errors })
}

// ===========================================================================
console.log('\n=== 5) id 稳定性：加组/加商品不会改动别人 ===')
// ===========================================================================
{
  const A = Object.assign({}, BASE_GOODS, { id: 'g_a' })
  const B = Object.assign({}, BASE_GOODS, { id: 'g_b', name: '另一个蛋糕' })
  const before = build([A, B]).records
  const A2 = Object.assign({}, A, {
    specGroups: [{ name: '夹心一', options: [{ name: '芒果' }, { name: '奥利奥', delta: 5 }] }]
  })
  const after = build([A2, B]).records

  check('★ 给商品 A 加规格组后，B 的记录一字未变',
    JSON.stringify(before[1]) === JSON.stringify(after[1]))
  check('  A 的 id / minPrice 也没变（只多了规格组）',
    before[0]._id === after[0]._id && before[0].minPrice === after[0].minPrice)
  check('  A 的尺寸组 id 仍然稳定（size / s6 / s8）',
    JSON.stringify(after[0].properties[0].childsCurGoods.map((o) => o.id)) === JSON.stringify(['s6', 's8']),
    after[0].properties[0].childsCurGoods.map((o) => o.id))

  // 工具导出的两个 id 生成器也要稳定
  check('groupId 稳定', TOOL.groupId('夹心一') === 'filling1' && TOOL.groupId('夹心一') === TOOL.groupId('夹心一'))
  check('optionId 稳定（同名字同结果）', TOOL.optionId('f', '芒果') === TOOL.optionId('f', '芒果'))
  check('  显式 id 优先于词典', TOOL.optionId('f', '芒果', 'my_id') === 'my_id')
  check('  名字带数字 → 前缀+数字（6寸 → s6）', TOOL.optionId('s', '6寸') === 's6')
}

console.log('\n' + '='.repeat(60))
console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
